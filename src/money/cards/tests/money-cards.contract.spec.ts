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
import { NuvionHandlerRegistry } from '../../../nuvion/handlers/nuvion-handler-registry';
import { NuvionWebhookDispatcher } from '../../../nuvion/webhook/nuvion-webhook-dispatcher.service';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyError } from '../../money-error';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import { NuvionBookArea } from '../../../nuvion/areas/book';
import { PrismaNuvionBookStore } from '../../../nuvion/areas/book-store';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { MoneyModule } from '../../money.module';
import { AdminCardsController } from '../admin-cards.controller';
import { CardSettings } from '../card-config';
import { WalletCardPurge } from '../card-purge.service';
import { AdminCardsService } from '../admin-cards.service';
import { WalletCardService } from '../wallet-card.service';
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

/**
 * A random reference or id is hex, so it can hold any three digits by chance (`wawu-card-3828a67312fe` holds the CVV 731). The
 * secrets check reads the text without them; a CVV in a field of its own is still found.
 */
const withoutIds = (text: string): string =>
  text.replace(
    /wawu-card-[0-9a-f]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-Za-z]{20,}/g,
    '<id>',
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
  /** Nuvion's word: active, blocked, fraud or deactivated (docs of 29 Oct 2026), or a word it adds later. */
  status: string;
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
  /** The status a card made while its answer is lost already has when it is looked for (a single-use card used in between). */
  let lostCreateStatus = 'active';
  /** `refuseFee`: the next create is refused as Nuvion refuses a funding account that cannot pay its fee. */
  let refuseFee = false;
  /** `failCreate`: the next create is a plain server failure at Nuvion (nothing made, the fee not taken). */
  let failCreate = false;
  /** `takeIssuerFee`: a card made takes Nuvion's fee out of the account, as Nuvion does (CARD-FEE-HISTORY). */
  let takeIssuerFee = false;

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
      if (failCreate) {
        failCreate = false;
        return {
          status: 400,
          body: {
            status: 'error',
            message: 'The card could not be made.',
            type: 'error_operation_invalid_for_state',
          },
        };
      }
      if (takeIssuerFee) {
        const taken = accounts.accounts.get(b.account_id)!;
        taken.balance.available = Number(taken.balance.available) - FEE;
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
        c.status = lostCreateStatus;
        lostCreateStatus = 'active';
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
    expect(withoutIds(everything)).not.toContain(CVV);
    expect(withoutIds(everything)).not.toContain(PAN.slice(-4));
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
    expect(withoutIds(everything)).not.toContain(CVV);
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

  it('a single-use card Nuvion calls blocked is frozen, as a reusable one is: only deactivated means used (CARD-USE F3, docs of 29 Oct 2026)', async () => {
    // WALLET-31 round 1 (L2) read a single-use `blocked` as used, from what the sandbox did. The
    // card guide says a frozen or soft-deleted card is blocked and a used one deactivated.
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
    const frozen = asEnvelope<CardView>(
      await http().get(`${BASE}/${card.id}`).set('Authorization', p.auth),
    ).data!;
    expect(frozen).toMatchObject({ status: 'frozen', frozenBySupport: false });
    // It is frozen, not used: the person can unfreeze it (Nuvion unfreezes it too).
    const back = asEnvelope<CardView>(
      await http()
        .post(`${BASE}/${card.id}/unfreeze`)
        .set('Authorization', p.auth)
        .set('X-Transaction-Pin', PIN),
    ).data!;
    expect(back.status).toBe('active');
    const quote = asEnvelope<CardQuoteView>(
      await http().get(`${BASE}/quote`).set('Authorization', p.auth),
    ).data!;
    expect(quote.limits.activeNow).toBe(1);
  });

  describe('a used single-use card is deactivated at Nuvion (CARD-STATUS, docs of 29 Oct 2026)', () => {
    const delivery = (
      event: string,
      row: { providerCardId: string | null; reference: string },
      entity: string,
    ) => ({
      id: randomUUID(),
      eventId: randomUUID(),
      event,
      resourceId: row.providerCardId,
      entityId: entity,
      data: { id: row.providerCardId, name: row.reference },
      receivedAt: new Date(),
      attempts: 1,
    });

    it('the webhook path ends with the card shown as used: nothing to freeze, unfreeze or show, not held any more, and a repeat or a later event changes nothing', async () => {
      const p = await person();
      const card = asEnvelope<CardView>(await makeCard(p, 'single_use')).data!;
      const row = await prisma.walletCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      // Nuvion's word once the card has taken its one payment.
      cards.get(row.providerCardId!)!.status = 'deactivated';
      const first = await handler.handle(
        delivery('cards.frozen', row, p.entity),
      );
      expect(first.outcome).toBe('done');
      expect(
        (await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }))
          .state,
      ).toBe('used');
      const used = asEnvelope<CardView>(
        await http().get(`${BASE}/${card.id}`).set('Authorization', p.auth),
      ).data!;
      expect(used).toMatchObject({
        kind: 'single_use',
        status: 'used',
        frozenBySupport: false,
        statusMessage: null,
      });
      const list = asEnvelope<CardListView>(
        await http().get(BASE).set('Authorization', p.auth),
      ).data!;
      expect(list.cards.find((c) => c.id === card.id)?.status).toBe('used');
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
      const quote = asEnvelope<CardQuoteView>(
        await http().get(`${BASE}/quote`).set('Authorization', p.auth),
      ).data!;
      expect(quote.limits.activeNow).toBe(0);
      // Nuvion delivers twice, and sends another card event later: still used.
      for (const event of ['cards.frozen', 'cards.unfrozen']) {
        expect(
          (await handler.handle(delivery(event, row, p.entity))).outcome,
        ).toBe('done');
      }
      expect(
        (await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }))
          .state,
      ).toBe('used');
    });

    it('a single-use card the person had frozen, then used, is used, not frozen', async () => {
      const p = await person();
      const card = asEnvelope<CardView>(await makeCard(p, 'single_use')).data!;
      const row = await prisma.walletCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      await prisma.walletCard.update({
        where: { id: card.id },
        data: { state: 'frozen', frozenBy: 'person' },
      });
      cards.get(row.providerCardId!)!.status = 'deactivated';
      expect(
        (await handler.handle(delivery('cards.frozen', row, p.entity))).outcome,
      ).toBe('done');
      expect(
        await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }),
      ).toMatchObject({ state: 'used', frozenBy: null });
    });

    it("a reusable card Nuvion calls deactivated is frozen as support's, and logged: the same as when it is found by its reference (CARD-USE F4)", async () => {
      const p = await person();
      const card = asEnvelope<CardView>(await makeCard(p, 'virtual')).data!;
      const row = await prisma.walletCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      cards.get(row.providerCardId!)!.status = 'deactivated';
      const before = logger.lines.length;
      const result = await handler.handle(
        delivery('cards.frozen', row, p.entity),
      );
      expect(result.outcome).toBe('done');
      expect(
        await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }),
      ).toMatchObject({ state: 'frozen', frozenBy: 'admin' });
      expect(
        logger.lines
          .slice(before)
          .some((l) => l.includes(row.id) && l.includes('deactivated')),
      ).toBe(true);
      expect(
        asEnvelope<CardView>(
          await http().get(`${BASE}/${card.id}`).set('Authorization', p.auth),
        ).data,
      ).toMatchObject({ status: 'frozen', frozenBySupport: true });
      // And a card found by its reference with that status agrees.
      loseCreate = true;
      lostCreateStatus = 'deactivated';
      const lost = asEnvelope<CardView>(await makeCard(p, 'virtual')).data!;
      expect(lost).toMatchObject({ kind: 'virtual', status: 'frozen' });
      expect(lost.frozenBySupport).toBe(true);
    });

    it('a status Nuvion adds later does not crash the handler: the delivery waits, the card is left as it was, and it is logged', async () => {
      const p = await person();
      const card = asEnvelope<CardView>(await makeCard(p, 'single_use')).data!;
      const row = await prisma.walletCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      cards.get(row.providerCardId!)!.status = 'retired';
      const before = logger.lines.length;
      const result = await handler.handle(
        delivery('cards.frozen', row, p.entity),
      );
      expect(result.outcome).toBe('wait');
      expect(
        (await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }))
          .state,
      ).toBe('active');
      expect(
        logger.lines
          .slice(before)
          .some((l) => l.includes(row.id) && l.includes('bad_response')),
      ).toBe(true);
      // The card is still readable by the person as the active card it was.
      expect(
        asEnvelope<CardView>(
          await http().get(`${BASE}/${card.id}`).set('Authorization', p.auth),
        ).data,
      ).toMatchObject({ status: 'active' });
      // And once Nuvion says a word we read, the same delivery is handled.
      cards.get(row.providerCardId!)!.status = 'deactivated';
      expect(
        (await handler.handle(delivery('cards.frozen', row, p.entity))).outcome,
      ).toBe('done');
      expect(
        (await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }))
          .state,
      ).toBe('used');
    });

    it('a single-use card whose answer was lost and which was used before it was found is adopted as used, and never made twice', async () => {
      const p = await person();
      loseCreate = true;
      lostCreateStatus = 'deactivated';
      const res = await makeCard(p, 'single_use');
      expect(res.status).toBe(201);
      const card = asEnvelope<CardView>(res).data!;
      expect(card).toMatchObject({ kind: 'single_use', status: 'used' });
      expect(
        await prisma.walletCard.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
      expect(
        [...cards.values()].filter((c) => c.entity === p.entity),
      ).toHaveLength(1);
    });
  });

  describe('a card payment uses the card up, and the card screen reads it (CARD-USE, docs of 29 Oct 2026)', () => {
    const SHOP = 'SECRETSHOP';
    const provider = () => app.get<NuvionWalletProvider>(WALLET_PROVIDER);
    const service = () => app.get(WalletCardService);
    const reads = () => seen(/^\/card-details\/[A-Za-z0-9]+$/, 'GET').length;
    const rowOf = (id: string) =>
      prisma.walletCard.findUniqueOrThrow({ where: { id } });
    const walletOf = (p: Person) => ({
      wawuUserId: p.id,
      customerId: p.entity,
      walletId: nuvionWalletId(p.entity, p.account),
      accountNumber: p.accountNumber,
    });

    /** A cards.* delivery: Nuvion's id and our reference. */
    const cardsEvent = (
      event: string,
      row: { providerCardId: string | null; reference: string },
      entity: string,
    ) => ({
      id: randomUUID(),
      eventId: randomUUID(),
      event,
      resourceId: row.providerCardId,
      entityId: entity,
      data: { id: row.providerCardId, name: row.reference },
      receivedAt: new Date(),
      attempts: 1,
    });

    /** An outflows delivery as Nuvion's docs show a card payment: `card_id` at the top of `data`. */
    const payment = (
      event: string,
      cardId: string | null,
      entity: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id: randomUUID(),
      eventId: randomUUID(),
      event,
      resourceId: '01TXN00000000000000000009',
      entityId: entity,
      data: {
        id: '01TXN00000000000000000009',
        amount: 728,
        currency: 'USD',
        unique_reference: 'TXN-USE-1',
        counterparty_id: 'acct-01ACCT-card-debit',
        account_id: '01ACCT',
        entity_id: entity,
        status: event === 'outflows.created' ? 'new' : 'successful',
        status_reason: 'processing_complete',
        narration: `Payment to ${SHOP} for 7.28 USD`,
        type: 'outflow',
        payment_type: 'card-debit',
        applicable_fee: 0,
        meta: {},
        account: { id: '01ACCT', display_name: 'Naira wallet' },
        created: Date.now(),
        updated: Date.now(),
        ...(cardId === null ? {} : { card_id: cardId }),
        ...extra,
      },
      receivedAt: new Date(),
      attempts: 1,
    });

    async function singleUse(
      p: Person,
      kind: 'single_use' | 'virtual' = 'single_use',
    ) {
      const view = asEnvelope<CardView>(await makeCard(p, kind)).data!;
      const row = await rowOf(view.id);
      return { view, row, nuvionId: row.providerCardId! };
    }

    const getView = async (p: Person, id: string) =>
      asEnvelope<CardView>(
        await http().get(`${BASE}/${id}`).set('Authorization', p.auth),
      ).data!;

    it('F1: a card-debit outflow for a single-use card Nuvion has deactivated makes it used; a repeat changes nothing and asks Nuvion nothing', async () => {
      for (const event of ['outflows.created', 'outflows.completed']) {
        const p = await person();
        const { view, nuvionId } = await singleUse(p);
        cards.get(nuvionId)!.status = 'deactivated';
        const before = reads();
        const first = await handler.handle(payment(event, nuvionId, p.entity));
        expect(first.outcome).toBe('done');
        expect(reads()).toBe(before + 1);
        expect(await rowOf(view.id)).toMatchObject({
          state: 'used',
          frozenBy: null,
        });
        const again = await handler.handle(payment(event, nuvionId, p.entity));
        expect(again.outcome).toBe('done');
        expect(reads()).toBe(before + 1);
        expect((await rowOf(view.id)).state).toBe('used');
        // The person sees it as used, and the screen needs no read of its own.
        expect(await getView(p, view.id)).toMatchObject({
          status: 'used',
          frozenBySupport: false,
        });
        expect(reads()).toBe(before + 1);
      }
    });

    it('F1: the registry hands the payment events to the cards handler (and not a reversal), and the dispatcher ends with the card used', async () => {
      const idle = { task: 'IDLE', events: [], handle: jest.fn() };
      const registry = new NuvionHandlerRegistry(
        idle as never,
        idle as never,
        idle as never,
        idle as never,
        idle as never,
        idle as never,
        idle as never,
        idle as never,
        idle as never,
        handler,
      );
      for (const event of [
        'outflows.created',
        'outflows.completed',
        'outflows.failed',
      ]) {
        expect(registry.handlersFor(event)).toContain(handler);
      }
      expect(registry.handlersFor('outflows.refunded')).not.toContain(handler);

      const p = await person();
      const { view, nuvionId } = await singleUse(p);
      cards.get(nuvionId)!.status = 'deactivated';
      const body = JSON.stringify({
        event: 'outflows.completed',
        data: payment('outflows.completed', nuvionId, p.entity).data,
      });
      const stored = await prisma.nuvionWebhookEvent.create({
        data: {
          eventId: randomUUID(),
          event: 'outflows.completed',
          resourceId: '01TXN00000000000000000009',
          entityId: p.entity,
          signedAt: new Date().toISOString(),
          bodySha256: randomUUID(),
          rawBody: Buffer.from(body),
          payload: JSON.parse(body) as object,
        },
      });
      const dispatcher = new NuvionWebhookDispatcher(prisma, registry);
      try {
        expect(await dispatcher.dispatch(stored.id)).toBe('processed');
        expect((await rowOf(view.id)).state).toBe('used');
        expect(
          await prisma.nuvionWebhookEvent.findUniqueOrThrow({
            where: { id: stored.id },
          }),
        ).toMatchObject({ processingStatus: 'processed' });
      } finally {
        await prisma.nuvionWebhookEvent.delete({ where: { id: stored.id } });
      }
    });

    it('F1: a payment that Nuvion has not yet used the card for, or one it declined, leaves the card active; the next delivery finishes the job', async () => {
      const p = await person();
      const { view, nuvionId } = await singleUse(p);
      // outflows.created before Nuvion deactivates, and a declined payment.
      for (const event of ['outflows.created', 'outflows.failed']) {
        const r = await handler.handle(payment(event, nuvionId, p.entity));
        expect(r.outcome).toBe('done');
        expect((await rowOf(view.id)).state).toBe('active');
      }
      cards.get(nuvionId)!.status = 'deactivated';
      expect(
        (
          await handler.handle(
            payment('outflows.completed', nuvionId, p.entity),
          )
        ).outcome,
      ).toBe('done');
      expect((await rowOf(view.id)).state).toBe('used');
    });

    it('F1: a payment on a reusable card reads it, and the card stays active', async () => {
      const p = await person();
      const { view, nuvionId } = await singleUse(p, 'virtual');
      const before = reads();
      const r = await handler.handle(
        payment('outflows.completed', nuvionId, p.entity),
      );
      expect(r.outcome).toBe('done');
      expect(reads()).toBe(before + 1);
      expect((await rowOf(view.id)).state).toBe('active');
    });

    it('F1: what is not a card of ours is not read: another rail, a reversal, an unknown or malformed card, another entity, a card already used or blocked', async () => {
      const p = await person();
      const other = await person();
      const mine = await singleUse(p);
      const theirs = await singleUse(other);
      cards.get(mine.nuvionId)!.status = 'deactivated';
      cards.get(theirs.nuvionId)!.status = 'deactivated';
      const before = reads();
      const left = async (d: ReturnType<typeof payment>) => {
        const r = await handler.handle(d);
        expect(r.outcome).toBe('done');
        expect(reads()).toBe(before);
      };
      // Another rail, even if a card id rides on it.
      await left(
        payment('outflows.completed', mine.nuvionId, p.entity, {
          payment_type: 'bank-transfer',
        }),
      );
      // A reversal of a card payment is a credit; it changes no card.
      await left(
        payment('outflows.refunded', mine.nuvionId, p.entity, {
          payment_type: 'card-debit-reversal',
          type: 'inflow',
        }),
      );
      // No card named, an id that is not a card, a card that is not ours.
      await left(payment('outflows.completed', null, p.entity));
      await left(payment('outflows.completed', '../x', p.entity));
      await left(
        payment('outflows.completed', '01CARD99999999999999999999', p.entity),
      );
      // The delivery names another entity than the card's owner: the card is left alone,
      // by the entity in the data and by the one the delivery was filed under.
      await left(payment('outflows.completed', mine.nuvionId, other.entity));
      await left({
        ...payment('outflows.completed', mine.nuvionId, p.entity, {
          entity_id: undefined,
        }),
        entityId: other.entity,
      });
      // And the other person's card is not touched by a delivery that names ours.
      await left(payment('outflows.completed', theirs.nuvionId, p.entity));
      expect((await rowOf(mine.view.id)).state).toBe('active');
      expect((await rowOf(theirs.view.id)).state).toBe('active');
      // A card already used, or blocked for good, is not read again.
      await prisma.walletCard.update({
        where: { id: mine.view.id },
        data: { state: 'used' },
      });
      await prisma.walletCard.update({
        where: { id: theirs.view.id },
        data: { state: 'cancelled' },
      });
      await left(payment('outflows.completed', mine.nuvionId, p.entity));
      await left(payment('outflows.completed', theirs.nuvionId, other.entity));
      expect((await rowOf(mine.view.id)).state).toBe('used');
      expect((await rowOf(theirs.view.id)).state).toBe('cancelled');
    });

    it('F1: it logs the card row and a fixed word, never what was bought or for how much; a read that fails waits and leaves the card as it was', async () => {
      const p = await person();
      const { view, row, nuvionId } = await singleUse(p);
      const before = logger.lines.length;
      // A status we cannot read, then Nuvion not answering, then the real word.
      cards.get(nuvionId)!.status = 'retired';
      const odd = await handler.handle(
        payment('outflows.completed', nuvionId, p.entity),
      );
      expect(odd.outcome).toBe('wait');
      const spy = jest.spyOn(provider().cards, 'getCard').mockRejectedValueOnce(
        new WalletProviderError({
          kind: 'unavailable',
          provider: 'nuvion',
          operation: 'get card',
        }),
      );
      const down = await handler.handle(
        payment('outflows.completed', nuvionId, p.entity),
      );
      spy.mockRestore();
      expect(down.outcome).toBe('wait');
      expect((await rowOf(view.id)).state).toBe('active');
      cards.get(nuvionId)!.status = 'deactivated';
      const ok = await handler.handle(
        payment('outflows.completed', nuvionId, p.entity),
      );
      expect(ok.outcome).toBe('done');
      const lines = logger.lines.slice(before);
      expect(
        lines.some((l) => l.includes(row.id) && l.includes('bad_response')),
      ).toBe(true);
      expect(
        lines.some((l) => l.includes(row.id) && l.includes('unavailable')),
      ).toBe(true);
      expect(lines.some((l) => l.includes(row.id) && l.includes('used'))).toBe(
        true,
      );
      // The row's id is a random uuid, which may hold any digits; the rest of the lines may not.
      const text = lines.join('\n').split(row.id).join('');
      for (const secret of [SHOP, '7.28', '728', 'TXN-USE-1', PAN, CVV]) {
        expect(text).not.toContain(secret);
      }
      const kept = await rowOf(view.id);
      expect([kept.name, kept.reference, kept.failure].join(' ')).not.toContain(
        SHOP,
      );
    });

    it('F1: a card the person blocks while Nuvion is being asked stays blocked, not used (nothing is held across the call)', async () => {
      const p = await person();
      const { view, nuvionId } = await singleUse(p);
      cards.get(nuvionId)!.status = 'deactivated';
      const real = provider().cards.getCard.bind(provider().cards);
      const spy = jest
        .spyOn(provider().cards, 'getCard')
        .mockImplementationOnce(async (w, id) => {
          const card = await real(w, id);
          // Mid-call, with no lock held: the person blocks the card.
          await prisma.walletCard.update({
            where: { id: view.id },
            data: { state: 'cancelled', cancelledAt: new Date() },
          });
          return card;
        });
      const r = await handler.handle(
        payment('outflows.completed', nuvionId, p.entity),
      );
      spy.mockRestore();
      expect(r.outcome).toBe('done');
      expect((await rowOf(view.id)).state).toBe('cancelled');
    });

    it("F2: fraud is frozen as support's on a reusable and a single-use card alike, by a payment or an event; the person cannot unfreeze it; never used", async () => {
      const p = await person();
      const single = await singleUse(p);
      const reusable = await singleUse(p, 'virtual');
      for (const c of [single, reusable])
        cards.get(c.nuvionId)!.status = 'fraud';
      expect(
        (
          await handler.handle(
            payment('outflows.completed', single.nuvionId, p.entity),
          )
        ).outcome,
      ).toBe('done');
      expect(
        (
          await handler.handle(
            cardsEvent('cards.frozen', reusable.row, p.entity),
          )
        ).outcome,
      ).toBe('done');
      for (const c of [single, reusable]) {
        expect(await rowOf(c.view.id)).toMatchObject({
          state: 'frozen',
          frozenBy: 'admin',
        });
        expect(await getView(p, c.view.id)).toMatchObject({
          status: 'frozen',
          frozenBySupport: true,
        });
        const res = await http()
          .post(`${BASE}/${c.view.id}/unfreeze`)
          .set('Authorization', p.auth)
          .set('X-Transaction-Pin', PIN);
        expect(res.status).toBe(409);
        expect(asEnvelope(res).reason?.code).toBe('card_blocked');
      }
      // The same word on a card found by its reference.
      loseCreate = true;
      lostCreateStatus = 'fraud';
      const lost = asEnvelope<CardView>(await makeCard(p, 'virtual')).data!;
      expect(lost).toMatchObject({ status: 'frozen', frozenBySupport: true });
    });

    it('F1: the card id may ride in the payment record the way Get card transactions shows it (initiator.card_id); the top-level card_id wins when both are there', async () => {
      // The docs show `card_id` at the top of an outflow; the card-transactions record (which the Hub reads
      // elsewhere) holds it under `initiator`. Both are read: a missed id would be a missed update.
      const p = await person();
      const a = await singleUse(p);
      const b = await singleUse(p);
      cards.get(a.nuvionId)!.status = 'deactivated';
      const nested = await handler.handle(
        payment('outflows.completed', null, p.entity, {
          initiator: { type: 'account', id: '01ACCT', card_id: a.nuvionId },
        }),
      );
      expect(nested.outcome).toBe('done');
      expect((await rowOf(a.view.id)).state).toBe('used');
      // Both present: the top-level one is the card. Here it names b (active at Nuvion) and the
      // initiator names c (deactivated): c must stay as it was.
      const c = await singleUse(p);
      cards.get(c.nuvionId)!.status = 'deactivated';
      await handler.handle(
        payment('outflows.completed', b.nuvionId, p.entity, {
          initiator: { type: 'account', id: '01ACCT', card_id: c.nuvionId },
        }),
      );
      expect((await rowOf(b.view.id)).state).toBe('active');
      expect((await rowOf(c.view.id)).state).toBe('active');
    });

    it("F1: the entity in the payment's data decides, before the one the delivery was filed under", async () => {
      const p = await person();
      const other = await person();
      const a = await singleUse(p);
      cards.get(a.nuvionId)!.status = 'deactivated';
      const before = reads();
      // Data names another entity, the filing says the owner: left alone.
      const forged = await handler.handle({
        ...payment('outflows.completed', a.nuvionId, p.entity, {
          entity_id: other.entity,
        }),
        entityId: p.entity,
      });
      expect(forged.outcome).toBe('done');
      expect(reads()).toBe(before);
      expect((await rowOf(a.view.id)).state).toBe('active');
      // Data names the owner, the filing says another entity: read and followed.
      const real = await handler.handle({
        ...payment('outflows.completed', a.nuvionId, p.entity),
        entityId: other.entity,
      });
      expect(real.outcome).toBe('done');
      expect(reads()).toBe(before + 1);
      expect((await rowOf(a.view.id)).state).toBe('used');
    });

    it("F1: a card the person froze while Nuvion was being asked still ends used, or held as support's for fraud: the write holds either of the two live states", async () => {
      const p = await person();
      const used = await singleUse(p);
      const fraud = await singleUse(p, 'virtual');
      cards.get(used.nuvionId)!.status = 'deactivated';
      cards.get(fraud.nuvionId)!.status = 'fraud';
      const real = provider().cards.getCard.bind(provider().cards);
      const spy = jest
        .spyOn(provider().cards, 'getCard')
        .mockImplementation(async (w, id) => {
          const card = await real(w, id);
          // Mid-call, the person freezes it: the row the decision was made on is stale.
          await prisma.walletCard.updateMany({
            where: { providerCardId: id, state: 'active' },
            data: { state: 'frozen', frozenBy: 'person' },
          });
          return card;
        });
      try {
        await handler.handle(
          payment('outflows.completed', used.nuvionId, p.entity),
        );
        await handler.handle(
          payment('outflows.completed', fraud.nuvionId, p.entity),
        );
      } finally {
        spy.mockRestore();
      }
      expect(await rowOf(used.view.id)).toMatchObject({
        state: 'used',
        frozenBy: null,
      });
      expect(await rowOf(fraud.view.id)).toMatchObject({
        state: 'frozen',
        frozenBy: 'admin',
      });
    });

    it('F1: opening the screen of an active single-use card reads Nuvion at most once a minute, and the list never does', async () => {
      const p = await person();
      const { view, nuvionId } = await singleUse(p);
      const before = reads();
      // The list does not read, even for a card Nuvion has deactivated.
      cards.get(nuvionId)!.status = 'deactivated';
      const list = asEnvelope<CardListView>(
        await http().get(BASE).set('Authorization', p.auth),
      ).data!;
      expect(list.cards.find((c) => c.id === view.id)?.status).toBe('active');
      expect(reads()).toBe(before);
      // The screen does: used at once.
      expect(await getView(p, view.id)).toMatchObject({ status: 'used' });
      expect(reads()).toBe(before + 1);
      // A used card is not read again.
      expect(await getView(p, view.id)).toMatchObject({ status: 'used' });
      expect(reads()).toBe(before + 1);
    });

    it("F1: the screen's read is throttled per card: one a minute, two screens at once make one, and a minute on it reads again", async () => {
      const p = await person();
      const { view, nuvionId } = await singleUse(p);
      const before = reads();
      const both = await Promise.all([
        getView(p, view.id),
        getView(p, view.id),
      ]);
      expect(both.map((v) => v.status)).toEqual(['active', 'active']);
      expect(reads()).toBe(before + 1);
      expect((await getView(p, view.id)).status).toBe('active');
      expect(reads()).toBe(before + 1);
      // A minute later (the throttle is the service's own clock record).
      const throttle = (
        service() as unknown as { readThrough: Map<string, number> }
      ).readThrough;
      throttle.set(view.id, Date.now() - 61_000);
      cards.get(nuvionId)!.status = 'deactivated';
      expect((await getView(p, view.id)).status).toBe('used');
      expect(reads()).toBe(before + 2);
    });

    it("F1: the screen's read applies Nuvion's word the same way: blocked is frozen, fraud is support's", async () => {
      const p = await person();
      const a = await singleUse(p);
      const b = await singleUse(p);
      cards.get(a.nuvionId)!.status = 'blocked';
      cards.get(b.nuvionId)!.status = 'fraud';
      expect(await getView(p, a.view.id)).toMatchObject({
        status: 'frozen',
        frozenBySupport: false,
      });
      expect(await getView(p, b.view.id)).toMatchObject({
        status: 'frozen',
        frozenBySupport: true,
      });
    });

    /** The screen's two books: the throttle and the first "not found". Back-dated, as a minute going by would. */
    const books = () =>
      service() as unknown as {
        readThrough: Map<string, number>;
        missingSince: Map<string, number>;
      };
    const aMinuteOn = (id: string, ms = 61_000) => {
      const b = books();
      const t = b.readThrough.get(id);
      if (t !== undefined) b.readThrough.set(id, t - ms);
      const m = b.missingSince.get(id);
      if (m !== undefined) b.missingSince.set(id, m - ms);
    };
    const gone = (nuvionId: string, yes: boolean) => {
      cards.get(nuvionId)!.deleted = yes;
    };

    it('F1 LOW-1: one 404 from Nuvion on the screen leaves the card as it was, and a read that finds it forgets the 404', async () => {
      const p = await person();
      const { view, nuvionId } = await singleUse(p);
      const before = logger.lines.length;
      gone(nuvionId, true);
      expect(await getView(p, view.id)).toMatchObject({ status: 'active' });
      expect((await rowOf(view.id)).state).toBe('active');
      const first = logger.lines
        .slice(before)
        .filter((l) => l.includes(view.id) && l.includes('not_found'));
      expect(first).toHaveLength(1);
      // The card is live at Nuvion again: found, still active, the 404 forgotten.
      gone(nuvionId, false);
      aMinuteOn(view.id);
      expect(await getView(p, view.id)).toMatchObject({ status: 'active' });
      expect(books().missingSince.has(view.id)).toBe(false);
      // Another single 404 a minute later is a first one again, not a second.
      gone(nuvionId, true);
      aMinuteOn(view.id);
      expect(await getView(p, view.id)).toMatchObject({ status: 'active' });
      expect((await rowOf(view.id)).state).toBe('active');
    });

    it('F1 LOW-1: two 404s a minute or more apart block the card for good; two inside the minute do not', async () => {
      const p = await person();
      const { view, nuvionId } = await singleUse(p);
      gone(nuvionId, true);
      expect(await getView(p, view.id)).toMatchObject({ status: 'active' });
      // The throttle is lifted but the 404 is only seconds old: still a first one.
      books().readThrough.delete(view.id);
      expect(await getView(p, view.id)).toMatchObject({ status: 'active' });
      expect((await rowOf(view.id)).state).toBe('active');
      // A minute on, Nuvion still does not know it: blocked for good, in the Hub's words.
      const before = logger.lines.length;
      aMinuteOn(view.id);
      expect(await getView(p, view.id)).toMatchObject({ status: 'blocked' });
      expect(await rowOf(view.id)).toMatchObject({ state: 'cancelled' });
      expect(
        logger.lines
          .slice(before)
          .some((l) => l.includes(view.id) && l.includes('not_found')),
      ).toBe(true);
    });

    it("F1 LOW-1: only Nuvion's own 404 counts: an unavailable read, or a not_found with no 404 behind it, never blocks a card, however often", async () => {
      const p = await person();
      const { view } = await singleUse(p);
      for (const err of [
        { kind: 'unavailable' as const, httpStatus: 404 },
        { kind: 'not_found' as const, httpStatus: null },
        { kind: 'not_found' as const, httpStatus: 200 },
      ]) {
        for (let i = 0; i < 3; i += 1) {
          const spy = jest
            .spyOn(provider().cards, 'getCard')
            .mockRejectedValueOnce(
              new WalletProviderError({
                ...err,
                provider: 'nuvion',
                operation: 'get card',
              }),
            );
          aMinuteOn(view.id);
          books().readThrough.delete(view.id);
          expect(await getView(p, view.id)).toMatchObject({ status: 'active' });
          spy.mockRestore();
        }
      }
      expect(books().missingSince.has(view.id)).toBe(false);
      expect((await rowOf(view.id)).state).toBe('active');
    });

    it('F1 LOW-1: a second 404 does not block a card that was frozen, used or blocked while Nuvion was being asked', async () => {
      for (const became of ['frozen', 'used', 'cancelled']) {
        const p = await person();
        const { view } = await singleUse(p);
        // A 404 a minute ago.
        books().missingSince.set(view.id, Date.now() - 61_000);
        const spy = jest
          .spyOn(provider().cards, 'getCard')
          .mockImplementationOnce(async () => {
            await prisma.walletCard.update({
              where: { id: view.id },
              data: {
                state: became,
                ...(became === 'frozen' ? { frozenBy: 'person' } : {}),
                ...(became === 'cancelled' ? { cancelledAt: new Date() } : {}),
              },
            });
            throw new WalletProviderError({
              kind: 'not_found',
              httpStatus: 404,
              provider: 'nuvion',
              operation: 'get card',
            });
          });
        await getView(p, view.id);
        spy.mockRestore();
        expect((await rowOf(view.id)).state).toBe(became);
      }
    });

    it('F1 LOW-1: a card payment that meets one 404 asks again; only the second try blocks the card, and a try that finds it follows it', async () => {
      const p = await person();
      const a = await singleUse(p);
      gone(a.nuvionId, true);
      const first = await handler.handle(
        payment('outflows.completed', a.nuvionId, p.entity),
      );
      expect(first.outcome).toBe('wait');
      expect((await rowOf(a.view.id)).state).toBe('active');
      const second = await handler.handle({
        ...payment('outflows.completed', a.nuvionId, p.entity),
        attempts: 2,
      });
      expect(second.outcome).toBe('done');
      expect((await rowOf(a.view.id)).state).toBe('cancelled');
      // The second try finds a card that is live and used: it follows Nuvion.
      const b = await singleUse(p);
      gone(b.nuvionId, true);
      expect(
        (
          await handler.handle(
            payment('outflows.completed', b.nuvionId, p.entity),
          )
        ).outcome,
      ).toBe('wait');
      gone(b.nuvionId, false);
      cards.get(b.nuvionId)!.status = 'deactivated';
      expect(
        (
          await handler.handle({
            ...payment('outflows.completed', b.nuvionId, p.entity),
            attempts: 2,
          })
        ).outcome,
      ).toBe('done');
      expect((await rowOf(b.view.id)).state).toBe('used');
    });

    it('F1: the screen does not read a reusable card, and a read that fails never fails the screen', async () => {
      const p = await person();
      const reusable = await singleUse(p, 'virtual');
      const single = await singleUse(p);
      cards.get(reusable.nuvionId)!.status = 'deactivated';
      const before = reads();
      expect(await getView(p, reusable.view.id)).toMatchObject({
        status: 'active',
      });
      expect(reads()).toBe(before);
      const logged = logger.lines.length;
      const spy = jest.spyOn(provider().cards, 'getCard').mockRejectedValueOnce(
        new WalletProviderError({
          kind: 'unavailable',
          provider: 'nuvion',
          operation: 'get card',
        }),
      );
      expect(await getView(p, single.view.id)).toMatchObject({
        status: 'active',
      });
      spy.mockRestore();
      expect(
        logger.lines
          .slice(logged)
          .some((l) => l.includes(single.view.id) && l.includes('unavailable')),
      ).toBe(true);
    });

    describe('a card found by its reference is not brought back from where it went', () => {
      /** A row waiting for the issuer's word, and the card Nuvion made under its reference. */
      async function waiting(p: Person) {
        const reference = `wawu-card-${randomUUID().slice(0, 12)}`;
        cardSeq += 1;
        const nuvionId = `01CARD${String(cardSeq).padStart(20, '0')}`;
        cards.set(nuvionId, {
          id: nuvionId,
          name: reference,
          type: 'virtual',
          status: 'active',
          account: p.account,
          entity: p.entity,
          deleted: false,
        });
        const row = await prisma.walletCard.create({
          data: {
            wawuUserId: p.id,
            provider: 'nuvion',
            reference,
            type: 'virtual',
            name: 'Virtual card',
            state: 'unknown',
            createdAt: new Date(Date.now() - 60_000),
          },
        });
        return { row, nuvionId, reference };
      }

      /** `during` runs after Nuvion has answered the look-up and before the row is written. */
      function duringLookup(during: () => Promise<unknown>) {
        const real = provider().cards.findCard.bind(provider().cards);
        return jest
          .spyOn(provider().cards, 'findCard')
          .mockImplementationOnce(async (w, ref) => {
            const found = await real(w, ref);
            await during();
            return found;
          });
      }

      it('a delivery of cards.created that adopted it a moment ago is the answer, not an error', async () => {
        const p = await person();
        const { row, nuvionId, reference } = await waiting(p);
        const spy = duringLookup(() =>
          handler.handle({
            ...cardsEvent(
              'cards.created',
              { providerCardId: nuvionId, reference },
              p.entity,
            ),
            data: { id: nuvionId, name: reference },
          }),
        );
        const settled = await service().settlePending(walletOf(p), row);
        spy.mockRestore();
        expect(settled).toMatchObject({
          providerCardId: nuvionId,
          state: 'active',
        });
        expect(await rowOf(row.id)).toMatchObject({
          providerCardId: nuvionId,
          state: 'active',
        });
      });

      it.each(['cancelled', 'used'])(
        'a card that became %s while Nuvion was being asked stays so',
        async (gone) => {
          const p = await person();
          for (const withId of [true, false]) {
            const { row, nuvionId } = await waiting(p);
            const spy = duringLookup(() =>
              prisma.walletCard.update({
                where: { id: row.id },
                data: {
                  state: gone,
                  ...(gone === 'cancelled' ? { cancelledAt: new Date() } : {}),
                  ...(withId ? { providerCardId: nuvionId } : {}),
                },
              }),
            );
            await service().settlePending(walletOf(p), row);
            spy.mockRestore();
            expect((await rowOf(row.id)).state).toBe(gone);
          }
        },
      );
    });
  });

  it('support blocking a used single-use card is refused 409 card_blocked in the Hub error shape, and writes no audit row (WALLET-31 L6)', async () => {
    const p = await person();
    const card = asEnvelope<CardView>(await makeCard(p, 'single_use')).data!;
    await prisma.walletCard.update({
      where: { id: card.id },
      data: { state: 'used' },
    });
    const actor = {
      id: randomUUID(),
      email: 'finance@test.wawu.dev',
      role: AdminRole.finance,
    };
    const refused = await admin.cancel(actor, card.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(MoneyError);
    expect(refused).toMatchObject({ code: 'card_blocked' });
    expect((refused as MoneyError).getStatus()).toBe(409);
    expect(
      await prisma.adminOpsAudit.count({
        where: { resource: 'wallet_card', resourceId: card.id },
      }),
    ).toBe(0);
    expect(
      (await prisma.walletCard.findUniqueOrThrow({ where: { id: card.id } }))
        .state,
    ).toBe('used');
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

  describe('CARD-FEE-HISTORY: the fee a card costs is a row in the history', () => {
    const FEE_WAWU = 1_000;
    const ISSUER = (reference: string) => `${reference}-issuer`;
    beforeEach(() => {
      takeIssuerFee = true;
    });
    afterEach(() => {
      takeIssuerFee = false;
      failCreate = false;
      refuseFee = false;
      (settings as { wawuFeeKobo: number }).wawuFeeKobo = 0;
    });

    const history = async (p: Person) =>
      asEnvelope<{
        items: Array<{
          id: string;
          direction: string;
          category: string;
          status: string;
          amountKobo: number;
          totalKobo: number;
          description: string;
          reference: string;
          counterparty: { kind: string; name: string } | null;
        }>;
        nextCursor: string | null;
      }>(
        await http()
          .get('/api/hub/money/transactions')
          .set('Authorization', p.auth)
          .expect(200),
      ).data!;

    const feeRows = (p: Person) =>
      prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: p.id, walletKind: 'user' },
        orderBy: { createdAt: 'asc' },
      });

    it('getting a card writes one fee row, an out row of the debit, drawn as a send fee row is', async () => {
      const p = await person();
      const res = await makeCard(p);
      expect(res.status).toBe(201);
      const card = asEnvelope<CardView>(res).data!;
      const row = await prisma.walletCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      const page = await history(p);
      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      expect(item).toMatchObject({
        direction: 'out',
        category: 'transfer',
        status: 'completed',
        amountKobo: FEE,
        totalKobo: FEE,
        reference: ISSUER(row.reference),
        counterparty: { kind: 'wawu', name: "WAWU's fee" },
      });
      expect(item.description).not.toMatch(/—/);
      // The row's own amount is what the provider took: the stand-in's balance fell by it.
      expect(book.availableOf(p.account)).toBe(5_000_000 - item.amountKobo);
      expect(BigInt(item.amountKobo)).toBe(row.providerFeeKobo);
    });

    it("the history adds up to the stand-in balance after two cards, one with WAWU's fee on top", async () => {
      const p = await person();
      expect((await makeCard(p)).status).toBe(201);
      (settings as { wawuFeeKobo: number }).wawuFeeKobo = FEE_WAWU;
      expect((await makeCard(p, 'single_use')).status).toBe(201);
      const page = await history(p);
      expect(page.items).toHaveLength(3);
      expect(page.items.every((i) => i.direction === 'out')).toBe(true);
      const sum = page.items.reduce((n, i) => n + i.totalKobo, 0);
      expect(sum).toBe(FEE + FEE + FEE_WAWU);
      expect(book.availableOf(p.account)).toBe(5_000_000 - sum);
    });

    it('a refused issue (the fee cannot be paid) leaves no row and no charge', async () => {
      const p = await person();
      refuseFee = true;
      const res = await makeCard(p);
      expect(res.status).toBe(402);
      expect(await feeRows(p)).toHaveLength(0);
      expect((await history(p)).items).toHaveLength(0);
      expect(book.availableOf(p.account)).toBe(5_000_000);
    });

    it('a failed issue (Nuvion cannot make it) leaves no row and no charge, and the key tried again makes one row', async () => {
      const p = await person();
      const key = randomUUID();
      failCreate = true;
      const res = await makeCard(p, 'virtual', key);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await feeRows(p)).toHaveLength(0);
      expect(book.availableOf(p.account)).toBe(5_000_000);
      const retry = await makeCard(p, 'virtual', key);
      expect(retry.status).toBe(201);
      expect(await feeRows(p)).toHaveLength(1);
      expect(book.availableOf(p.account)).toBe(5_000_000 - FEE);
    });

    it('a replay with the same Idempotency-Key writes one row and charges once', async () => {
      const p = await person();
      const key = randomUUID();
      const first = await makeCard(p, 'virtual', key);
      const again = await makeCard(p, 'virtual', key);
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(asEnvelope<CardView>(again).data!.id).toBe(
        asEnvelope<CardView>(first).data!.id,
      );
      expect(await feeRows(p)).toHaveLength(1);
      expect(book.availableOf(p.account)).toBe(5_000_000 - FEE);
    });

    it('two requests at once with one key make one card, one row and one charge', async () => {
      const p = await person();
      const key = randomUUID();
      const both = await Promise.all([
        makeCard(p, 'virtual', key),
        makeCard(p, 'virtual', key),
      ]);
      expect(both.some((r) => r.status === 201)).toBe(true);
      expect(
        await prisma.walletCard.count({
          where: { wawuUserId: p.id, state: { not: 'failed' } },
        }),
      ).toBe(1);
      expect(await feeRows(p)).toHaveLength(1);
      expect(book.availableOf(p.account)).toBe(5_000_000 - FEE);
    });

    it('a card whose answer was lost and then found by its reference has its fee row once', async () => {
      const p = await person();
      loseCreate = true;
      const res = await makeCard(p);
      expect(res.status).toBe(201);
      expect(await feeRows(p)).toHaveLength(1);
      // Looking at the card again (the list reads, the fee is owed to nobody) adds nothing.
      await http().get(BASE).set('Authorization', p.auth).expect(200);
      expect(await feeRows(p)).toHaveLength(1);
    });

    it("WAWU's fee is its own row, the amount that left the wallet for it, written once even when the transfer is asked again", async () => {
      const p = await person();
      (settings as { wawuFeeKobo: number }).wawuFeeKobo = FEE_WAWU;
      const card = asEnvelope<CardView>(await makeCard(p)).data!;
      const row = await prisma.walletCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      const rows = await feeRows(p);
      const wawu = rows.find(
        (r) => r.customerReference === `${row.reference}-wawu`,
      );
      expect(wawu).toBeDefined();
      expect(Number(wawu!.totalKobo)).toBe(FEE_WAWU);
      await prisma.walletCard.update({
        where: { id: card.id },
        data: { feeCollectedAt: null },
      });
      await http().get(BASE).set('Authorization', p.auth).expect(200);
      expect(await feeRows(p)).toHaveLength(2);
    });

    it("Nuvion's cards.created for a card whose answer was never seen writes the fee row once, with the card made", async () => {
      const p = await person();
      const reference = `wawu-card-${randomUUID().slice(0, 12)}`;
      const created = await prisma.walletCard.create({
        data: {
          wawuUserId: p.id,
          provider: 'nuvion',
          reference,
          type: 'virtual',
          name: 'Virtual card',
          state: 'unknown',
          providerFeeKobo: BigInt(FEE),
          wawuFeeKobo: 0n,
        },
      });
      const wired = new NuvionCardsHandler(prisma, {
        get: (token: unknown) =>
          token === LedgerService
            ? app.get(LedgerService)
            : app.get<NuvionWalletProvider>(WALLET_PROVIDER),
      } as never);
      const event = {
        id: randomUUID(),
        eventId: randomUUID(),
        event: 'cards.created' as const,
        resourceId: '01CARDHANDLER00000000000001',
        entityId: p.entity,
        data: { id: '01CARDHANDLER00000000000001', name: reference },
        receivedAt: new Date(),
        attempts: 1,
      };
      expect((await wired.handle(event)).outcome).toBe('done');
      expect((await wired.handle(event)).outcome).toBe('done');
      const after = await prisma.walletCard.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(after.state).toBe('active');
      const rows = await feeRows(p);
      expect(rows).toHaveLength(1);
      expect(rows[0].customerReference).toBe(ISSUER(reference));
      expect(Number(rows[0].totalKobo)).toBe(FEE);
    });
  });
});

describe('NF-V3: the secrets check is not fooled by a random reference', () => {
  it('a reference that holds the CVV digits is not a leak; a CVV in a field of its own, or in a log line, still is', () => {
    const reference = 'wawu-card-3828a67312fe';
    expect(reference).toContain(CVV);
    expect(
      withoutIds(
        dump([{ reference }, 'created 4f7d2b1c-0a31-4b7e-9c55-731a2b3c4d5e']),
      ),
    ).not.toContain(CVV);
    expect(withoutIds(dump([{ reference, cvv: CVV }]))).toContain(CVV);
    expect(
      withoutIds(dump({ reference, line: `card details ${CVV}` })),
    ).toContain(CVV);
  });
});
