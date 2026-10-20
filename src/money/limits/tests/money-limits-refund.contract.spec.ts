import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MoneyLimitSettings, type MoneyLimitKind } from '../money-limit-config';
import { MoneyLimits } from '../money-limits.service';

/**
 * FIX-40: a held payment that was REFUNDED (a failed bill, an unanswered
 * paid DM, a ticket refunded) gave the money back, so it no longer counts
 * toward the person's daily or monthly limit. A payment that completed
 * without a refund still counts, a refund that is decided but not yet
 * confirmed by the provider counts as still moved (the database allows
 * `refunded` only with the whole price back), and a released hold
 * (the payee was paid) still counts. Real database, no provider.
 */

const NOW = new Date('2026-10-15T10:00:00.000Z'); // 11:00 in Lagos
const TODAY = new Date('2026-10-15T09:00:00.000Z');
const LATER_TODAY = new Date('2026-10-15T09:30:00.000Z');
const LAGOS_MIDNIGHT_TODAY = new Date('2026-10-14T23:00:00.000Z');
const YESTERDAY = new Date('2026-10-14T12:00:00.000Z');
const LAGOS_FIRST_OF_MONTH = new Date('2026-09-30T23:00:00.000Z');
const FEE_KOBO = 1575n;

let prisma: PrismaService;
const users: string[] = [];
let seq = 0;

function person(): string {
  const id = randomUUID();
  users.push(id);
  return id;
}

function nuban(): string {
  seq += 1;
  return `8${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`;
}

type Held = 'bill' | 'paid_dm' | 'event_ticket';

/**
 * One held payment as the ledger and the hold table hold it: the payment, the
 * person's `out` row under the payment's reference, and the hold. `hold`
 * names the hold's state; `refund` how far a refund has got.
 */
async function heldPayment(
  payer: string,
  o: {
    kind: Held;
    price: number;
    at?: Date;
    hold?: 'held' | 'released' | 'refunded' | 'none';
    /** The decision on the hold while it is still `held`. */
    action?: 'refund' | 'release' | null;
    settledAt?: Date;
    status?: 'pending' | 'completed' | 'failed' | 'reversed';
  },
): Promise<string> {
  const at = o.at ?? TODAY;
  const id = randomUUID();
  const reference = `wawu-pay-${id}`;
  const price = BigInt(o.price);
  const merchant = nuban();
  const account = nuban();
  await prisma.walletPayment.create({
    data: {
      id,
      payerWawuUserId: payer,
      kind: o.kind,
      targetId: randomUUID(),
      title: 'A held thing',
      payeeWawuUserId: o.kind === 'bill' ? null : randomUUID(),
      priceKobo: price,
      providerFeeKobo: FEE_KOBO,
      wawuFeeKobo: 0n,
      totalKobo: price + FEE_KOBO,
      payeeShareKobo: (price * 85n) / 100n,
      wawuShareKobo: price - (price * 85n) / 100n,
      customerReference: reference,
      payerAccountNumber: account,
      merchantAccountNumber: merchant,
      status: 'completed',
      sentAt: at,
      completedAt: at,
      createdAt: at,
    },
  });
  await prisma.fintavaLedgerEntry.create({
    data: {
      walletKind: 'user',
      wawuUserId: payer,
      accountNumber: account,
      direction: 'out',
      status: o.status ?? 'completed',
      category: 'purchase',
      amountKobo: price,
      feeKobo: FEE_KOBO,
      totalKobo: price + FEE_KOBO,
      counterpartyKind: 'wawu',
      linkKind: o.kind,
      customerReference: reference,
      paymentId: id,
      source: 'send',
      occurredAt: at,
    },
  });
  const state = o.hold ?? 'held';
  if (state === 'none') return id;
  await prisma.walletHold.create({
    data: {
      paymentId: id,
      payerWawuUserId: payer,
      payeeWawuUserId: null,
      kind: o.kind,
      targetId: randomUUID(),
      title: 'A held thing',
      releaseCondition: 'bill_delivered',
      amountKobo: price,
      payeeShareKobo: 0n,
      wawuShareKobo: price,
      merchantAccountNumber: merchant,
      status: state,
      heldAt: at,
      settledAt:
        state === 'held'
          ? null
          : (o.settledAt ?? new Date(at.getTime() + 60_000)),
      refundedKobo: state === 'refunded' ? price : null,
      action:
        state === 'refunded'
          ? 'refund'
          : state === 'released'
            ? 'release'
            : (o.action ?? null),
      transferKobo: state === 'held' && !o.action ? null : price,
      customerReference: `wawu-ref-${id}`,
    },
  });
  return id;
}

function limits(env: Record<string, string> = {}): MoneyLimits {
  const config = new ConfigService(env);
  return new MoneyLimits(
    new MoneyLimitSettings(config),
    prisma,
    { name: 'fintava' },
    config,
  );
}

const day = (l: MoneyLimits, wawuUserId: string, kind: MoneyLimitKind) =>
  l.movedSince(prisma, { wawuUserId, kind }, LAGOS_MIDNIGHT_TODAY);
const month = (l: MoneyLimits, wawuUserId: string, kind: MoneyLimitKind) =>
  l.movedSince(prisma, { wawuUserId, kind }, LAGOS_FIRST_OF_MONTH);

beforeAll(() => {
  prisma = new PrismaService();
});

afterAll(async () => {
  await prisma.walletHold.deleteMany({
    where: { payerWawuUserId: { in: users } },
  });
  await prisma.fintavaLedgerEntry.deleteMany({
    where: { wawuUserId: { in: users } },
  });
  await prisma.walletPayment.deleteMany({
    where: { payerWawuUserId: { in: users } },
  });
  await prisma.$disconnect();
});

describe('FIX-40: a refunded held payment is not counted as moved', () => {
  it.each([
    ['bill', 'bill'],
    ['paid_dm', 'purchase'],
    ['event_ticket', 'purchase'],
  ] as const)(
    'a refunded %s no longer counts toward the %s limit; a completed one still does',
    async (kind, limitKind) => {
      const a = person();
      const l = limits();
      await heldPayment(a, { kind, price: 1_000_000, hold: 'refunded' });
      expect(await day(l, a, limitKind)).toBe(0n);
      expect(await month(l, a, limitKind)).toBe(0n);
      // The same kind, delivered and not refunded: still moved.
      await heldPayment(a, { kind, price: 300_000, hold: 'held' });
      expect(await day(l, a, limitKind)).toBe(300_000n);
      expect(await month(l, a, limitKind)).toBe(300_000n);
    },
  );

  it('a refund that is decided but not finished (waiting, sent and unanswered, or its row not completed) still counts as moved', async () => {
    const a = person();
    const l = limits();
    // Decided to refund; the money has not moved (the hold is still `held`).
    await heldPayment(a, {
      kind: 'bill',
      price: 100_000,
      hold: 'held',
      action: 'refund',
    });
    // The refund was sent and the provider has not confirmed it.
    const sent = await heldPayment(a, {
      kind: 'bill',
      price: 200_000,
      hold: 'held',
      action: 'refund',
    });
    await prisma.walletHold.update({
      where: { paymentId: sent },
      data: { sentAt: TODAY, waiting: 'provider' },
    });
    // The refund row on the person's wallet is still pending: the hold is
    // not `refunded` until the provider has confirmed the move.
    await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: 'user',
        wawuUserId: a,
        accountNumber: nuban(),
        direction: 'in',
        status: 'pending',
        category: 'refund',
        amountKobo: 200_000n,
        feeKobo: 0n,
        totalKobo: 200_000n,
        linkKind: 'bill',
        source: 'send',
        occurredAt: TODAY,
      },
    });
    // A complete refund, for contrast.
    await heldPayment(a, { kind: 'bill', price: 400_000, hold: 'refunded' });
    expect(await day(l, a, 'bill')).toBe(300_000n);
  });

  it('a released hold (the payee was paid) and a payment without a hold still count', async () => {
    const a = person();
    const l = limits();
    await heldPayment(a, { kind: 'paid_dm', price: 50_000, hold: 'released' });
    await heldPayment(a, { kind: 'paid_dm', price: 70_000, hold: 'none' });
    expect(await day(l, a, 'purchase')).toBe(120_000n);
  });

  it("only the payer's own refund nets, and only the payment it belongs to", async () => {
    const a = person();
    const b = person();
    const l = limits();
    await heldPayment(a, { kind: 'bill', price: 111_000, hold: 'refunded' });
    await heldPayment(a, { kind: 'bill', price: 222_000, hold: 'held' });
    await heldPayment(b, { kind: 'bill', price: 444_000, hold: 'held' });
    expect(await day(l, a, 'bill')).toBe(222_000n);
    expect(await day(l, b, 'bill')).toBe(444_000n);
  });

  it('a send (no payment behind it) is still counted while a refund is netted', async () => {
    const a = person();
    const l = limits();
    await heldPayment(a, { kind: 'bill', price: 90_000, hold: 'refunded' });
    await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: 'user',
        wawuUserId: a,
        accountNumber: nuban(),
        direction: 'out',
        status: 'completed',
        category: 'bill',
        amountKobo: 65_000n,
        feeKobo: FEE_KOBO,
        totalKobo: 65_000n + FEE_KOBO,
        counterpartyKind: 'biller',
        source: 'send',
        occurredAt: TODAY,
      },
    });
    expect(await day(l, a, 'bill')).toBe(65_000n);
  });

  it('a payment that is still pending and then refunded does not count; a failed one never did', async () => {
    const a = person();
    const l = limits();
    await heldPayment(a, {
      kind: 'bill',
      price: 90_000,
      status: 'pending',
      hold: 'none',
    });
    await heldPayment(a, {
      kind: 'bill',
      price: 80_000,
      status: 'failed',
      hold: 'none',
    });
    expect(await day(l, a, 'bill')).toBe(90_000n);
  });

  it('the day and the month are separate windows: yesterday refunded and today refunded', async () => {
    const a = person();
    const l = limits();
    // Paid yesterday, refunded today: yesterday is not in today anyway.
    await heldPayment(a, {
      kind: 'bill',
      price: 500_000,
      at: YESTERDAY,
      hold: 'refunded',
      settledAt: LATER_TODAY,
    });
    // Paid yesterday and kept: in the month, not in today.
    await heldPayment(a, {
      kind: 'bill',
      price: 250_000,
      at: YESTERDAY,
      hold: 'held',
    });
    // Paid today, kept.
    await heldPayment(a, { kind: 'bill', price: 125_000, hold: 'held' });
    expect(await day(l, a, 'bill')).toBe(125_000n);
    expect(await month(l, a, 'bill')).toBe(375_000n);
  });

  it('assertMayMove: after one failed and refunded bill a one-bill daily limit lets the next bill through, and a completed bill uses it up', async () => {
    const a = person();
    const l = limits({ WAWU_LIMIT_BILL_DAILY_KOBO: '1000000' });
    const move = (amountKobo: number) =>
      prisma.$transaction((tx) =>
        l.assertMayMove(
          { wawuUserId: a, kind: 'bill', amountKobo },
          { tx, now: NOW },
        ),
      );
    await heldPayment(a, { kind: 'bill', price: 1_000_000, hold: 'refunded' });
    await expect(move(1_000_000)).resolves.toBeUndefined();
    await heldPayment(a, { kind: 'bill', price: 1_000_000, hold: 'held' });
    await expect(move(1_000_000)).rejects.toMatchObject({ status: 403 });
    const standing = await l.dailyStanding(
      { wawuUserId: a, kind: 'bill', amountKobo: 1_000_000 },
      NOW,
    );
    expect(standing.withinDailyLimit).toBe(false);
    expect(standing.remainingTodayKobo).toBe(0);
  });
});
