import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { NuvionAccountsStandin } from '../../../../test/nuvion/accounts-standin';
import { NuvionBookStandin } from '../../../../test/nuvion/book-standin';
import {
  NuvionStandin,
  type StandinRequest,
} from '../../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../../test/nuvion/outbound-guard';
import { WawuIdDouble } from '../../../../test/nuvion/wawu-id-double';
import {
  mintToken,
  PIN,
  QuietLogger,
  WRONG_PIN,
} from '../../../../test/transfers/harness';
import { AdminRole } from '../../../../generated/prisma/enums';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { nuvionWalletId } from '../../../nuvion/areas/accounts';
import { NuvionCardsHandler } from '../../../nuvion/handlers/cards.handler';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import { NuvionBookArea } from '../../../nuvion/areas/book';
import { PrismaNuvionBookStore } from '../../../nuvion/areas/book-store';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { MoneyModule } from '../../money.module';
import { AdminCardsController } from '../admin-cards.controller';
import { CardSettings } from '../card-config';
import { WalletCardPurge } from '../card-purge.service';
import { AdminCardsService } from '../admin-cards.service';
import type {
  CardDetailsView,
  CardListView,
  CardQuoteView,
  CardTransactionPage,
  CardView,
} from '../card-view.type';

/**
 * The WAWU card (WALLET-31, R-84) end to end on a real database: the real
 * MoneyModule, the real Nuvion adapter and client, Nuvion stood in over a
 * real socket with the card routes as the dev sandbox answered them on
 * 24 Oct 2026 (entity_id a query on reads, a body field on freeze, unfreeze
 * and delete; the fee taken at once; a deleted card 404 everywhere).
 */

jest.setTimeout(120_000);

const BASE = '/api/hub/money/cards';
const PAN = '4111111111119916';
const CVV = '731';
const FEE = 65_772;

/** JSON that survives a row's BigInt columns. */
const dump = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'bigint' ? x.toString() : x,
  );

type Envelope<T> = {
  statusCode: number;
  data: T | null;
  reason?: { code: string; message: string };
};

interface FakeCard {
  id: string;
  name: string;
  type: 'virtual' | 'disposable';
  status: 'active' | 'blocked';
  account: string;
  entity: string;
  deleted: boolean;
}

describe('WALLET-31: the WAWU card on Nuvion', () => {
  const standin = new NuvionStandin();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const wawuId = new WawuIdDouble();
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: AdminCardsService;
  let plan: PlanSettingsService;
  let settings: CardSettings;
  let purge: WalletCardPurge;
  let handler: NuvionCardsHandler;
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const cards = new Map<string, FakeCard>();
  let cardSeq = 0;
  /** `lose`: the next create makes the card and then the answer is lost. */
  let loseCreate = false;
  /** `refuseFee`: the next create is refused as Nuvion refuses a funding account that cannot pay its fee. */
  let refuseFee = false;

  interface Person {
    id: string;
    auth: string;
    entity: string;
    account: string;
    accountNumber: string;
  }

  const seen = (path: RegExp, method?: string): StandinRequest[] =>
    standin.seen.filter(
      (r) => path.test(r.path) && (method === undefined || r.method === method),
    );

  function fakeNuvionCards(): void {
    const scope = (r: StandinRequest, where: 'query' | 'body'): string =>
      String(
        where === 'query'
          ? (r.query.entity_id ?? '')
          : ((r.body as { entity_id?: string } | null)?.entity_id ?? ''),
      );
    const notFound = {
      status: 404,
      body: {
        status: 'error',
        message: "We couldn't find that card.",
        type: 'error_resource_not_found',
      },
    };
    const make = (type: 'virtual' | 'disposable') => (r: StandinRequest) => {
      const b = r.body as {
        account_id: string;
        entity_id: string;
        card_name: string;
        currency: string;
        cardholder: Record<string, string>;
      };
      if (refuseFee) {
        refuseFee = false;
        return {
          status: 400,
          body: {
            status: 'error',
            message:
              'Card creation requires at least 657.72 NGN to be available for the card creation fee',
            type: 'error_card_creation_fee_required',
          },
        };
      }
      cardSeq += 1;
      const c: FakeCard = {
        id: `01CARD${String(cardSeq).padStart(20, '0')}`,
        name: b.card_name,
        type,
        status: 'active',
        account: b.account_id,
        entity: b.entity_id,
        deleted: false,
      };
      cards.set(c.id, c);
      if (loseCreate) {
        loseCreate = false;
        return { status: 200, hangUp: true };
      }
      return {
        status: 201,
        body: {
          status: 'success',
          data: {
            id: c.id,
            status: 'active',
            name: c.name,
            number: PAN,
            expiration_month: '09',
            expiration_year: '28',
            cvv: CVV,
            created: Date.now(),
          },
        },
      };
    };
    standin.on('POST', '/virtual-cards', make('virtual'));
    standin.on('POST', '/disposable-cards', make('disposable'));
    standin.on('GET', '/cards', (r) => {
      const rows = [...cards.values()].filter(
        (c) =>
          !c.deleted &&
          c.entity === scope(r, 'query') &&
          (!r.query.account_id || c.account === r.query.account_id),
      );
      return {
        status: 200,
        body: {
          status: 'success',
          data: {
            cards: rows.map((c) => ({
              id: c.id,
              name: c.name,
              type: c.type,
              status: c.status,
              currency: 'USD',
              nuvion_account_name: 'Naira wallet',
              last4: null,
            })),
            pagination: {
              order: 'desc',
              has_next: false,
              limit: 100,
              has_previous: false,
              next_cursor: null,
              previous_cursor: null,
            },
          },
        },
      };
    });
    standin.on('GET', /^\/card-details\/[A-Za-z0-9]+$/, (r) => {
      const c = cards.get(r.path.split('/')[2]);
      if (!c || c.deleted || c.entity !== scope(r, 'query')) return notFound;
      return {
        status: 200,
        body: {
          status: 'success',
          data: {
            id: c.id,
            status: c.status,
            name: c.name,
            type: c.type,
            number: PAN,
            expiration_month: '09',
            expiration_year: '28',
            cvv: CVV,
            first_name: 'Ada',
            last_name: 'Tester',
            currency: 'USD',
            billing: {
              address_line_1: '390 NE 191ST ST STE 8972',
              address_line_2: '',
              city: 'MIAMI',
              state: 'FL',
              postal_code: '33179',
            },
          },
        },
      };
    });
    const change = (to: 'blocked' | 'active') => (r: StandinRequest) => {
      const c = cards.get(r.path.split('/')[2]);
      // entity_id in the BODY; a query is 404, as dev answered.
      if (!c || c.deleted || c.entity !== scope(r, 'body')) return notFound;
      c.status = to;
      return {
        status: 200,
        body: { status: 'success', data: { message: 'ok', status: to } },
      };
    };
    standin.on(
      'PATCH',
      /^\/card-details\/[A-Za-z0-9]+\/freeze$/,
      change('blocked'),
    );
    standin.on(
      'PATCH',
      /^\/card-details\/[A-Za-z0-9]+\/unfreeze$/,
      change('active'),
    );
    standin.on('DELETE', /^\/card-details\/[A-Za-z0-9]+$/, (r) => {
      const c = cards.get(r.path.split('/')[2]);
      if (!c || c.deleted || c.entity !== scope(r, 'body')) return notFound;
      c.deleted = true;
      return {
        status: 200,
        body: { status: 'success', data: { message: 'ok', status: 'blocked' } },
      };
    });
    standin.on('GET', /^\/card-transactions\/[A-Za-z0-9]+$/, (r) => {
      const c = cards.get(r.path.split('/')[2]);
      if (!c || c.deleted || c.entity !== scope(r, 'query')) return notFound;
      return {
        status: 200,
        body: {
          status: 'success',
          data: {
            payments: [
              {
                _id: '01TXN00000000000000000001',
                amount: 728,
                currency: 'USD',
                status: 'successful',
                narration: 'Payment to Acme Corp',
                payment_type: 'card-debit',
                recipient: {
                  name: 'Acme Corp',
                  address: { city: 'San Francisco', country: 'US' },
                },
                created: 1788190545125,
              },
            ],
            pagination: {
              order: 'desc',
              has_next: false,
              limit: 20,
              has_previous: false,
              next_cursor: null,
              previous_cursor: null,
            },
          },
        },
      };
    });
    standin.on('GET', /^\/entities\/[A-Za-z0-9]+$/, (r) => ({
      status: 200,
      body: {
        status: 'success',
        data: {
          entity: { id: r.path.split('/')[2], type: 'individual' },
          person: {
            first_name: 'Ada',
            last_name: 'Tester',
            email: 'ada.tester@example.test',
            phonenumber: '+2348012345678',
          },
        },
      },
    }));
  }

  async function person(kobo = 5_000_000): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    const accountNumber = `7${String(Date.now()).slice(-6)}${String(users.length).padStart(3, '0')}`;
    const account = book.openPerson(kobo, accountNumber);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: account.entity_id,
        walletId: nuvionWalletId(account.entity_id, account.id),
        accountNumber,
        accountName: 'Cards Tester',
        provider: 'nuvion',
      },
    });
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: id,
        entityId: account.entity_id,
        accountId: account.id,
        nuvionBan: account.nuvion_ban,
        accountNumber,
        status: 'approved',
        currency: 'NGN',
      },
    });
    await prisma.userProfile.create({
      data: {
        wawuUserId: id,
        accountType: 'user',
        handle: `w31-${id.slice(0, 8)}`,
      },
    });
    const auth = `Bearer ${mintToken(id)}`;
    const set = await request(app.getHttpServer())
      .post('/api/hub/money/pin')
      .set('Authorization', auth)
      .send({ pin: PIN, pinConfirmation: PIN });
    expect(set.status).toBe(201);
    return {
      id,
      auth,
      entity: account.entity_id,
      account: account.id,
      accountNumber,
    };
  }

  const http = () => request(app.getHttpServer());
  const asEnvelope = <T>(res: request.Response) => res.body as Envelope<T>;

  async function makeCard(
    p: Person,
    kind: 'virtual' | 'single_use' = 'virtual',
    key = randomUUID(),
  ): Promise<request.Response> {
    return http()
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send({ kind });
  }

  beforeAll(async () => {
    guard = guardOutbound();
    await wawuId.start();
    await standin.start();
    accounts.install();
    book.install();
    fakeNuvionCards();
    book.fundOperational(5_000_000);
    // A fee's book transfer is confirmed at once; asked again under its reference it answers with the original.
    book.mode = 'successful';
    book.duplicateAs = 'original';
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: 'http://127.0.0.1:1',
      FINTAVA_API_KEY: 'live_test_w31_cards_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'w31-cards-fee-quote-key-0123456789abcdef01',
      NUVION_FEE_BOOK_TRANSFER: '0',
      NUVION_FEE_BANK_PAYOUT: '2500',
      NUVION_FEE_INFLOW: '0',
      NUVION_FEE_CARD_CREATE: String(FEE),
      WALLET_CARD_MAX_ACTIVE: '3',
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const client = new NuvionClient(
      standin.settings({
        moneyTimeoutMs: 2_000,
        readTimeoutMs: 2_000,
        operationalAccountId: book.operational.id,
      }),
      'nv_test_sk_W31cardsKEY00000000000000000',
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useFactory({
        inject: [PrismaService],
        factory: (db: PrismaService) =>
          new NuvionWalletProvider(client, {
            ...nuvionAreas(client),
            // No wait inside the request (the book transfers are walked in nuvion-book.contract.spec.ts).
            book: new NuvionBookArea(
              client,
              client.settings,
              new PrismaNuvionBookStore(db),
              { settleStepsMs: [] },
            ),
          }),
      })
      .setLogger(logger)
      .compile();
    app = moduleRef.createNestApplication({ ...HUB_APP_OPTIONS, logger });
    app.useLogger(logger);
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    admin = moduleRef.get(AdminCardsService);
    plan = moduleRef.get(PlanSettingsService);
    settings = moduleRef.get(CardSettings);
    purge = moduleRef.get(WalletCardPurge);
    handler = new NuvionCardsHandler(prisma, {
      get: () => moduleRef.get<NuvionWalletProvider>(WALLET_PROVIDER),
    } as never);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { wawuUserId: { in: users } },
            { customerReference: { startsWith: 'wawu-card-' } },
          ],
        },
      });
      await prisma.nuvionBookTransfer.deleteMany({
        where: { reference: { startsWith: 'wawu-card-' } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.walletCard.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.adminOpsAudit.deleteMany({
        where: { subjectWawuId: { in: users } },
      });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.planSetting.deleteMany({ where: { key: 'cards.enabled' } });
    }
    if (app) await app.close();
    await standin.stop();
    await wawuId.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    guard.restore();
  });

  afterEach(() => {
    expect(guard.violations).toEqual([]);
  });

  // ---------------------------------------------------------------------

  it('quotes Nuvion fee plus WAWU fee (0), the limits, and whether a card can be asked for', async () => {
    const p = await person();
    const res = await http().get(`${BASE}/quote`).set('Authorization', p.auth);
    expect(res.status).toBe(200);
    const q = asEnvelope<CardQuoteView>(res).data!;
    expect(q).toMatchObject({
      enabled: true,
      currency: 'USD',
      kinds: ['virtual', 'single_use'],
      fee: { providerFeeKobo: FEE, wawuFeeKobo: 0, totalFeeKobo: FEE },
      limits: { maxActive: 3, activeNow: 0 },
      canCreate: true,
    });
  });

  it('makes a card behind the PIN and the Idempotency-Key, with no number, expiry or CVV in the answer or in the database', async () => {
    const p = await person();
    const noKey = await http()
      .post(BASE)
      .set('Authorization', p.auth)
      .set('X-Transaction-Pin', PIN)
      .send({ kind: 'virtual' });
    expect(noKey.status).toBe(400);
    expect(asEnvelope(noKey).reason?.code).toBe('idempotency_key_required');

    const noPin = await http()
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'virtual' });
    expect(noPin.status).toBe(403);
    expect(asEnvelope(noPin).reason?.code).toBe('pin_required');
    expect(await prisma.walletCard.count({ where: { wawuUserId: p.id } })).toBe(
      0,
    );

    const before = seen(/^\/virtual-cards$/, 'POST').length;
    const res = await makeCard(p);
    expect(res.status).toBe(201);
    const card = asEnvelope<CardView>(res).data!;
    expect(card).toMatchObject({
      kind: 'virtual',
      status: 'active',
      currency: 'USD',
      frozenBySupport: false,
    });
    const sent = seen(/^\/virtual-cards$/, 'POST').slice(before);
    expect(sent).toHaveLength(1);
    const body = sent[0].body as Record<string, unknown>;
    expect(body).toMatchObject({
      account_id: p.account,
      entity_id: p.entity,
      currency: 'USD',
      cardholder: {
        first_name: 'Ada',
        last_name: 'Tester',
        phone_number: '+2348012345678',
      },
    });
    const row = await prisma.walletCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    expect(body.card_name).toBe(row.reference);
    // Nothing of the card's secrets is in the answer, the row or the log.
    const everything = dump([res.body, row, logger.lines]);
    expect(everything).not.toContain(PAN);
    expect(everything).not.toContain(CVV);
    expect(everything).not.toContain(PAN.slice(-4));
  });

  it('answers the same Idempotency-Key and body again without a second card or a PIN check', async () => {
    const p = await person();
    const key = randomUUID();
    const first = await makeCard(p, 'virtual', key);
    expect(first.status).toBe(201);
    const before = seen(/^\/virtual-cards$/, 'POST').length;
    const again = await http()
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', WRONG_PIN)
      .send({ kind: 'virtual' });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(seen(/^\/virtual-cards$/, 'POST').length).toBe(before);
    const other = await makeCard(p, 'virtual', key).then(() =>
      http()
        .post(BASE)
        .set('Authorization', p.auth)
        .set('Idempotency-Key', key)
        .set('X-Transaction-Pin', PIN)
        .send({ kind: 'single_use' }),
    );
    expect(other.status).toBe(409);
    expect(asEnvelope(other).reason?.code).toBe('idempotency_key_reused');
  });

  it('makes a single-use card through the disposable route', async () => {
    const p = await person();
    const before = seen(/^\/disposable-cards$/, 'POST').length;
    const res = await makeCard(p, 'single_use');
    expect(res.status).toBe(201);
    expect(asEnvelope<CardView>(res).data).toMatchObject({
      kind: 'single_use',
    });
    expect(seen(/^\/disposable-cards$/, 'POST').length).toBe(before + 1);
  });

  it('shows the details only behind the PIN, fetched from Nuvion each time, never stored', async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p)).data!;
    const open = () =>
      http().post(`${BASE}/${card.id}/reveal`).set('Authorization', p.auth);
    const noPin = await open();
    expect(noPin.status).toBe(403);
    expect(asEnvelope(noPin).reason?.code).toBe('pin_required');
    const wrong = await open().set('X-Transaction-Pin', WRONG_PIN);
    expect(wrong.status).toBe(403);
    expect(asEnvelope(wrong).reason?.code).toBe('pin_incorrect');

    const before = seen(/^\/card-details\//, 'GET').length;
    for (let i = 0; i < 2; i += 1) {
      const ok = await open().set('X-Transaction-Pin', PIN);
      expect(ok.status).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(asEnvelope<CardDetailsView>(ok).data).toMatchObject({
        number: PAN,
        cvv: CVV,
        expiryMonth: '09',
        expiryYear: '28',
        cardholderName: 'Ada Tester',
      });
    }
    // Asked of Nuvion each time, with the entity as a query.
    const reads = seen(/^\/card-details\//, 'GET').slice(before);
    expect(reads).toHaveLength(2);
    expect(reads[0].query.entity_id).toBe(p.entity);
    const everything = dump([
      await prisma.walletCard.findMany({ where: { wawuUserId: p.id } }),
      logger.lines,
    ]);
    expect(everything).not.toContain(PAN);
    expect(everything).not.toContain(CVV);
  });

  it('freezes without a PIN, unfreezes only behind one, and Nuvion reads the entity from the body', async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p)).data!;
    const frozen = await http()
      .post(`${BASE}/${card.id}/freeze`)
      .set('Authorization', p.auth);
    expect(frozen.status).toBe(200);
    expect(asEnvelope<CardView>(frozen).data).toMatchObject({
      status: 'frozen',
    });
    const call = seen(/\/freeze$/, 'PATCH').at(-1)!;
    expect(call.body).toEqual({ entity_id: p.entity });
    expect(call.query.entity_id).toBeUndefined();
    // Safe to repeat.
    const again = await http()
      .post(`${BASE}/${card.id}/freeze`)
      .set('Authorization', p.auth);
    expect(again.status).toBe(200);

    const noPin = await http()
      .post(`${BASE}/${card.id}/unfreeze`)
      .set('Authorization', p.auth);
    expect(noPin.status).toBe(403);
    expect(asEnvelope(noPin).reason?.code).toBe('pin_required');
    const ok = await http()
      .post(`${BASE}/${card.id}/unfreeze`)
      .set('Authorization', p.auth)
      .set('X-Transaction-Pin', PIN);
    expect(ok.status).toBe(200);
    expect(asEnvelope<CardView>(ok).data).toMatchObject({ status: 'active' });
  });

  it('blocks a card for good: Nuvion deletes it, a second block is fine, and nothing else works on it', async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p)).data!;
    const res = await http()
      .delete(`${BASE}/${card.id}`)
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    expect(asEnvelope<CardView>(res).data).toMatchObject({ status: 'blocked' });
    const call = seen(/^\/card-details\//, 'DELETE').at(-1)!;
    expect(call.body).toEqual({ entity_id: p.entity });
    const again = await http()
      .delete(`${BASE}/${card.id}`)
      .set('Authorization', p.auth);
    expect(again.status).toBe(200);
    const reveal = await http()
      .post(`${BASE}/${card.id}/reveal`)
      .set('Authorization', p.auth)
      .set('X-Transaction-Pin', PIN);
    expect(reveal.status).toBe(409);
    expect(asEnvelope(reveal).reason?.code).toBe('card_blocked');
    const unfreeze = await http()
      .post(`${BASE}/${card.id}/unfreeze`)
      .set('Authorization', p.auth)
      .set('X-Transaction-Pin', PIN);
    expect(asEnvelope(unfreeze).reason?.code).toBe('card_blocked');
    const list = asEnvelope<CardListView>(
      await http().get(BASE).set('Authorization', p.auth),
    ).data!;
    expect(list.cards.map((c) => [c.id, c.status])).toEqual([
      [card.id, 'blocked'],
    ]);
  });

  it("lists the person's own cards and card payments; another person's id is 404", async () => {
    const p = await person();
    const other = await person();
    const card = asEnvelope<CardView>(await makeCard(p)).data!;
    const list = asEnvelope<CardListView>(
      await http().get(BASE).set('Authorization', p.auth),
    ).data!;
    expect(list.enabled).toBe(true);
    expect(list.cards.map((c) => c.id)).toEqual([card.id]);
    const txns = asEnvelope<CardTransactionPage>(
      await http()
        .get(`${BASE}/${card.id}/transactions`)
        .set('Authorization', p.auth),
    ).data!;
    expect(txns.items[0]).toMatchObject({
      kind: 'purchase',
      amountCents: 728,
      currency: 'USD',
      merchant: 'Acme Corp',
      place: 'San Francisco, US',
    });
    expect(txns.items[0].occurredAt).toBe(
      new Date(1788190545125).toISOString(),
    );
    for (const [method, path] of [
      ['get', `${BASE}/${card.id}`],
      ['get', `${BASE}/${card.id}/transactions`],
      ['post', `${BASE}/${card.id}/freeze`],
      ['delete', `${BASE}/${card.id}`],
    ] as const) {
      const res = await http()[method](path).set('Authorization', other.auth);
      expect(res.status).toBe(404);
    }
    const hers = asEnvelope<CardListView>(
      await http().get(BASE).set('Authorization', other.auth),
    ).data!;
    expect(hers.cards).toEqual([]);
  });

  it('refuses a card at the limit before the PIN is looked at', async () => {
    const p = await person();
    for (let i = 0; i < 3; i += 1) expect((await makeCard(p)).status).toBe(201);
    const res = await http()
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'virtual' });
    expect(res.status).toBe(409);
    expect(asEnvelope(res).reason?.code).toBe('card_limit_reached');
    const quote = asEnvelope<CardQuoteView>(
      await http().get(`${BASE}/quote`).set('Authorization', p.auth),
    ).data!;
    expect(quote).toMatchObject({ canCreate: false, limits: { activeNow: 3 } });
  });

  it("says plainly when Nuvion's fee cannot be paid: 402, nothing made, the same key tried again", async () => {
    const p = await person();
    const key = randomUUID();
    refuseFee = true;
    const res = await makeCard(p, 'virtual', key);
    expect(res.status).toBe(402);
    expect(asEnvelope(res).reason?.code).toBe('insufficient_funds');
    expect(asEnvelope(res).reason?.message).toContain('657.72');
    const rows = await prisma.walletCard.findMany({
      where: { wawuUserId: p.id },
    });
    expect(rows.map((r) => r.state)).toEqual(['failed']);
    // The key was given back: the same key works once the person has the money.
    const retry = await makeCard(p, 'virtual', key);
    expect(retry.status).toBe(201);
    expect(
      await prisma.walletCard.count({
        where: { wawuUserId: p.id, state: 'active' },
      }),
    ).toBe(1);
  });

  it('adopts a card whose answer was lost: found by its reference, never made twice', async () => {
    const p = await person();
    loseCreate = true;
    const res = await makeCard(p);
    expect(res.status).toBe(201);
    const card = asEnvelope<CardView>(res).data!;
    expect(card.status).toBe('active');
    expect(await prisma.walletCard.count({ where: { wawuUserId: p.id } })).toBe(
      1,
    );
    expect(
      [...cards.values()].filter((c) => c.entity === p.entity),
    ).toHaveLength(1);
  });

  it('is off when the plan setting is 0: nothing is made, the list says so, and a card held can still be blocked', async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p)).data!;
    await prisma.planSetting.upsert({
      where: { key: 'cards.enabled' },
      create: { key: 'cards.enabled', value: 0 },
      update: { value: 0 },
    });
    await plan.refresh();
    try {
      const res = await makeCard(p);
      expect(res.status).toBe(503);
      expect(asEnvelope(res).reason?.code).toBe('cards_unavailable');
      const list = asEnvelope<CardListView>(
        await http().get(BASE).set('Authorization', p.auth),
      ).data!;
      expect(list.enabled).toBe(false);
      // The card she holds is still listed, so she can still freeze or block it (round 1, L5).
      expect(list.cards.map((c) => c.id)).toEqual([card.id]);
      const block = await http()
        .delete(`${BASE}/${card.id}`)
        .set('Authorization', p.auth);
      expect(block.status).toBe(200);
    } finally {
      await prisma.planSetting.deleteMany({ where: { key: 'cards.enabled' } });
      await plan.refresh();
    }
  });

  it('support freezes a card (the person cannot undo it), unfreezes it and blocks one, each audited', async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p)).data!;
    const actor = {
      id: randomUUID(),
      email: 'finance@test.wawu.dev',
      role: AdminRole.finance,
    };
    const frozen = await admin.freeze(actor, card.id);
    expect(frozen).toMatchObject({ status: 'frozen', frozenBySupport: true });
    const unfreeze = await http()
      .post(`${BASE}/${card.id}/unfreeze`)
      .set('Authorization', p.auth)
      .set('X-Transaction-Pin', PIN);
    expect(unfreeze.status).toBe(409);
    expect(asEnvelope(unfreeze).reason?.code).toBe('card_blocked');
    const page = await admin.list({ wawuUserId: p.id, limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain(PAN);
    expect(await admin.unfreeze(actor, card.id)).toMatchObject({
      status: 'active',
    });
    expect(await admin.cancel(actor, card.id)).toMatchObject({
      status: 'blocked',
    });
    // A repeat is a no-op with no second audit row (round 1, L6).
    expect(await admin.cancel(actor, card.id)).toMatchObject({
      status: 'blocked',
    });
    const audits = await prisma.adminOpsAudit.findMany({
      where: { resource: 'wallet_card', resourceId: card.id },
      orderBy: { actedAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'wallet_card_frozen',
      'wallet_card_unfrozen',
      'wallet_card_cancelled',
    ]);
    expect(audits[0]).toMatchObject({
      subjectWawuId: p.id,
      actedByAdminId: actor.id,
      actedByAdminRole: 'finance',
    });
  });

  it('the admin routes are superadmin and finance only', () => {
    const proto = AdminCardsController.prototype as unknown as Record<
      string,
      object
    >;
    const roles = (name: string) =>
      Reflect.getMetadata('adminRoles', proto[name]) as unknown;
    for (const h of ['list', 'freeze', 'unfreeze', 'cancel'] as const) {
      const r = roles(h);
      expect(r).toBeDefined();
      expect([...(r as string[])].sort()).toEqual(['finance', 'superadmin']);
    }
  });

  it("follows Nuvion's events: a late frozen event cannot undo a newer unfreeze, a deletion blocks for good", async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p)).data!;
    const row = await prisma.walletCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    const event = (name: string, extra: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      eventId: randomUUID(),
      event: name,
      resourceId: row.providerCardId,
      entityId: p.entity,
      data: { id: row.providerCardId, name: row.reference, ...extra },
      receivedAt: new Date(),
      attempts: 1,
    });
    // Nuvion says active; a stale `cards.frozen` changes nothing.
    expect(await handler.handle(event('cards.frozen'))).toMatchObject({
      outcome: 'done',
    });
    expect(
      (await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }))
        .state,
    ).toBe('active');
    // Nuvion says blocked (support at Nuvion froze it): the row follows.
    cards.get(row.providerCardId!)!.status = 'blocked';
    await handler.handle(event('cards.frozen'));
    expect(
      (await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }))
        .state,
    ).toBe('frozen');
    await handler.handle(event('cards.deleted'));
    const done = await prisma.walletCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    expect(done.state).toBe('cancelled');
    // Twice is the same as once; a card that is not ours is left alone.
    expect(await handler.handle(event('cards.deleted'))).toMatchObject({
      outcome: 'done',
    });
    expect(
      await handler.handle({
        ...event('cards.frozen'),
        data: { id: '01NOTOURS0000000000000000A' },
      }),
    ).toMatchObject({ outcome: 'done' });
  });

  // -------------------------------------------------------------------------
  // Fix round 1
  // -------------------------------------------------------------------------

  describe('WAWU fee on a card (M1)', () => {
    const FEE_WAWU = 1_000;
    beforeEach(() => {
      (settings as { wawuFeeKobo: number }).wawuFeeKobo = FEE_WAWU;
    });
    afterEach(() => {
      (settings as { wawuFeeKobo: number }).wawuFeeKobo = 0;
    });

    it("collects WAWU's fee once the card exists, as a send's fee is: one transfer under <card>-fee into WAWU's account, its ledger side written, never twice", async () => {
      const p = await person();
      const operationalBefore = book.availableOf(book.operational.id);
      const quote = asEnvelope<CardQuoteView>(
        await http().get(`${BASE}/quote`).set('Authorization', p.auth),
      ).data!;
      expect(quote).toMatchObject({
        canCreate: true,
        fee: {
          providerFeeKobo: FEE,
          wawuFeeKobo: FEE_WAWU,
          totalFeeKobo: FEE + FEE_WAWU,
        },
      });
      const res = await makeCard(p);
      expect(res.status).toBe(201);
      const card = asEnvelope<CardView>(res).data!;
      expect(card.status).toBe('active');
      const row = await prisma.walletCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      expect(row.feeCollectedAt).not.toBeNull();
      expect(row.wawuFeeKobo).toBe(BigInt(FEE_WAWU));
      expect(book.availableOf(p.account)).toBe(5_000_000 - FEE_WAWU);
      expect(book.availableOf(book.operational.id)).toBe(
        operationalBefore + FEE_WAWU,
      );
      const ledger = await prisma.fintavaLedgerEntry.findMany({
        where: { customerReference: `${row.reference}-fee` },
      });
      expect(ledger).toHaveLength(1);
      expect(Number(ledger[0].amountKobo)).toBe(FEE_WAWU);
      expect(ledger[0].direction).toBe('in');
      // Owed again (the confirmation was lost): the next read asks the provider under the same reference, which answers with the original.
      await prisma.walletCard.update({
        where: { id: card.id },
        data: { feeCollectedAt: null },
      });
      await http().get(BASE).set('Authorization', p.auth).expect(200);
      expect(
        (await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }))
          .feeCollectedAt,
      ).not.toBeNull();
      expect(book.availableOf(p.account)).toBe(5_000_000 - FEE_WAWU);
      expect(
        await prisma.fintavaLedgerEntry.count({
          where: { customerReference: `${row.reference}-fee` },
        }),
      ).toBe(1);
    });

    it('a wallet that cannot cover both fees is refused before anything is claimed or sent: 402, no card, the key free', async () => {
      const p = await person(FEE + FEE_WAWU - 1);
      const key = randomUUID();
      const before = seen(/^\/virtual-cards$/, 'POST').length;
      const res = await makeCard(p, 'virtual', key);
      expect(res.status).toBe(402);
      expect(asEnvelope(res).reason?.code).toBe('insufficient_funds');
      expect(asEnvelope(res).reason?.message).toContain('667.72');
      expect(seen(/^\/virtual-cards$/, 'POST').length).toBe(before);
      expect(
        await prisma.walletCard.count({ where: { wawuUserId: p.id } }),
      ).toBe(0);
      expect(
        await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
      ).toBe(0);
    });
  });

  it('shows the details at most 5 times a minute, then its own 429, before the PIN is looked at', async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p)).data!;
    const open = () =>
      http()
        .post(`${BASE}/${card.id}/reveal`)
        .set('Authorization', p.auth)
        .set('X-Transaction-Pin', PIN);
    for (let i = 0; i < 5; i += 1) expect((await open()).status).toBe(200);
    const sixth = await open();
    expect(sixth.status).toBe(429);
    expect(asEnvelope(sixth).reason?.code).toBe('card_reveal_rate_limited');
    // Someone else's count is their own, and a person with no wallet is answered by the gate first.
    const other = await person();
    const otherCard = asEnvelope<CardView>(await makeCard(other)).data!;
    expect(
      (
        await http()
          .post(`${BASE}/${otherCard.id}/reveal`)
          .set('Authorization', other.auth)
          .set('X-Transaction-Pin', PIN)
      ).status,
    ).toBe(200);
  });

  it('a single-use card Nuvion blocked after its payment reads as used: nothing to freeze, unfreeze or show, and it no longer counts as held', async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p, 'single_use')).data!;
    const row = await prisma.walletCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    cards.get(row.providerCardId!)!.status = 'blocked';
    const result = await handler.handle({
      id: randomUUID(),
      eventId: randomUUID(),
      event: 'cards.frozen',
      resourceId: row.providerCardId,
      entityId: p.entity,
      data: { id: row.providerCardId, name: row.reference },
      receivedAt: new Date(),
      attempts: 1,
    });
    expect(result.outcome).toBe('done');
    const used = asEnvelope<CardView>(
      await http().get(`${BASE}/${card.id}`).set('Authorization', p.auth),
    ).data!;
    expect(used).toMatchObject({ status: 'used', frozenBySupport: false });
    for (const [method, path, pin] of [
      ['post', `${BASE}/${card.id}/freeze`, false],
      ['post', `${BASE}/${card.id}/unfreeze`, true],
      ['post', `${BASE}/${card.id}/reveal`, true],
    ] as const) {
      let req = http()[method](path).set('Authorization', p.auth);
      if (pin) req = req.set('X-Transaction-Pin', PIN);
      const res = await req;
      expect(res.status).toBe(409);
      expect(asEnvelope(res).reason?.code).toBe('card_blocked');
    }
    expect(
      (
        await http()
          .get(`${BASE}/${card.id}/transactions`)
          .set('Authorization', p.auth)
      ).status,
    ).toBe(200);
    const quote = asEnvelope<CardQuoteView>(
      await http().get(`${BASE}/quote`).set('Authorization', p.auth),
    ).data!;
    expect(quote.limits.activeNow).toBe(0);
  });

  it('erasing the account blocks every card the person still holds at Nuvion first', async () => {
    const p = await person();
    const a = asEnvelope<CardView>(await makeCard(p)).data!;
    const b = asEnvelope<CardView>(await makeCard(p, 'single_use')).data!;
    await purge.beforeErase(p.id);
    for (const id of [a.id, b.id]) {
      const row = await prisma.walletCard.findUniqueOrThrow({ where: { id } });
      expect(row.state).toBe('cancelled');
      expect(cards.get(row.providerCardId!)!.deleted).toBe(true);
    }
    // Safe to run again.
    await purge.beforeErase(p.id);
  });
});
