import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  installFintava,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { loadPlansConfig } from '../../plans-config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MoneyError } from '../../../money/money-error';
import { WalletPaymentService } from '../../../money/payments/wallet-payment.service';
import { PlanTransferService } from '../plan-transfer.service';
import {
  backoffMs,
  LIMIT_WAITING_MESSAGE,
  MINUTE_MS,
} from '../plan-transfer-order';
import type {
  PlanPurchaseQuoteView,
  PlanTransferOrderView,
} from '../plan-purchase-view.type';

/**
 * TIER-05 round 3: the wallet provider's limits are shared by every WAWU
 * payment, so no order calls it on every sweep. A provider error leaves the
 * order waiting for its own next check time, unless a NEWER credit arrives.
 * On the Fintava double (the default provider); no Fintava, Nuvion or
 * wawuafrica.com host is called.
 */

jest.setTimeout(240_000);

const config = loadPlansConfig();
const small = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo)[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TICK_MS = 8_000;

describe('Pay by bank transfer at checkout (TIER-05 round 3): a provider error waits for the order backoff', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let transfers: PlanTransferService;
  let prisma: PrismaService;

  beforeAll(async () => {
    h = await bootTierApp('t05r3');
    call = api(h);
    prisma = h.prisma;
    transfers = h.get(PlanTransferService);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    installFintava(h.double, h.wallets);
    // Whatever a test left waiting must not be settled by the next test's sweep.
    await prisma.planTransferOrder.deleteMany({
      where: { status: 'awaiting', wawuUserId: { in: h.users } },
    });
  });
  afterAll(async () => {
    await prisma.planTransferOrder.deleteMany({
      where: { wawuUserId: { in: h.users } },
    });
    await h.close();
  });

  type Terms = { kind: 'tier'; tierId: string };
  const T: Terms = { kind: 'tier', tierId: small.id };
  const data = <X>(res: Response) => body<X>(res).data!;

  async function person(kobo: number): Promise<Person> {
    const p = await h.buyer(kobo);
    await prisma.fintavaWallet.update({
      where: { wawuUserId: p.id },
      data: { accountName: 'Ada Tester' },
    });
    return p;
  }
  const bal = (p: Person) => h.wallets.kobo.get(p.accountNumber) ?? 0;
  async function order(p: Person) {
    const q = await call.quote(p, T);
    expect(q.status).toBe(200);
    const quote = data<PlanPurchaseQuoteView>(q);
    const res = await call.buy(p, {
      ...T,
      method: 'transfer',
      expectedTotalKobo: quote.payment.totalKobo,
      quoteToken: quote.payment.quoteToken,
    });
    expect(res.status).toBe(201);
    return data<PlanTransferOrderView>(res);
  }
  /** Money arriving: the provider's balance and the ledger row the webhook writes. */
  async function credit(p: Person, kobo: number) {
    h.wallets.kobo.set(p.accountNumber, bal(p) + kobo);
    await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: 'user',
        wawuUserId: p.id,
        accountNumber: p.accountNumber,
        direction: 'in',
        status: 'completed',
        category: 'top_up',
        amountKobo: BigInt(kobo),
        totalKobo: BigInt(kobo),
        source: 'webhook',
        occurredAt: new Date(),
        provider: 'fintava',
      },
    });
    await sleep(5);
  }
  /** `count` people with a wallet, a waiting order each, and a credit that covers it. */
  async function funded(count: number): Promise<Person[]> {
    const people: Person[] = [];
    for (let i = 0; i < count; i += 1) {
      const p = await person(0);
      const placed = await order(p);
      await credit(p, placed.transfer!.totalKobo);
      people.push(p);
    }
    return people;
  }
  const rowOf = (p: Person) =>
    prisma.planTransferOrder.findFirstOrThrow({
      where: { wawuUserId: p.id, status: 'awaiting' },
    });

  /** The balance reads the provider is asked for, counted by account, answering `status`. */
  function balanceReads(status: number) {
    const reads = new Map<string, number>();
    h.double.on(
      'GET',
      /^\/customer\/wallet\/balance\//,
      (r: { path: string }) => {
        const account = h.wallets.byId.get(r.path.split('/').pop()!) ?? '?';
        reads.set(account, (reads.get(account) ?? 0) + 1);
        if (status !== 200)
          return { status, body: { status, message: 'unavailable' } };
        const naira = (h.wallets.kobo.get(account) ?? 0) / 100;
        return {
          status: 200,
          body: {
            data: {
              balance: { bookedBalance: naira, availableBalance: naira },
              tier: 'TIER_2',
            },
            status: 200,
            message: 'ok',
          },
        };
      },
    );
    return {
      total: () => [...reads.values()].reduce((a, b) => a + b, 0),
      of: (p: Person) => reads.get(p.accountNumber) ?? 0,
      max: () => Math.max(0, ...reads.values()),
    };
  }
  /** One sweep `afterMs` from the real clock; returns the calls it made. */
  async function sweepAt(
    counter: () => number,
    afterMs: number,
  ): Promise<number> {
    const before = counter();
    await transfers.sweep(new Date(Date.now() + afterMs));
    return counter() - before;
  }

  it('R1: 50 funded orders and a 503 balance read: 50 calls in the first sweep, none in the next sweeps until nextCheckAt', async () => {
    const people = await funded(50);
    const reads = balanceReads(503);
    const per: number[] = [];
    for (let i = 0; i < 4; i += 1)
      per.push(await sweepAt(reads.total, i * TICK_MS));

    console.log('R3 balance reads per sweep', JSON.stringify(per));
    expect(per).toEqual([50, 0, 0, 0]);
    expect(reads.max()).toBe(1);

    const row = await rowOf(people[0]);
    expect(row.checks).toBe(1);
    expect(row.creditsSeenAt).not.toBeNull();
    expect(row.nextCheckAt!.getTime()).toBeGreaterThan(
      Date.now() + backoffMs(1) - 60_000,
    );

    // Just before the check time: still nothing. Just after: each order once.
    const at = row.nextCheckAt!.getTime() - Date.now();
    expect(await sweepAt(reads.total, at - 1_000)).toBe(0);
    expect(await sweepAt(reads.total, at + 1_000)).toBe(50);
    expect((await rowOf(people[0])).checks).toBe(2);
  });

  it('a new credit for one person makes that one person due again at once, and only that one', async () => {
    const people = await funded(8);
    const reads = balanceReads(503);
    expect(await sweepAt(reads.total, 0)).toBe(8);
    expect(await sweepAt(reads.total, TICK_MS)).toBe(0);

    await credit(people[3], 1_000);
    expect(await sweepAt(reads.total, 2 * TICK_MS)).toBe(1);
    expect(reads.of(people[3])).toBe(2);
    expect(people.filter((p) => reads.of(p) !== 1)).toEqual([people[3]]);
    // That credit is now seen: the person waits for the backoff too.
    expect(await sweepAt(reads.total, 3 * TICK_MS)).toBe(0);
  });

  it('an error after the balance was read (not a refusal) waits too, and a new credit wakes it', async () => {
    const people = await funded(6);
    const reads = balanceReads(200);
    jest
      .spyOn(
        transfers as unknown as { otherPayment: () => Promise<string> },
        'otherPayment',
      )
      .mockRejectedValue(new Error('the database blinked'));
    const per: number[] = [];
    for (let i = 0; i < 3; i += 1)
      per.push(await sweepAt(reads.total, i * TICK_MS));
    expect(per).toEqual([6, 0, 0]);
    const row = await rowOf(people[0]);
    expect(row.checks).toBe(1);
    expect(row.creditsSeenAt).not.toBeNull();

    await credit(people[2], 1_000);
    expect(await sweepAt(reads.total, 3 * TICK_MS)).toBe(1);
    expect(reads.of(people[2])).toBe(2);
  });

  it.each(['daily_limit_exceeded', 'limit_reached'] as const)(
    'a person refused with %s is tried at the backoff times only',
    async (code) => {
      const people = await funded(5);
      let pays = 0;
      jest.spyOn(h.get(WalletPaymentService), 'pay').mockImplementation(() => {
        pays += 1;
        return Promise.reject(
          new MoneyError(code, 'Over the limit for today.'),
        );
      });
      const counter = () => pays;
      expect(await sweepAt(counter, 0)).toBe(5);
      expect(await sweepAt(counter, TICK_MS)).toBe(0);
      expect(await sweepAt(counter, 2 * TICK_MS)).toBe(0);
      let row = await rowOf(people[0]);
      expect(row.statusMessage).toBe(LIMIT_WAITING_MESSAGE);
      expect(row.checks).toBe(1);

      // Three backoff rounds: nothing a second before, each person once a second after.
      for (let round = 1; round <= 3; round += 1) {
        const wait = row.nextCheckAt!.getTime() - Date.now();
        expect(await sweepAt(counter, wait - 1_000)).toBe(0);
        expect(await sweepAt(counter, wait + 1_000)).toBe(5);
        row = await rowOf(people[0]);
        expect(row.checks).toBe(round + 1);
      }
      expect(pays).toBe(5 * 4);
    },
  );

  it('R1b: the send itself is refused: 10 attempts in the first sweep, none in the next three, again at nextCheckAt', async () => {
    const people = await funded(10);
    let attempts = 0;
    h.double.on('POST', '/transaction/wallet-to-wallet', () => {
      attempts += 1;
      return {
        status: 400,
        body: { status: 400, message: 'Transfer not allowed' },
      };
    });
    const counter = () => attempts;
    const per: number[] = [];
    for (let i = 0; i < 4; i += 1)
      per.push(await sweepAt(counter, i * TICK_MS));
    expect(per).toEqual([10, 0, 0, 0]);
    const rows = await prisma.walletPayment.count({
      where: { payerWawuUserId: { in: people.map((p) => p.id) } },
    });
    expect(rows).toBe(10);

    const wait = (await rowOf(people[0])).nextCheckAt!.getTime() - Date.now();
    expect(await sweepAt(counter, wait + 1_000)).toBe(10);
  });

  it('a person whose other payment for the item is still confirming is looked at once a minute, not every sweep', async () => {
    const p = await person(0);
    const placed = await order(p);
    await credit(p, placed.transfer!.totalKobo);
    const paymentId = randomUUID();
    const total = placed.transfer!.totalKobo;
    await prisma.walletPayment.create({
      data: {
        id: paymentId,
        payerWawuUserId: p.id,
        kind: 'tier',
        targetId: `tier-${small.id}`,
        title: 'A plan',
        payeeWawuUserId: null,
        priceKobo: total,
        providerFeeKobo: 0,
        wawuFeeKobo: 0,
        totalKobo: total,
        payeeShareKobo: 0,
        wawuShareKobo: total,
        customerReference: `wawu-pay-${paymentId}`,
        payerAccountNumber: p.accountNumber,
        merchantAccountNumber: 'MERCHANT-R3',
        status: 'pending',
        openKey: `${p.id}:tier:tier-${small.id}`,
      },
    });
    const reads = balanceReads(200);
    expect(await sweepAt(reads.total, 0)).toBe(1);
    expect(await sweepAt(reads.total, TICK_MS)).toBe(0);
    expect(await sweepAt(reads.total, 2 * TICK_MS)).toBe(0);
    expect(await sweepAt(reads.total, MINUTE_MS + 1_000)).toBe(1);
    await prisma.walletPayment.delete({ where: { id: paymentId } });
  });
});
