import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  NuvionAccountsStandin,
  standinId,
} from '../../../test/nuvion/accounts-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import {
  NuvionPayoutsStandin,
  PARENT_ENTITY,
} from '../../../test/nuvion/payouts-standin';
import { WawuIdDouble } from '../../../test/nuvion/wawu-id-double';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { LedgerService } from '../../money/ledger/ledger.service';
import { MoneyError } from '../../money/money-error';
import { MoneyModule } from '../../money/money.module';
import {
  BankAccountCheckService,
  NAME_CHECK_ANSWERS,
} from '../../money/saved-accounts/bank-account-check.service';
import { BeneficiaryService } from '../../money/saved-accounts/beneficiary.service';
import { PayoutAccountService } from '../../money/saved-accounts/payout-account.service';
import {
  matchBank,
  nameKey,
  normalizeBankName,
  SavedAccountTargetService,
} from '../../money/saved-accounts/saved-account-target.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { nuvionWalletId } from '../areas/accounts';
import { PrismaNuvionBookStore } from '../areas/book-store';
import { reconcileBankSend } from '../handlers/outflows-bank';
import { NuvionPayoutsHandler } from '../handlers/payouts.handler';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider, nuvionAreas } from '../nuvion-wallet-provider';
import { signNuvionDelivery } from '../webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * NUV-06 end to end on a real database: bank sends made through the real
 * Nuvion adapter and client against the stand-in (NUV-01's, with NUV-04's
 * and NUV-06's routes), Nuvion's signed `outflows.*` deliveries posted to
 * the real receiver (`POST /api/hub/webhooks/nuvion`), handed to the NUV-06
 * handler by the real dispatcher, the transfer read back from the stand-in,
 * and the ledger written by the real LedgerService. Also the saved
 * accounts of the Fintava days (matched to Nuvion's list and checked by
 * name before their first Nuvion send) and the name check's answers.
 *
 * Nothing here reaches a Nuvion, Fintava or wawuafrica.com host: every
 * connection but loopback is refused (outbound-guard.ts).
 */

jest.setTimeout(120_000);

const RUN = `nuv06-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_nuv06_payouts_0123456789abcdef';
const HOOK = '/api/hub/webhooks/nuvion';
const NUMBER = '0690000031';
const HOLDER = 'Chidinma Okafor';

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

let seq = 0;
function nuban(): string {
  seq += 1;
  return `7${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`;
}

interface Person {
  id: string;
  entityId: string;
  accountId: string;
  accountNumber: string;
}

describe('NUV-06: sending to a bank and paying out', () => {
  const wawuId = new WawuIdDouble();
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  const pay = new NuvionPayoutsStandin(standin, nuv);
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NuvionWebhookDispatcher;
  let provider: NuvionWalletProvider;
  const saved: Record<string, string | undefined> = {};
  const people: string[] = [];

  const ENV: Record<string, string> = {
    WALLET_PROVIDER: 'nuvion',
    NUVION_WEBHOOK_SECRET: SECRET,
  };

  beforeAll(async () => {
    guard = guardOutbound();
    await wawuId.start();
    await standin.start();
    nuv.install();
    pay.install();
    pay.addAccountAtBank('044', NUMBER, HOLDER);
    Object.assign(ENV, {
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
    });
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const client = new NuvionClient(
      standin.settings({ operationalAccountId: pay.operationalAccountId }),
      'nv_test_sk_NUV06payoutsKEY0000000000',
    );
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        NuvionWebhookModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      // As production builds it (NuvionModule): the areas over one client,
      // with the book store NUV-05's handler needs. Without the store that
      // handler answers `wait` to every outflow ("no record of book transfers
      // is attached") and nothing here would reach the ledger.
      .useFactory({
        factory: (db: PrismaService) => {
          provider = new NuvionWalletProvider(
            client,
            nuvionAreas(client, { bookStore: new PrismaNuvionBookStore(db) }),
          );
          return provider;
        },
        inject: [PrismaService],
      })
      .setLogger(new QuietLogger())
      .compile();
    app = moduleRef.createNestApplication(HUB_APP_OPTIONS);
    app.useLogger(new QuietLogger());
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
    dispatcher = moduleRef.get(NuvionWebhookDispatcher);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { wawuUserId: { in: people } },
            { customerReference: { startsWith: RUN } },
          ],
        },
      });
      await prisma.moneyBeneficiary.deleteMany({
        where: { ownerWawuId: { in: people } },
      });
      await prisma.moneyPayoutAccount.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.nuvionWebhookEvent.deleteMany({
        where: { eventId: { startsWith: RUN } },
      });
    }
    if (app) await app.close();
    await standin.stop();
    await wawuId.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    guard.restore();
  });

  afterEach(() => {
    expect(guard.violations).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** A person with a naira wallet at Nuvion, as NUV-02 and NUV-04 leave one. */
  async function person(available = 50_000_000): Promise<Person> {
    const id = randomUUID();
    people.push(id);
    const entityId = standinId('01ENT');
    const account = nuv.addAccount(entityId, {
      balance: { available, current: available, overdraft_used: 0 },
    });
    const accountNumber = nuban();
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: id,
        entityId,
        status: 'approved',
        accountId: account.id,
      },
    });
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: entityId,
        walletId: nuvionWalletId(entityId, account.id),
        accountNumber,
        accountName: 'Ada Lovelace',
        provider: 'nuvion',
      },
    });
    return { id, entityId, accountId: account.id, accountNumber };
  }

  let evt = 0;
  function eventId(): string {
    evt += 1;
    return `${RUN}-${evt}-${randomBytes(4).toString('hex')}`;
  }

  /** Posts a signed delivery to the real receiver; answers its event id. */
  async function deliver(
    event: string,
    data: unknown,
    id: string = eventId(),
  ): Promise<string> {
    const ts = new Date().toISOString();
    const raw = JSON.stringify({ event, data });
    const res = await request(app.getHttpServer() as Server)
      .post(HOOK)
      .set('Content-Type', 'application/json')
      .set('x-nuvion-event-id', id)
      .set('x-nuvion-event-timestamp', ts)
      .set(
        'x-nuvion-event-signature',
        signNuvionDelivery(SECRET, ts, Buffer.from(raw)),
      )
      .send(raw);
    expect(res.status).toBe(200);
    return id;
  }

  /** The same data under a new `meta` mark, so a repeat is not read as the very same delivery. */
  const distinct = (data: Record<string, unknown>) => ({
    ...data,
    meta: {
      ...((data.meta as Record<string, unknown> | undefined) ?? {}),
      mark: randomBytes(4).toString('hex'),
    },
  });

  const row = (id: string) =>
    prisma.nuvionWebhookEvent.findUniqueOrThrow({ where: { eventId: id } });

  /** Hands one stored delivery to its handlers now (the 30 s sweep's step). */
  async function dispatch(id: string) {
    const r = await row(id);
    await prisma.nuvionWebhookEvent.update({
      where: { id: r.id },
      data: { nextAttemptAt: null },
    });
    await dispatcher.dispatch(r.id);
    return row(id);
  }

  async function deliverAndDispatch(event: string, data: unknown, id?: string) {
    return dispatch(await deliver(event, data, id));
  }

  /** A bank send from a person, made through the real adapter. */
  async function sendFrom(
    p: Person,
    over: { amountKobo?: bigint; reference?: string } = {},
  ) {
    const reference =
      over.reference ?? `${RUN}-${randomBytes(5).toString('hex')}`;
    const receipt = await provider.bankTransfer({
      from: { kind: 'customer', customerId: p.entityId },
      accountNumber: NUMBER,
      accountName: HOLDER,
      bankCode: '044',
      amountKobo: over.amountKobo ?? 250_000n,
      reference,
      narration: 'Thanks for the lesson',
    });
    return { reference, receipt, id: receipt.transactionId! };
  }

  const entries = (where: object) =>
    prisma.fintavaLedgerEntry.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
  const entriesFor = (reference: string) =>
    entries({ customerReference: reference });

  // ---------------------------------------------------------------------
  // Outcomes reach the ledger once
  // ---------------------------------------------------------------------

  describe('outflows.completed, .failed, .cancelled and .refunded', () => {
    it('a completed send is one completed out row on the sender, with the bank it went to', async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      pay.settle(id, 'successful');
      const d = await deliverAndDispatch(
        'outflows.completed',
        pay.delivery(id),
      );
      expect(d.processingStatus).toBe('processed');
      const rows = await entriesFor(reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        walletKind: 'user',
        wawuUserId: p.id,
        accountNumber: p.accountNumber,
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        provider: 'nuvion',
        amountKobo: 250_000n,
        feeKobo: BigInt(pay.fee),
        totalKobo: 250_000n + BigInt(pay.fee),
        providerFeeKobo: BigInt(pay.fee),
        counterpartyKind: 'bank_account',
        counterpartyBankName: 'Access Bank',
        counterpartyBankCode: '044',
        counterpartyAccountNumber: NUMBER,
        counterpartyName: HOLDER,
        fintavaTransactionId: id,
        failureReason: null,
        source: 'webhook',
      });
    });

    it('a replay, the same send under another event id, and two at once are still one row', async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      pay.settle(id, 'successful');
      const first = await deliver('outflows.completed', pay.delivery(id));
      await dispatch(first);
      // The same delivery again (Nuvion retried): stored once, nothing new.
      await deliver('outflows.completed', pay.delivery(id), first);
      expect(
        await prisma.nuvionWebhookEvent.count({ where: { eventId: first } }),
      ).toBe(1);
      // The same send under another event id: handled, changes nothing.
      const second = await deliverAndDispatch(
        'outflows.completed',
        distinct(pay.delivery(id)),
      );
      expect(second.processingStatus).toBe('processed');
      expect(second.note).toMatch(/already recorded/);
      // Two more at once.
      const a = await deliver('outflows.completed', distinct(pay.delivery(id)));
      const b = await deliver('outflows.completed', distinct(pay.delivery(id)));
      await Promise.all([dispatch(a), dispatch(b)]);
      expect(await entriesFor(reference)).toHaveLength(1);
      expect((await entriesFor(reference))[0]).toMatchObject({
        status: 'completed',
        discrepancy: null,
      });
    });

    it("the ledger takes Nuvion's record, not the event's name, and a completed row is never failed", async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      pay.settle(id, 'successful');
      await deliverAndDispatch('outflows.completed', pay.delivery(id));
      // A late failed event for the same send: Nuvion's record says
      // successful, so the row stays completed and nothing is noted.
      const stale = await deliverAndDispatch('outflows.failed', {
        ...pay.delivery(id),
        status: 'failed',
        status_reason: 'invalid_account_details',
      });
      expect(stale.processingStatus).toBe('processed');
      const rows = await entriesFor(reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'completed', discrepancy: null });
    });

    it('a send still pending at Nuvion waits, and is recorded once it settles', async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      const eid = await deliver('outflows.completed', pay.delivery(id));
      const waiting = await dispatch(eid);
      expect(waiting.processingStatus).toBe('pending');
      expect(waiting.attempts).toBe(1);
      expect(waiting.note).toMatch(/still pending/);
      expect(await entriesFor(reference)).toHaveLength(0);
      pay.settle(id, 'processing');
      expect((await dispatch(eid)).processingStatus).toBe('pending');
      pay.settle(id, 'successful');
      expect((await dispatch(eid)).processingStatus).toBe('processed');
      expect(await entriesFor(reference)).toHaveLength(1);
    });

    it('a failed send is one failed row and the money is back at Nuvion; a replay changes nothing', async () => {
      const p = await person();
      const account = nuv.accounts.get(p.accountId)!;
      const before = Number(account.balance.available);
      const { reference, id } = await sendFrom(p, { amountKobo: 400_000n });
      expect(Number(account.balance.available)).toBe(
        before - 400_000 - pay.fee,
      );
      pay.settle(id, 'failed', 'invalid_account_details');
      // Nuvion's balance has the money again: that is the truth.
      expect(Number(account.balance.available)).toBe(before);
      const d = await deliverAndDispatch('outflows.failed', pay.delivery(id));
      expect(d.processingStatus).toBe('processed');
      const rows = await entriesFor(reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'failed',
        direction: 'out',
        failureReason: 'The bank did not complete this transfer.',
        amountKobo: 400_000n,
      });
      await deliverAndDispatch('outflows.failed', distinct(pay.delivery(id)));
      const again = await entriesFor(reference);
      expect(again).toHaveLength(1);
      expect(again[0]).toMatchObject({ status: 'failed', discrepancy: null });
      // A failed send never turns completed on a later delivery.
      await deliverAndDispatch(
        'outflows.completed',
        distinct(pay.delivery(id)),
      );
      expect((await entriesFor(reference))[0].status).toBe('failed');
    });

    it('a cancelled send is a failed row', async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      pay.settle(id, 'failed', 'cancelled_by_user');
      const d = await deliverAndDispatch(
        'outflows.cancelled',
        pay.delivery(id),
      );
      expect(d.processingStatus).toBe('processed');
      expect((await entriesFor(reference))[0]).toMatchObject({
        status: 'failed',
      });
    });

    it('a refunded send is one reversed row; the same refund again, and a refund that does not fit, change nothing', async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      pay.settle(id, 'successful');
      await deliverAndDispatch('outflows.completed', pay.delivery(id));
      expect((await entriesFor(reference))[0].status).toBe('completed');

      const { credit } = pay.reverse(id);
      const d = await deliverAndDispatch(
        'outflows.refunded',
        pay.delivery(credit.id),
      );
      expect(d.processingStatus).toBe('processed');
      const rows = await entriesFor(reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'reversed', discrepancy: null });

      const again = await deliverAndDispatch(
        'outflows.refunded',
        distinct(pay.delivery(credit.id)),
      );
      expect(again.note).toMatch(/already recorded/);
      expect(await entriesFor(reference)).toHaveLength(1);
      // The completed event arriving after the reversal does not undo it.
      await deliverAndDispatch(
        'outflows.completed',
        distinct(pay.delivery(id)),
      );
      expect((await entriesFor(reference))[0].status).toBe('reversed');
    });

    it('a refund that gives back less, or names no send, is a stop kept for review', async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      pay.settle(id, 'successful');
      await deliverAndDispatch('outflows.completed', pay.delivery(id));

      const { credit } = pay.reverse(id);
      const partial = await deliverAndDispatch('outflows.refunded', {
        ...pay.delivery(credit.id),
        amount: 1,
      });
      // The credit record is re-read from Nuvion only through the original,
      // so the delivery's own figure is what is compared.
      expect(partial.processingStatus).toBe('failed');
      expect(partial.note).toMatch(/partial refund/);

      const meta = await deliverAndDispatch('outflows.refunded', {
        ...pay.delivery(credit.id),
        meta: {},
      });
      expect(meta.processingStatus).toBe('failed');
      expect(meta.note).toMatch(/names no send/);

      expect((await entriesFor(reference))[0].status).toBe('completed');
    });

    it('D3: a refund that names a send Nuvion still shows as completed waits for the record, then reverses it once; past the wait it is a stop for review', async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      pay.settle(id, 'successful');
      await deliverAndDispatch('outflows.completed', pay.delivery(id));
      const { credit } = pay.reverse(id);
      pay.transfer(id).status = 'successful'; // the record has not caught up yet
      const d = await deliverAndDispatch(
        'outflows.refunded',
        pay.delivery(credit.id),
      );
      expect(d.processingStatus).toBe('pending');
      expect(d.note).toMatch(/still shows the send as successful/);
      expect((await entriesFor(reference))[0].status).toBe('completed');
      pay.transfer(id).status = 'reversed'; // now it has
      const again = await dispatch(d.eventId);
      expect(again.processingStatus).toBe('processed');
      expect((await entriesFor(reference)).map((r) => r.status)).toEqual([
        'reversed',
      ]);

      // A record that never catches up is kept for review once the wait is over.
      const q = await person();
      const stuck = await sendFrom(q);
      pay.settle(stuck.id, 'successful');
      await deliverAndDispatch('outflows.completed', pay.delivery(stuck.id));
      const fake = pay.reverse(stuck.id);
      pay.transfer(stuck.id).status = 'successful';
      const waiting = await deliverAndDispatch(
        'outflows.refunded',
        pay.delivery(fake.credit.id),
      );
      expect(waiting.processingStatus).toBe('pending');
      await prisma.nuvionWebhookEvent.update({
        where: { id: waiting.id },
        data: { receivedAt: new Date(Date.now() - 80 * 3_600_000) },
      });
      const over = await dispatch(waiting.eventId);
      expect(over.processingStatus).toBe('failed');
      expect(over.note).toMatch(/waited past the limit/);
      expect((await entriesFor(stuck.reference)).map((r) => r.status)).toEqual([
        'completed',
      ]);
    });

    it("N8: a book transfer's refund credit that names no send is left to NUV-05's handler, not a stop here", async () => {
      const p = await person();
      const before = await prisma.fintavaLedgerEntry.count({
        where: { wawuUserId: p.id },
      });
      const d = await deliverAndDispatch('outflows.refunded', {
        id: standinId('01CRD'),
        amount: 5_000,
        currency: 'NGN',
        unique_reference: `${RUN}-book-credit`,
        account_id: p.accountId,
        entity_id: p.entityId,
        status: 'successful',
        type: 'inflow',
        payment_type: 'book-transfer',
        applicable_fee: 0,
        created: Date.now(),
      });
      // This handler leaves it alone; NUV-05's handler (which does not hold
      // this reference either) leaves it alone too: nothing is flagged.
      expect(d.processingStatus).toBe('processed');
      expect(d.note).toMatch(
        /NUV-06: a book-transfer refund that names no send/,
      );
      expect(
        await prisma.fintavaLedgerEntry.count({ where: { wawuUserId: p.id } }),
      ).toBe(before);
    });

    it('a card refund is not a bank send and is left alone', async () => {
      const p = await person();
      const d = await deliverAndDispatch('outflows.refunded', {
        id: standinId('01CRD'),
        amount: 515,
        currency: 'NGN',
        unique_reference: `${RUN}-card`,
        account_id: p.accountId,
        entity_id: p.entityId,
        status: 'successful',
        type: 'inflow',
        payment_type: 'card-debit-reversal',
        meta: { source_payment_id: standinId('01TRF') },
        applicable_fee: 0,
        created: Date.now(),
      });
      expect(d.processingStatus).toBe('processed');
      expect(d.note).toMatch(/card refund/);
    });

    it("a delivery that disagrees with Nuvion's record records nothing", async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p);
      pay.settle(id, 'successful');
      const lies: Array<[string, Record<string, unknown>, RegExp]> = [
        ['amount', { amount: 999 }, /says 250000 kobo/],
        ['fee', { applicable_fee: 1 }, /fee 2345/],
        [
          'reference',
          { unique_reference: 'someone-elses' },
          /another reference/,
        ],
      ];
      for (const [what, over, why] of lies) {
        const d = await deliverAndDispatch('outflows.completed', {
          ...pay.delivery(id),
          ...over,
        });
        expect([what, d.processingStatus]).toEqual([what, 'failed']);
        expect(d.note).toMatch(why);
      }
      expect(await entriesFor(reference)).toHaveLength(0);
    });

    it('an unknown person waits; an account that is not theirs is a stop', async () => {
      const lonely = standinId('01ENT');
      nuv.addAccount(lonely, {
        balance: {
          available: 9_000_000,
          current: 9_000_000,
          overdraft_used: 0,
        },
      });
      pay.addAccountAtBank('044', '0123456710', 'Another Person');
      const reference = `${RUN}-lonely`;
      // A transfer from an entity no person holds yet.
      const sent = await provider.bankTransfer({
        from: { kind: 'customer', customerId: lonely },
        accountNumber: '0123456710',
        accountName: 'Another Person',
        bankCode: '044',
        amountKobo: 5_000n,
        reference,
      });
      pay.settle(sent.transactionId!, 'successful');
      const waits = await deliverAndDispatch(
        'outflows.completed',
        pay.delivery(sent.transactionId!),
      );
      expect(waits.processingStatus).toBe('pending');
      expect(waits.note).toMatch(/no person holds this entity/);

      // The entity is a person's, but the account is not their naira account.
      const p = await person();
      const other = nuv.addAccount(p.entityId);
      const stop = await deliverAndDispatch('outflows.completed', {
        ...pay.delivery(sent.transactionId!),
        entity_id: p.entityId,
        account_id: other.id,
      });
      expect(stop.processingStatus).toBe('failed');
      expect(stop.note).toMatch(/not the person's naira account/);
      expect(await entriesFor(reference)).toHaveLength(0);
    });

    it("a book transfer's events are not a bank send's and record nothing here", async () => {
      const p = await person();
      const d = await deliverAndDispatch('outflows.completed', {
        id: standinId('01TRF'),
        amount: 5_000,
        currency: 'NGN',
        unique_reference: `${RUN}-book`,
        account_id: p.accountId,
        entity_id: p.entityId,
        status: 'successful',
        type: 'outflow',
        payment_type: 'book-transfer',
        applicable_fee: 0,
        created: Date.now(),
      });
      expect(d.note).toMatch(
        /NUV-06: the transfer is by book-transfer, not a bank send/,
      );
      expect(await entriesFor(`${RUN}-book`)).toHaveLength(0);
    });

    it("a send the sending feature already wrote keeps its quoted figures: Nuvion's record only settles it", async () => {
      const p = await person();
      const { reference, id } = await sendFrom(p, { amountKobo: 1_000_000n });
      const ledger = moduleRef.get(LedgerService);
      // The sending feature quoted Nuvion's charge plus WAWU's on top (R-10).
      await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: p.id,
          accountNumber: p.accountNumber,
        },
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 1_000_000,
        feeKobo: 6_500,
        totalKobo: 1_006_500,
        providerFeeKobo: pay.fee,
        wawuFeeKobo: 6_500 - pay.fee,
        counterparty: {
          kind: 'bank_account',
          name: HOLDER,
          accountNumber: NUMBER,
          bankCode: '044',
          bankName: 'Access Bank',
        },
        references: { customerReference: reference },
        source: 'send',
      });
      pay.settle(id, 'successful');
      await deliverAndDispatch('outflows.completed', pay.delivery(id));
      const rows = await entriesFor(reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'completed',
        feeKobo: 6_500n,
        totalKobo: 1_006_500n,
        discrepancy: null,
        fintavaTransactionId: id,
      });
    });

    describe('the fee: a charge Nuvion does not state is never 0, and one that differs from the quote is not lost', () => {
      /** The sending feature's pending row, quoted as R-10 says: Nuvion's charge plus WAWU's on top. */
      async function quote(p: Person, reference: string, amountKobo: number) {
        await moduleRef.get(LedgerService).record({
          wallet: {
            kind: 'user',
            wawuUserId: p.id,
            accountNumber: p.accountNumber,
          },
          direction: 'out',
          status: 'pending',
          category: 'transfer',
          amountKobo,
          feeKobo: 6_500,
          totalKobo: amountKobo + 6_500,
          providerFeeKobo: pay.fee,
          wawuFeeKobo: 6_500 - pay.fee,
          counterparty: {
            kind: 'bank_account',
            name: HOLDER,
            accountNumber: NUMBER,
            bankCode: '044',
            bankName: 'Access Bank',
          },
          references: { customerReference: reference },
          source: 'send',
        });
      }
      const asRecord = (id: string) =>
        pay.transfer(id) as unknown as Record<string, unknown>;

      it('D1b: a completed record that states no fee writes no row (not a fee of 0), and is recorded once the record states it', async () => {
        const p = await person();
        const { reference, id } = await sendFrom(p);
        pay.settle(id, 'successful');
        const t = asRecord(id);
        const stated = t.applicable_fee;
        delete t.applicable_fee;
        const d = await deliverAndDispatch(
          'outflows.completed',
          pay.delivery(id),
        );
        expect(d.processingStatus).toBe('pending');
        expect(d.note).toMatch(/states no fee/);
        expect(await entriesFor(reference)).toHaveLength(0);
        // Nuvion's record now states its charge: the same delivery is recorded, once.
        t.applicable_fee = stated;
        const later = await dispatch(d.eventId);
        expect(later.processingStatus).toBe('processed');
        const rows = await entriesFor(reference);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 'completed',
          feeKobo: BigInt(pay.fee),
          providerFeeKobo: BigInt(pay.fee),
          discrepancy: null,
        });
      });

      it("D1b: a row the sending feature wrote stays as it wrote it (pending, its quote) while Nuvion's record states no fee", async () => {
        const p = await person();
        const { reference, id } = await sendFrom(p, { amountKobo: 1_000_000n });
        await quote(p, reference, 1_000_000);
        pay.settle(id, 'successful');
        delete asRecord(id).applicable_fee;
        const d = await deliverAndDispatch(
          'outflows.completed',
          pay.delivery(id),
        );
        expect(d.processingStatus).toBe('pending');
        const rows = await entriesFor(reference);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 'pending',
          feeKobo: 6_500n,
          totalKobo: 1_006_500n,
          providerFeeKobo: BigInt(pay.fee),
          discrepancy: null,
        });
        // Past the wait it is kept for review, and the row is still untouched.
        await prisma.nuvionWebhookEvent.update({
          where: { id: d.id },
          data: { receivedAt: new Date(Date.now() - 80 * 3_600_000) },
        });
        const over = await dispatch(d.eventId);
        expect(over.processingStatus).toBe('failed');
        expect((await entriesFor(reference))[0].status).toBe('pending');
      });

      it('D1b: a refund of a send whose record states no fee waits too; a failed send needs no fee', async () => {
        const p = await person();
        const { reference, id } = await sendFrom(p);
        pay.settle(id, 'successful');
        await deliverAndDispatch('outflows.completed', pay.delivery(id));
        const { original, credit } = pay.reverse(id);
        delete (original as unknown as Record<string, unknown>).applicable_fee;
        const d = await deliverAndDispatch(
          'outflows.refunded',
          pay.delivery(credit.id),
        );
        expect(d.processingStatus).toBe('pending');
        expect(d.note).toMatch(/states no fee/);
        expect((await entriesFor(reference))[0].status).toBe('completed');

        const q = await person();
        const failedSend = await sendFrom(q);
        pay.settle(failedSend.id, 'failed');
        delete asRecord(failedSend.id).applicable_fee;
        const f = await deliverAndDispatch(
          'outflows.failed',
          pay.delivery(failedSend.id),
        );
        expect(f.processingStatus).toBe('processed');
        const failedRows = await entriesFor(failedSend.reference);
        expect(failedRows.map((r) => r.status)).toEqual(['failed']);
        // A failed send charged nothing and Nuvion stated nothing: no provider charge is written.
        expect(failedRows[0].providerFeeKobo).toBeNull();
      });

      it("a failed send charged nothing: a charge on its record is not a charge, and the row's quote stands without a note", async () => {
        const p = await person();
        const { reference, id } = await sendFrom(p, { amountKobo: 1_000_000n });
        await quote(p, reference, 1_000_000);
        pay.settle(id, 'failed');
        asRecord(id).applicable_fee = 3_000;
        const d = await deliverAndDispatch('outflows.failed', pay.delivery(id));
        expect(d.processingStatus).toBe('processed');
        const rows = await entriesFor(reference);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 'failed',
          feeKobo: 6_500n,
          providerFeeKobo: BigInt(pay.fee),
          discrepancy: null,
        });
      });

      it("D1c: Nuvion's charge differs from the quote: Nuvion's is recorded and the row says both, once", async () => {
        const p = await person();
        const { reference, id } = await sendFrom(p, { amountKobo: 1_000_000n });
        await quote(p, reference, 1_000_000);
        pay.settle(id, 'successful');
        asRecord(id).applicable_fee = 3_000;
        const d = await deliverAndDispatch(
          'outflows.completed',
          pay.delivery(id),
        );
        expect(d.processingStatus).toBe('processed');
        expect(d.note).toMatch(/3000 kobo, the quote was 2345 kobo/);
        const rows = await entriesFor(reference);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 'completed',
          // The sending feature's own fee and total stand, as it wrote them.
          feeKobo: 6_500n,
          totalKobo: 1_006_500n,
          wawuFeeKobo: BigInt(6_500 - pay.fee),
          providerFeeKobo: 3_000n,
        });
        const note = rows[0].discrepancy;
        expect(note).toMatch(/3000 kobo, the quote was 2345 kobo/);
        // The same send again (another event, a replay): nothing changes, no second note.
        await deliverAndDispatch(
          'outflows.completed',
          distinct(pay.delivery(id)),
        );
        await dispatch(d.eventId);
        const again = await entriesFor(reference);
        expect(again).toHaveLength(1);
        expect(again[0].discrepancy).toBe(note);
        expect(again[0].providerFeeKobo).toBe(3_000n);
      });
    });

    it('under another provider the delivery waits for a Nuvion server', async () => {
      const fintavaLike = { name: 'fintava', label: 'Fintava' };
      const handler = new NuvionPayoutsHandler(prisma, {
        get: () => fintavaLike,
      } as unknown as ModuleRef);
      const r = await handler.handle({
        id: 'x',
        eventId: 'x',
        event: 'outflows.completed',
        resourceId: null,
        entityId: null,
        data: {},
        receivedAt: new Date(),
        attempts: 1,
      });
      expect(r).toMatchObject({ outcome: 'wait' });
      expect(r.note).toMatch(/left for a Nuvion server/);
    });
  });

  // ---------------------------------------------------------------------
  // WAWU's own payout
  // ---------------------------------------------------------------------

  describe("a payout from WAWU's operational account", () => {
    it('goes once, also tapped twice and at once, and reaches the ledger once', async () => {
      const reference = `${RUN}-payout-${randomBytes(4).toString('hex')}`;
      const before = Number(pay.operational.balance.available);
      const make = () =>
        provider.bankTransfer({
          from: { kind: 'merchant' },
          accountNumber: NUMBER,
          accountName: HOLDER,
          bankCode: '044',
          amountKobo: 2_000_000n,
          reference,
          narration: 'Event host payout',
        });
      const [a, b] = await Promise.all([make(), make()]);
      const c = await make();
      expect(
        new Set([a.transactionId, b.transactionId, c.transactionId]).size,
      ).toBe(1);
      expect(pay.byReference(reference)).toHaveLength(1);
      // WAWU's account lost the amount and Nuvion's charge once (R-31).
      expect(Number(pay.operational.balance.available)).toBe(
        before - 2_000_000 - pay.fee,
      );

      pay.settle(a.transactionId!, 'successful');
      const delivery = pay.delivery(a.transactionId!);
      expect(delivery.entity_id).toBe(PARENT_ENTITY);
      const d = await deliverAndDispatch('outflows.completed', delivery);
      expect(d.processingStatus).toBe('processed');
      const again = await deliverAndDispatch(
        'outflows.completed',
        distinct(delivery),
      );
      expect(again.note).toMatch(/already recorded/);
      const rows = await entriesFor(reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        walletKind: 'merchant',
        wawuUserId: null,
        accountNumber: 'NVXOPS0001',
        direction: 'out',
        status: 'completed',
        provider: 'nuvion',
        amountKobo: 2_000_000n,
        feeKobo: BigInt(pay.fee),
        counterpartyBankName: 'Access Bank',
      });
      // The transfer was asked for with no entity: WAWU's own.
      const body = pay.transferRequests.find(
        (r) =>
          (r as { unique_reference?: string }).unique_reference === reference,
      ) as Record<string, unknown>;
      expect('entity_id' in body).toBe(false);
      expect(body.account_id).toBe(pay.operationalAccountId);
    });

    it('a payout that fails is a failed row and the money is back in the operational account', async () => {
      const reference = `${RUN}-payfail-${randomBytes(4).toString('hex')}`;
      const before = Number(pay.operational.balance.available);
      const r = await provider.bankTransfer({
        from: { kind: 'merchant' },
        accountNumber: NUMBER,
        accountName: HOLDER,
        bankCode: '044',
        amountKobo: 700_000n,
        reference,
      });
      pay.settle(r.transactionId!, 'failed');
      expect(Number(pay.operational.balance.available)).toBe(before);
      await deliverAndDispatch(
        'outflows.failed',
        pay.delivery(r.transactionId!),
      );
      const rows = await entriesFor(reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        walletKind: 'merchant',
        status: 'failed',
      });
    });
  });

  // ---------------------------------------------------------------------
  // A lost answer
  // ---------------------------------------------------------------------

  describe('a lost answer', () => {
    it('is found again by its reference, then asked about, and never sent again under a new one', async () => {
      const p = await person();
      const reference = `${RUN}-lost-${randomBytes(4).toString('hex')}`;
      pay.loseAnswerNext();
      let error: unknown;
      try {
        await provider.bankTransfer({
          from: { kind: 'customer', customerId: p.entityId },
          accountNumber: NUMBER,
          accountName: HOLDER,
          bankCode: '044',
          amountKobo: 300_000n,
          reference,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({
        kind: 'outcome_unknown',
        recordMayExist: true,
        requestNotSent: false,
      });
      expect(pay.byReference(reference)).toHaveLength(1);
      // Found by the reference, with nothing sent.
      const sent = pay.transferRequests.length;
      const found = await reconcileBankSend(
        provider.payouts,
        reference,
        { kind: 'customer', customerId: p.entityId },
        new Date(Date.now() - 120_000),
      );
      expect(found.state).toBe('found');
      expect(pay.transferRequests).toHaveLength(sent);
      // The delivery then arrives and the ledger has it once.
      const t = pay.byReference(reference)[0];
      pay.settle(t.id, 'successful');
      await deliverAndDispatch('outflows.completed', pay.delivery(t.id));
      expect(await entriesFor(reference)).toHaveLength(1);
      // Asked to send it again under the same reference: the original.
      const again = await provider.bankTransfer({
        from: { kind: 'customer', customerId: p.entityId },
        accountNumber: NUMBER,
        accountName: HOLDER,
        bankCode: '044',
        amountKobo: 300_000n,
        reference,
      });
      expect(again.transactionId).toBe(t.id);
      expect(pay.byReference(reference)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // The name check's answers at the money layer
  // ---------------------------------------------------------------------

  describe('the account name check, as the money layer answers it', () => {
    it('shows the holder for a good account and a plain answer of its own for each way it does not confirm', async () => {
      const check = moduleRef.get(BankAccountCheckService);
      expect(await check.check('044', NUMBER)).toEqual({
        bankCode: '044',
        bankName: 'Access Bank',
        accountNumber: NUMBER,
        accountName: HOLDER,
      });
      const refusal = async (code: string, number: string) => {
        try {
          await check.check(code, number);
        } catch (e) {
          expect(e).toBeInstanceOf(MoneyError);
          return e as MoneyError;
        }
        throw new Error('expected a refusal');
      };
      const before = pay.lookups.length;
      const notFound = await refusal('044', '1111111111');
      expect(notFound.code).toBe('name_check_failed');
      expect(notFound.message).toBe(NAME_CHECK_ANSWERS.not_found);
      const notSupported = await refusal('999', NUMBER);
      expect(notSupported.code).toBe('name_check_failed');
      expect(notSupported.message).toBe(NAME_CHECK_ANSWERS.bank_not_supported);
      const badFormat = await refusal('044', '12345');
      expect(badFormat.message).toBe(NAME_CHECK_ANSWERS.bad_format);
      // Only the first asked Nuvion: the others sent nothing.
      expect(pay.lookups.length).toBe(before + 1);
      // A timeout is not a wrong account: try again.
      pay.failNext(/counterparty-lookups/, 'error_resolution_timeout');
      const timeout = await refusal('044', NUMBER);
      expect(timeout.code).toBe('provider_unreachable');
      // Nuvion's own "bank not supported" and "several matches".
      pay.failNext(
        /counterparty-lookups/,
        'error_resolution_bank_not_supported',
      );
      expect((await refusal('044', NUMBER)).message).toBe(
        NAME_CHECK_ANSWERS.bank_not_supported,
      );
      pay.failNext(
        /counterparty-lookups/,
        'error_resolution_multiple_matches',
        400,
      );
      expect((await refusal('044', NUMBER)).message).toBe(
        NAME_CHECK_ANSWERS.multiple_matches,
      );
      // The key being refused is the bank being unreachable.
      pay.failNext(
        /counterparty-lookups/,
        'error_auth_credentials_invalid',
        401,
      );
      expect((await refusal('044', NUMBER)).code).toBe('provider_unreachable');
    });
  });

  // ---------------------------------------------------------------------
  // Saved accounts of the Fintava days
  // ---------------------------------------------------------------------

  describe('a saved account from the Fintava days', () => {
    it("is matched to Nuvion's list by code and checked by name before its first Nuvion send, once", async () => {
      const targets = moduleRef.get(SavedAccountTargetService);
      const owner = randomUUID();
      people.push(owner);
      const saved = await prisma.moneyBeneficiary.create({
        data: {
          ownerWawuId: owner,
          kind: 'bank_account',
          bankCode: '044',
          bankName: 'ACCESS BANK PLC',
          accountNumber: NUMBER,
          accountName: 'OKAFOR CHIDINMA',
        },
      });
      const before = pay.lookups.length;
      const r = await targets.forBeneficiary(owner, saved.id);
      expect(r).toMatchObject({
        state: 'ready',
        target: { bankCode: '044', accountNumber: NUMBER, payee: null },
      });
      expect(pay.lookups.length).toBe(before + 1);
      const kept = await prisma.moneyBeneficiary.findUniqueOrThrow({
        where: { id: saved.id },
      });
      expect(kept.nuvionBankCode).toBe('044');
      expect(kept.nuvionCheckedAt).not.toBeNull();
      // Checked once: the next send asks nothing.
      await targets.forBeneficiary(owner, saved.id);
      expect(pay.lookups.length).toBe(before + 1);

      // The first send's payee is kept and handed back.
      const receipt = await provider.bankTransfer({
        from: { kind: 'merchant' },
        accountNumber: NUMBER,
        accountName: HOLDER,
        bankCode: '044',
        amountKobo: 1_000n,
        reference: `${RUN}-keep-${randomBytes(3).toString('hex')}`,
      });
      await targets.rememberBeneficiaryPayee(owner, saved.id, receipt.payee);
      const again = await targets.forBeneficiary(owner, saved.id);
      expect(again).toMatchObject({
        state: 'ready',
        target: { payee: receipt.payee },
      });
    });

    it("is matched by the bank's name when Nuvion's list has no such code", async () => {
      const targets = moduleRef.get(SavedAccountTargetService);
      const owner = randomUUID();
      people.push(owner);
      const saved = await prisma.moneyBeneficiary.create({
        data: {
          ownerWawuId: owner,
          kind: 'bank_account',
          bankCode: '000013',
          bankName: 'Guaranty Trust Bank Plc',
          accountNumber: '0123456720',
          accountName: 'Ngozi Eze',
        },
      });
      pay.addAccountAtBank('058', '0123456720', 'EZE NGOZI');
      const r = await targets.forBeneficiary(owner, saved.id);
      expect(r).toMatchObject({ state: 'ready', target: { bankCode: '058' } });
      expect(
        (
          await prisma.moneyBeneficiary.findUniqueOrThrow({
            where: { id: saved.id },
          })
        ).nuvionBankCode,
      ).toBe('058');
    });

    it('a bank Nuvion does not list, an account it cannot find, a changed name and a timeout each stop the send, plainly', async () => {
      const targets = moduleRef.get(SavedAccountTargetService);
      const owner = randomUUID();
      people.push(owner);
      const make = (data: object) =>
        prisma.moneyBeneficiary.create({
          data: {
            ownerWawuId: owner,
            kind: 'bank_account',
            bankCode: '044',
            bankName: 'Access Bank',
            accountNumber: NUMBER,
            accountName: HOLDER,
            ...data,
          },
        });
      const before = pay.lookups.length;
      // A bank that has no code or name match: nothing is asked.
      const lost = await make({
        bankCode: '777',
        bankName: 'Bank of Nowhere',
        accountNumber: '0123456730',
      });
      expect(await targets.forBeneficiary(owner, lost.id)).toEqual({
        state: 'refused',
        reason: 'bank_not_supported',
      });
      expect(pay.lookups.length).toBe(before);
      // No such account at the bank.
      const gone = await make({ accountNumber: '0123456731' });
      expect(await targets.forBeneficiary(owner, gone.id)).toEqual({
        state: 'refused',
        reason: 'not_found',
      });
      // The number now carries another name: shown, never sent to.
      pay.addAccountAtBank('044', '0123456732', 'Somebody Else');
      const changed = await make({ accountNumber: '0123456732' });
      expect(await targets.forBeneficiary(owner, changed.id)).toMatchObject({
        state: 'name_changed',
        accountName: 'Somebody Else',
        target: { accountName: 'Somebody Else' },
      });
      const stillOld = await prisma.moneyBeneficiary.findUniqueOrThrow({
        where: { id: changed.id },
      });
      expect(stillOld.nuvionCheckedAt).toBeNull();
      expect(stillOld.accountName).toBe(HOLDER);
      // A timeout: try again later, nothing kept.
      pay.addAccountAtBank('044', '0123456733', HOLDER);
      const slow = await make({ accountNumber: '0123456733' });
      pay.failNext(/counterparty-lookups/, 'error_resolution_timeout');
      expect(await targets.forBeneficiary(owner, slow.id)).toEqual({
        state: 'unavailable',
      });
      expect(
        (
          await prisma.moneyBeneficiary.findUniqueOrThrow({
            where: { id: slow.id },
          })
        ).nuvionCheckedAt,
      ).toBeNull();
      // Someone else's saved account, or none at all.
      expect(await targets.forBeneficiary(randomUUID(), slow.id)).toEqual({
        state: 'missing',
      });
    });

    it("a payout account has its own pair of payee ids for the person and for WAWU's account, and a new account keeps neither", async () => {
      const targets = moduleRef.get(SavedAccountTargetService);
      const payout = moduleRef.get(PayoutAccountService);
      const owner = randomUUID();
      people.push(owner);
      // R-51 (WALLET-37 round 2): a Nuvion wallet keeps no BVN name, so a
      // payout account must be in the wallet's own account name. This test is
      // about the payee ids, so the wallet is named for each account in turn.
      const walletRef = randomUUID().replace(/-/g, '');
      const nameWalletAs = (accountName: string) =>
        prisma.fintavaWallet.upsert({
          where: { wawuUserId: owner },
          create: {
            wawuUserId: owner,
            customerId: `w37-${walletRef}`,
            walletId: `w37-${walletRef}-w`,
            accountNumber: `7${walletRef.slice(0, 9)}`,
            accountName,
            provider: 'nuvion',
          },
          update: { accountName },
        });
      await nameWalletAs(HOLDER);
      // Saved under Nuvion: already matched and checked.
      const view = await payout.set(owner, {
        bankCode: '044',
        accountNumber: NUMBER,
      });
      expect(view.accountName).toBe(HOLDER);
      const row = await prisma.moneyPayoutAccount.findUniqueOrThrow({
        where: { wawuUserId: owner },
      });
      expect(row.nuvionBankCode).toBe('044');
      expect(row.nuvionCheckedAt).not.toBeNull();
      const lookups = pay.lookups.length;
      expect(await targets.forPayoutAccount(owner, 'wawu')).toMatchObject({
        state: 'ready',
        target: { bankCode: '044', payee: null },
      });
      expect(pay.lookups.length).toBe(lookups);

      const person = await provider.bankTransfer({
        from: { kind: 'merchant' },
        accountNumber: NUMBER,
        accountName: HOLDER,
        bankCode: '044',
        amountKobo: 1_000n,
        reference: `${RUN}-pa-${randomBytes(3).toString('hex')}`,
      });
      const expect_ = { bankCode: '044', accountNumber: NUMBER };
      await targets.rememberPayoutPayee(owner, 'wawu', expect_, person.payee);
      expect(await targets.forPayoutAccount(owner, 'wawu')).toMatchObject({
        target: { payee: person.payee },
      });
      // WAWU's pair is not the person's.
      expect(await targets.forPayoutAccount(owner, 'person')).toMatchObject({
        target: { payee: null },
      });
      // The same account saved again keeps its ids.
      await payout.set(owner, { bankCode: '044', accountNumber: NUMBER });
      expect(await targets.forPayoutAccount(owner, 'wawu')).toMatchObject({
        target: { payee: person.payee },
      });
      // Another number at the same bank takes none of the old account's ids.
      pay.addAccountAtBank('044', '0123456741', 'Third Account');
      await nameWalletAs('Third Account');
      await payout.set(owner, { bankCode: '044', accountNumber: '0123456741' });
      expect(await targets.forPayoutAccount(owner, 'wawu')).toMatchObject({
        target: { bankCode: '044', payee: null },
      });
      // Nor does the same number at another bank.
      await targets.rememberPayoutPayee(
        owner,
        'wawu',
        { bankCode: '044', accountNumber: '0123456741' },
        person.payee,
      );
      pay.addAccountAtBank('058', '0123456741', 'Third Account');
      await payout.set(owner, { bankCode: '058', accountNumber: '0123456741' });
      expect(await targets.forPayoutAccount(owner, 'wawu')).toMatchObject({
        target: { bankCode: '058', payee: null },
      });
      // Another account takes none of the old account's ids.
      pay.addAccountAtBank('058', '0123456740', 'Second Account');
      await nameWalletAs('Second Account');
      await payout.set(owner, { bankCode: '058', accountNumber: '0123456740' });
      expect(await targets.forPayoutAccount(owner, 'wawu')).toMatchObject({
        target: { bankCode: '058', payee: null },
      });
      // Ids offered for an account that has changed since are not kept.
      await targets.rememberPayoutPayee(owner, 'wawu', expect_, person.payee);
      expect(
        (
          await prisma.moneyPayoutAccount.findUniqueOrThrow({
            where: { wawuUserId: owner },
          })
        ).nuvionOperationalCounterpartyId,
      ).toBeNull();
    });

    it('a beneficiary saved under Nuvion carries its code and its check, and is not checked again', async () => {
      const targets = moduleRef.get(SavedAccountTargetService);
      const beneficiaries = moduleRef.get(BeneficiaryService);
      const owner = randomUUID();
      people.push(owner);
      const added = await beneficiaries.add(owner, {
        kind: 'bank_account',
        bankCode: '044',
        accountNumber: NUMBER,
      });
      const row = await prisma.moneyBeneficiary.findUniqueOrThrow({
        where: { id: added.id },
      });
      expect(row.nuvionBankCode).toBe('044');
      expect(row.nuvionCheckedAt).not.toBeNull();
      const lookups = pay.lookups.length;
      expect(await targets.forBeneficiary(owner, added.id)).toMatchObject({
        state: 'ready',
      });
      expect(pay.lookups.length).toBe(lookups);
    });

    it('matches banks by name without company words, case or punctuation, and never guesses between two', () => {
      const list = new Map([
        ['044', { code: '044', name: 'Access Bank' }],
        ['063', { code: '063', name: 'Access Bank (Diamond)' }],
        ['100', { code: '100', name: 'Twin Bank' }],
        ['101', { code: '101', name: 'TWIN BANK PLC' }],
      ]);
      expect(normalizeBankName('ACCESS BANK PLC.')).toBe('access bank');
      expect(matchBank(list, '044', 'whatever')?.code).toBe('044');
      expect(matchBank(list, '999', 'access bank plc')?.code).toBe('044');
      expect(matchBank(list, '999', 'Access Bank (Diamond)')?.code).toBe('063');
      expect(matchBank(list, '999', 'Twin Bank')).toBeNull();
      expect(matchBank(list, '999', 'Nobody')).toBeNull();
      expect(matchBank(list, '999', '   ')).toBeNull();
      expect(nameKey('Okafor, Chidinma')).toBe(nameKey('chidinma OKAFOR'));
      expect(nameKey('Chidinma Okafor')).not.toBe(nameKey('Chidinma Okafo'));
    });
  });
});
