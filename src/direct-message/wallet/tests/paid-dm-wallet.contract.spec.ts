import { randomUUID } from 'node:crypto';
import {
  bootPayApp,
  PAY_PIN,
  type PayHarness,
  type PayPerson,
  STAND_IN_FEE_KOBO,
} from '../../../../test/payments/wallet-pay-harness';
import { body, until } from '../../../../test/payments/poll-helpers';
import { AccountDeletionMoneyService } from '../../../account/account-deletion-money.service';
import { HoldRequestError } from '../../../money/holds/hold-rules';
import type { EarningsView } from '../../../money/money-view.type';
import { NotificationService } from '../../../notification/notification.service';
import { SchedulerService } from '../../../scheduler/scheduler.service';
import { DmRefundService } from '../../dm-refund.service';
import { PaidDmWalletModule } from '../paid-dm-wallet.module';
import { PaidDmWalletService } from '../paid-dm-wallet.service';
import type {
  PaidQuestionQuoteView,
  PaidQuestionWalletView,
} from '../paid-dm-wallet-view.type';

/**
 * INBOX-17 on the wallet provider seam with NUVION stood in: a paid question
 * paid from the wallet with the PIN, the price held in WAWU's own (operational)
 * account (R-19), the creator's 85% released when they answer (R-5, R-11) or
 * the price returned when the window passes (R-10), and the attacks a money
 * path has to survive. After each, the ledger agrees with the stand-in, WAWU's
 * operational account included. No Nuvion, Fintava or wawuafrica.com host is
 * called.
 */

jest.setTimeout(240_000);

const PRICE = 150_000; // ₦1,500
const SHARE = 127_500; // 85% (R-5)
const FEE = STAND_IN_FEE_KOBO;
const RICH = 50_000_000;
const HOUR = 3_600_000;

describe('A paid question from the wallet (INBOX-17), Nuvion stood in', () => {
  let h: PayHarness;
  let questions: PaidDmWalletService;
  let scheduler: SchedulerService;
  const creators: string[] = [];

  beforeAll(async () => {
    h = await bootPayApp('i17', {
      modules: [PaidDmWalletModule],
      cleanup: async (prisma, users) => {
        await prisma.notification.deleteMany({
          where: { userWawuId: { in: users } },
        });
        await prisma.dmReply.deleteMany({
          where: { creatorWawuId: { in: users } },
        });
        await prisma.directMessage.deleteMany({
          where: {
            OR: [
              { senderWawuId: { in: users } },
              { creatorWawuId: { in: users } },
            ],
          },
        });
        await prisma.paidDmDraft.deleteMany({
          where: { senderWawuId: { in: users } },
        });
        await prisma.creatorNoResponseTracker.deleteMany({
          where: { creatorWawuId: { in: users } },
        });
        await prisma.creatorState.deleteMany({
          where: { wawuUserId: { in: creators } },
        });
        await prisma.userProfile.deleteMany({
          where: { wawuUserId: { in: creators } },
        });
      },
    });
    questions = h.app.get(PaidDmWalletService, { strict: false });
    scheduler = new SchedulerService(
      h.prisma,
      h.app.get(NotificationService, { strict: false }),
      h.app.get(DmRefundService, { strict: false }),
    );
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.nuvion.mode = 'successful';
  });

  /** A creator with a wallet, a profile and paid messages on at ₦1,500. */
  async function creator(
    opts: { enabled?: boolean; hours?: number } = {},
  ): Promise<PayPerson> {
    const c = await h.person(0);
    await h.prisma.userProfile.create({
      data: {
        wawuUserId: c.id,
        accountType: 'creator',
        handle: `c${c.id.slice(0, 8)}`,
      },
    });
    await h.prisma.creatorState.create({
      data: {
        wawuUserId: c.id,
        dmPrice: PRICE / 100,
        dmEnabled: opts.enabled ?? true,
        dmResponseHours: opts.hours ?? 24,
      },
    });
    creators.push(c.id);
    return c;
  }

  const askUrl = (c: PayPerson) => `/dm/${c.id}/send/wallet`;
  const ask = (
    p: PayPerson,
    c: PayPerson,
    text = 'How do you light a night shoot?',
    key?: string,
  ) => h.post(p, askUrl(c), { text }, { key, pin: null });
  const payBody = (q: PaidQuestionQuoteView) => ({
    questionId: q.question.id,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  const pay = (
    p: PayPerson,
    q: PaidQuestionQuoteView,
    opts: { key?: string; pin?: string | null } = {},
  ) => h.post(p, '/dm/send/wallet/pay', payBody(q), opts);
  const code = (res: { body: unknown }) =>
    (res.body as { reason?: { code?: string } }).reason?.code;
  const balance = (p: PayPerson) =>
    h.nuvion.accounts.get(p.account!.accountId)!.availableKobo;

  async function quoted(
    p: PayPerson,
    c: PayPerson,
  ): Promise<PaidQuestionQuoteView> {
    const res = await ask(p, c);
    if (res.status !== 201)
      throw new Error(`ask ${res.status} ${JSON.stringify(res.body)}`);
    return body<PaidQuestionQuoteView>(res).data!;
  }
  /** Asks and pays; the question as the pay answered it. */
  async function asked(
    p: PayPerson,
    c: PayPerson,
  ): Promise<PaidQuestionWalletView> {
    const res = await pay(p, await quoted(p, c));
    expect(res.status).toBe(201);
    return body<PaidQuestionWalletView>(res).data!;
  }
  const messageOf = (id: string) =>
    h.prisma.directMessage.findUniqueOrThrow({ where: { id } });
  const holdOf = async (id: string) => {
    const m = await messageOf(id);
    return h.prisma.walletHold.findUniqueOrThrow({
      where: { paymentId: m.flutterwaveTxRef.slice('wallet:'.length) },
    });
  };
  const earningOf = async (id: string) => {
    const m = await messageOf(id);
    return h.prisma.earningSettlement.findUniqueOrThrow({
      where: { paymentId: m.flutterwaveTxRef.slice('wallet:'.length) },
    });
  };
  const respond = (c: PayPerson, id: string, text = 'Use a fast lens.') =>
    h.post(c, `/dm/${id}/respond`, { text }, { pin: null });
  /** Moves a question's deadline, as time passing would. */
  const setDeadline = (id: string, at: Date) =>
    h.prisma.directMessage.update({ where: { id }, data: { deadlineAt: at } });
  const paidOut = (to: PayPerson) =>
    h.nuvion
      .sendsFrom(h.nuvion.operational.accountId)
      .filter((t) => t.toAccountId === to.account!.accountId);

  /**
   * WAWU's own account agrees too: what the stand-in holds is what it opened
   * with plus the ledger's completed money in minus its completed money out
   * (the total, the provider's charge included).
   */
  async function operationalAgrees(): Promise<void> {
    const rows = await h.prisma.fintavaLedgerEntry.findMany({
      where: {
        accountNumber: h.nuvion.operational.nuvionBan,
        status: 'completed',
      },
      select: { direction: true, amountKobo: true, totalKobo: true },
    });
    let held = 50_000_000n;
    for (const r of rows)
      held += r.direction === 'in' ? r.amountKobo : -r.totalKobo;
    expect(h.nuvion.operational.availableKobo).toBe(held);
  }

  it("I3 to I5: ₦1,500 costs ₦1,500 plus the charge, waits in WAWU's account, and the creator is paid 85% on answering", async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    const q = await quoted(fan, c);
    expect(q.question).toMatchObject({
      priceKobo: PRICE,
      replyWindowHours: 24,
      text: 'How do you light a night shoot?',
    });
    expect(q.payment).toMatchObject({
      kind: 'paid_dm',
      priceKobo: PRICE,
      totalKobo: PRICE + FEE,
      fee: { providerFeeKobo: FEE, wawuFeeKobo: 0 },
      willBeHeld: true,
    });
    // Nothing is in the creator's inbox until it is paid.
    expect(
      await h.prisma.directMessage.count({ where: { creatorWawuId: c.id } }),
    ).toBe(0);

    const op0 = h.nuvion.operational.availableKobo;
    const res = await pay(fan, q);
    expect(res.status).toBe(201);
    const v = body<PaidQuestionWalletView>(res).data!;
    expect(v).toMatchObject({
      id: q.question.id,
      status: 'asked',
      priceKobo: PRICE,
      payment: { kind: 'paid_dm', status: 'completed', delivered: true },
    });
    expect(v.deadlineAt).not.toBeNull();
    // The price sits in WAWU's own account: not the creator's, who is unpaid.
    expect(h.nuvion.operational.availableKobo - op0).toBe(BigInt(PRICE));
    expect(balance(c)).toBe(0n);
    expect(balance(fan)).toBe(BigInt(RICH - PRICE - FEE));
    const hold = await holdOf(v.id);
    expect(hold).toMatchObject({
      status: 'held',
      action: null,
      kind: 'paid_dm',
      payeeWawuUserId: c.id,
      payeeShareKobo: BigInt(SHARE),
    });
    expect(
      await h.prisma.notification.count({
        where: { userWawuId: c.id, kind: 'dm_received' },
      }),
    ).toBe(1);

    // The creator answers: the hold is released at once as an earning (R-55),
    // and the 85% reaches them in their one move of the day; WAWU keeps 15%.
    const reply = await respond(c, v.id);
    expect(reply.status).toBe(201);
    expect(await holdOf(v.id)).toMatchObject({
      status: 'released',
      action: 'release',
      transferKobo: null,
      customerReference: null,
    });
    const earning = await earningOf(v.id);
    expect(earning).toMatchObject({
      kind: 'paid_dm',
      payeeWawuUserId: c.id,
      amountKobo: BigInt(SHARE),
    });
    // Nothing was sent by the release itself.
    expect(paidOut(c)).toHaveLength(0);
    // The creator reads it once, as earned and waiting for the move: the
    // hold and the earning are one amount, not two.
    const owed = body<EarningsView>(await h.get(c, '/money/earnings')).data!;
    expect(owed.allTime.earnedKobo).toBe(SHARE);
    expect(owed.allTime.sales).toBe(1);
    expect(owed.waiting).toEqual({ count: 1, amountKobo: SHARE });
    expect(owed.held).toEqual({ count: 0, amountKobo: 0 });
    await until(async () => {
      await h.pass();
      return (await earningOf(v.id)).status === 'landed';
    }, "the earning to land in the creator's move");
    expect(balance(c)).toBe(BigInt(SHARE));
    expect(paidOut(c)).toHaveLength(1);
    expect(paidOut(c)[0].request.amount).toBe(SHARE);
    expect(paidOut(c)[0].request.unique_reference).toMatch(/^wawu-earn-d-/);
    const landed = body<EarningsView>(await h.get(c, '/money/earnings')).data!;
    expect(landed.allTime.earnedKobo).toBe(SHARE);
    expect(landed.waiting).toEqual({ count: 0, amountKobo: 0 });
    const read = body<PaidQuestionWalletView>(
      await h.get(fan, `/dm/send/wallet/${v.id}`),
    ).data!;
    expect(read.status).toBe('answered');
    // Nothing is sent again by sweeps that run after.
    await h.pass();
    await questions.sweep();
    expect(paidOut(c)).toHaveLength(1);
    // WAWU's account kept the 15% and carries the charge on the release (R-31).
    expect(h.nuvion.operational.availableKobo - op0).toBe(
      BigInt(PRICE - SHARE) - BigInt(FEE),
    );
    await h.expectLedgerEqualsStandIn([fan, c]);
    await operationalAgrees();
  });

  it('no answer in time: the price and the charge go back once, and the fan is told once', async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    const v = await asked(fan, c);
    const op0 = h.nuvion.operational.availableKobo;

    await setDeadline(v.id, new Date(Date.now() - 1000));
    // The web's Flutterwave sweep leaves a wallet question alone.
    await scheduler.refundExpiredDms();
    expect((await messageOf(v.id)).status).toBe('awaiting_response');

    const counts = await questions.sweep();
    expect(counts.expired).toBe(1);
    await until(async () => {
      await h.pass();
      await questions.sweep();
      return (await messageOf(v.id)).refundStatus === 'settled';
    }, 'the refund to be confirmed');
    // Every naira is back with the fan, the payment's charge included: the
    // fan did not cause the lapse (lead ruling 17 Oct 2026).
    expect(balance(fan)).toBe(BigInt(RICH));
    expect(balance(c)).toBe(0n);
    expect((await holdOf(v.id)).status).toBe('refunded');
    // Twice more changes nothing, and the fan is told once.
    await questions.sweep();
    await h.pass();
    await questions.sweep();
    const back = h.nuvion
      .sendsFrom(h.nuvion.operational.accountId)
      .filter((t) => t.toAccountId === fan.account!.accountId);
    expect(back).toHaveLength(1);
    expect(back[0].request.amount).toBe(PRICE + FEE);
    expect(
      await h.prisma.notification.count({
        where: { userWawuId: fan.id, kind: 'dm_refunded' },
      }),
    ).toBe(1);
    // The creator can no longer answer it.
    const late = await respond(c, v.id);
    expect(late.status).toBe(409);
    // WAWU's account gave back the price and the charge, and bore the refund
    // transfer's own charge on top.
    expect(h.nuvion.operational.availableKobo - op0).toBe(
      -(BigInt(PRICE) + 2n * BigInt(FEE)),
    );
    const read = body<PaidQuestionWalletView>(
      await h.get(fan, `/dm/send/wallet/${v.id}`),
    ).data!;
    expect(read.status).toBe('refunded');
    await h.expectLedgerEqualsStandIn([fan, c]);
    await operationalAgrees();
  });

  it('I7: the hold of a lapsed question says what really came back, price and charge (2,325 kobo), not the price alone (S3 round 2, F1)', async () => {
    expect(FEE).toBe(2325);
    const fan = await h.person(RICH);
    const c = await creator();
    const v = await asked(fan, c);
    // Held: nothing has come back, and the hold view says so.
    const held = body<PaidQuestionWalletView>(
      await h.get(fan, `/dm/send/wallet/${v.id}`),
    ).data!;
    expect(held.payment?.hold).toMatchObject({
      status: 'held',
      amountKobo: PRICE,
      refundedKobo: null,
    });

    await setDeadline(v.id, new Date(Date.now() - 1000));
    await questions.sweep();
    await until(async () => {
      await h.pass();
      await questions.sweep();
      return (await messageOf(v.id)).refundStatus === 'settled';
    }, 'the refund to be confirmed');

    // The fan really got price + charge back (the stand-in's own record).
    const back = h.nuvion
      .sendsFrom(h.nuvion.operational.accountId)
      .filter((t) => t.toAccountId === fan.account!.accountId);
    expect(back).toHaveLength(1);
    expect(back[0].request.amount).toBe(PRICE + FEE);
    expect(balance(fan)).toBe(BigInt(RICH));

    // The question's hold serves that figure, not the price.
    const read = body<PaidQuestionWalletView>(
      await h.get(fan, `/dm/send/wallet/${v.id}`),
    ).data!;
    expect(read.status).toBe('refunded');
    expect(read.payment?.hold).toMatchObject({
      status: 'refunded',
      amountKobo: PRICE,
      refundedKobo: PRICE + FEE,
    });
    // So does the hold's own route, for the fan.
    const hold = await holdOf(v.id);
    const route = body<{ refundedKobo: number; amountKobo: number }>(
      await h.get(fan, `/money/holds/${hold.id}`),
    ).data!;
    expect(route).toMatchObject({
      amountKobo: PRICE,
      refundedKobo: PRICE + FEE,
    });
    // The stored column stays the held price (a database rule); the move
    // that was made carries the figure the view reads.
    expect(hold.refundedKobo).toBe(BigInt(PRICE));
    expect(hold.transferKobo).toBe(BigInt(PRICE + FEE));
    await h.expectLedgerEqualsStandIn([fan, c]);
    await operationalAgrees();
  });

  it('the same request twice, and twice in parallel, holds the money once', async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    const q = await quoted(fan, c);
    const key = randomUUID();
    const both = await Promise.all([
      pay(fan, q, { key }),
      pay(fan, q, { key }),
    ]);
    expect(both.some((r) => r.status === 201)).toBe(true);
    expect(both.every((r) => r.status < 500)).toBe(true);
    expect(h.sendsFrom(fan)).toHaveLength(1);
    const again = await pay(fan, q, { key, pin: '0000' });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(h.sendsFrom(fan)).toHaveLength(1);
    expect(
      await h.prisma.directMessage.count({ where: { id: q.question.id } }),
    ).toBe(1);
    expect(
      await h.prisma.walletHold.count({
        where: { payment: { kind: 'paid_dm', targetId: q.question.id } },
      }),
    ).toBe(1);

    // Two taps with two keys: one payment, the other is told one is in progress or is already sent.
    const fan2 = await h.person(RICH);
    const c2 = await creator();
    h.nuvion.mode = 'pending';
    const q2 = await quoted(fan2, c2);
    const two = await Promise.all([pay(fan2, q2), pay(fan2, q2)]);
    expect(h.sendsFrom(fan2)).toHaveLength(1);
    expect(two.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      two.map(code).filter((x) => x === 'payment_in_progress'),
    ).toHaveLength(1);
    h.nuvion.settle(
      h.sendsFrom(fan2)[0].request.unique_reference,
      'successful',
    );
    await until(async () => {
      await h.pass();
      return (
        (await h.prisma.directMessage.count({
          where: { id: q2.question.id },
        })) === 1
      );
    }, 'the question to be sent');
    await h.pass();
    expect(h.sendsFrom(fan2)).toHaveLength(1);
    expect(
      await h.prisma.walletHold.count({
        where: { payment: { kind: 'paid_dm', targetId: q2.question.id } },
      }),
    ).toBe(1);
    await h.expectLedgerEqualsStandIn([fan, fan2, c, c2]);
  });

  it('one question waits per creator: a second draft cannot be paid, even at the same moment as the first', async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    // Two drafts made before either is paid.
    const a = await quoted(fan, c);
    const b = await quoted(fan, c);
    expect(a.question.id).not.toBe(b.question.id);
    const both = await Promise.all([pay(fan, a), pay(fan, b)]);
    expect(both.filter((r) => r.status === 201)).toHaveLength(1);
    expect(both.map(code)).toContain('question_already_waiting');
    expect(h.sendsFrom(fan)).toHaveLength(1);
    expect(
      await h.prisma.directMessage.count({
        where: { senderWawuId: fan.id, creatorWawuId: c.id },
      }),
    ).toBe(1);
    // Asking again while one waits is refused up front.
    const third = await ask(fan, c, 'And another?');
    expect(third.status).toBe(409);
    expect(code(third)).toBe('question_already_waiting');
    // Once it is answered the fan may ask again.
    const sent = await h.prisma.directMessage.findFirstOrThrow({
      where: { senderWawuId: fan.id },
    });
    await respond(c, sent.id);
    expect((await ask(fan, c, 'A follow-up?')).status).toBe(201);
    await h.expectLedgerEqualsStandIn([fan, c]);
  });

  it('a lost provider answer, then a retry, takes the money once and sends the question once', async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    const q = await quoted(fan, c);
    const key = randomUUID();
    h.nuvion.mode = 'timeout';
    const first = await pay(fan, q, { key });
    expect(first.status).toBe(201);
    expect(body<PaidQuestionWalletView>(first).data!.status).toBe('pending');
    expect(
      await h.prisma.directMessage.count({ where: { id: q.question.id } }),
    ).toBe(0);

    h.nuvion.mode = 'successful';
    const retry = await pay(fan, q, { key, pin: '0000' });
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(h.sendsFrom(fan)).toHaveLength(1);

    h.nuvion.settle(h.sendsFrom(fan)[0].request.unique_reference, 'successful');
    await until(async () => {
      await h.pass();
      return (
        (await h.prisma.directMessage.count({
          where: { id: q.question.id },
        })) === 1
      );
    }, 'the question to be sent');
    await h.pass();
    expect(h.sendsFrom(fan)).toHaveLength(1);
    expect(
      await h.prisma.notification.count({
        where: { userWawuId: c.id, kind: 'dm_received' },
      }),
    ).toBe(1);
    const read = body<PaidQuestionWalletView>(
      await h.get(fan, `/dm/send/wallet/${q.question.id}`),
    ).data!;
    expect(read.status).toBe('asked');
    expect(balance(fan)).toBe(BigInt(RICH - PRICE - FEE));
    await h.expectLedgerEqualsStandIn([fan, c]);
  });

  it('the creator answers or the window passes, never both: a release and a refund racing go one way only', async () => {
    // At the hold: both asked at once, one wins, the other is refused.
    const fan = await h.person(RICH);
    const c = await creator();
    const v = await asked(fan, c);
    const paymentId = (await messageOf(v.id)).flutterwaveTxRef.slice(7);
    const [rel, ref] = await Promise.allSettled([
      h.holds.release({ paymentId }),
      h.holds.refund({ paymentId }),
    ]);
    expect([rel.status, ref.status].sort()).toEqual(['fulfilled', 'rejected']);
    const lost =
      rel.status === 'rejected' ? rel : (ref as PromiseRejectedResult);
    expect(lost.reason).toBeInstanceOf(HoldRequestError);
    await until(async () => {
      await h.pass();
      return ['released', 'refunded'].includes((await holdOf(v.id)).status);
    }, 'the hold to settle');
    const only = (await holdOf(v.id)).action;
    expect(
      paidOut(c).length +
        h.nuvion
          .sendsFrom(h.nuvion.operational.accountId)
          .filter((t) => t.toAccountId === fan.account!.accountId).length,
    ).toBe(1);
    expect(['release', 'refund']).toContain(only);
    await h.expectLedgerEqualsStandIn([fan, c]);

    // At the question: the reply and the expiry sweep at the same instant.
    for (let round = 0; round < 4; round += 1) {
      const f = await h.person(RICH);
      const cr = await creator();
      const q = await asked(f, cr);
      // Open now for the reply; past for a sweep run two hours on.
      await setDeadline(q.id, new Date(Date.now() + HOUR));
      await Promise.all([
        respond(cr, q.id),
        questions.sweep(new Date(Date.now() + 2 * HOUR)),
      ]);
      const m = await messageOf(q.id);
      expect(['responded', 'refunded']).toContain(m.status);
      await until(async () => {
        await h.pass();
        await questions.sweep(new Date(Date.now() + 2 * HOUR));
        const hold = await holdOf(q.id);
        return ['released', 'refunded'].includes(hold.status);
      }, `round ${round}: the hold to settle`);
      const hold = await holdOf(q.id);
      expect(hold.action).toBe(m.status === 'responded' ? 'release' : 'refund');
      const toCreator = paidOut(cr).length;
      const toFan = h.nuvion
        .sendsFrom(h.nuvion.operational.accountId)
        .filter((t) => t.toAccountId === f.account!.accountId).length;
      expect([toCreator, toFan]).toEqual(
        m.status === 'responded' ? [1, 0] : [0, 1],
      );
      await h.expectLedgerEqualsStandIn([f, cr]);
      await operationalAgrees();
    }
  });

  it('a creator who is switched off, paused, blocked or yourself cannot be asked, and nothing is taken', async () => {
    const fan = await h.person(RICH);
    const off = await creator({ enabled: false });
    const r1 = await ask(fan, off);
    expect(r1.status).toBe(409);
    expect(code(r1)).toBe('target_not_payable');

    // Paused by the no-reply rule (INBOX-09): one missed question in the window.
    const paused = await creator();
    await h.prisma.directMessage.create({
      data: {
        creatorWawuId: paused.id,
        senderWawuId: randomUUID(),
        text: 'unanswered',
        amount: 1500,
        status: 'refunded',
        sentAt: new Date(Date.now() - 3 * HOUR),
        deadlineAt: new Date(Date.now() - HOUR),
        flutterwaveTxRef: `i17-${randomUUID()}`,
      },
    });
    const r2 = await ask(fan, paused);
    expect(r2.status).toBe(409);
    expect(code(r2)).toBe('target_not_payable');

    const own = await creator();
    const r3 = await ask(own, own);
    expect(r3.status).toBe(409);
    expect(code(r3)).toBe('target_not_payable');

    expect((await ask(fan, fan)).status).toBe(409);
    expect((await ask(fan, { id: randomUUID() } as PayPerson)).status).toBe(
      404,
    );
    const walletless = h.walletless();
    const r4 = await ask(walletless, await creator());
    expect(r4.status).toBe(409);
    expect(code(r4)).toBe('wallet_not_open');
    expect(h.sendsFrom(fan)).toHaveLength(0);
  });

  it('a creator who switches paid messages off before the debit confirms: the question is not sent and the payment returns whole', async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    const q = await quoted(fan, c);
    h.nuvion.mode = 'pending';
    const res = await pay(fan, q);
    expect(res.status).toBe(201);
    // The creator turns paid messages off while the debit is confirming.
    await h.prisma.creatorState.update({
      where: { wawuUserId: c.id },
      data: { dmEnabled: false },
    });
    h.nuvion.mode = 'successful';
    h.nuvion.settle(h.sendsFrom(fan)[0].request.unique_reference, 'successful');
    await until(async () => {
      await h.pass();
      const p = await h.prisma.walletPayment.findFirst({
        where: { kind: 'paid_dm', targetId: q.question.id },
        include: { hold: true },
      });
      return p?.hold?.status === 'refunded';
    }, 'the payment to be paid back');
    expect(
      await h.prisma.directMessage.count({ where: { id: q.question.id } }),
    ).toBe(0);
    // Nothing was asked of the creator, so the fan gets everything back.
    expect(balance(fan)).toBe(BigInt(RICH));
    expect(balance(c)).toBe(0n);
    const read = body<PaidQuestionWalletView>(
      await h.get(fan, `/dm/send/wallet/${q.question.id}`),
    ).data!;
    expect(read.status).toBe('refunded');
    await h.expectLedgerEqualsStandIn([fan, c]);
    await operationalAgrees();
  });

  it('a creator without a wallet keeps the share, and it lands the minute they open one (R-11)', async () => {
    const fan = await h.person(RICH);
    const c = h.walletless();
    await h.prisma.userProfile.create({
      data: {
        wawuUserId: c.id,
        accountType: 'creator',
        handle: `n${c.id.slice(0, 8)}`,
      },
    });
    await h.prisma.creatorState.create({
      data: { wawuUserId: c.id, dmPrice: PRICE / 100, dmEnabled: true },
    });
    creators.push(c.id);
    const v = await asked(fan, c);
    const sent0 = h.nuvion.sendsFrom(h.nuvion.operational.accountId).length;
    expect((await respond(c, v.id)).status).toBe(201);
    await h.pass();
    await h.pass();
    // The question is answered and the hold released as an earning; the
    // earning keeps owed, in WAWU's account, until a wallet exists.
    expect(await holdOf(v.id)).toMatchObject({
      status: 'released',
      action: 'release',
    });
    expect(await earningOf(v.id)).toMatchObject({
      status: 'owed',
      moveId: null,
      waiting: 'payee_wallet',
    });
    expect(h.nuvion.sendsFrom(h.nuvion.operational.accountId)).toHaveLength(
      sent0,
    );
    // Money waits for them, so deleting the account is not allowed yet.
    const deletion = new AccountDeletionMoneyService(h.nuvion, h.prisma);
    expect((await deletion.check(c.id)).blockers).toContain('waiting_earnings');

    // The wallet opens.
    const opened = await h.person(0);
    await h.prisma.fintavaWallet.update({
      where: { wawuUserId: opened.id },
      data: { wawuUserId: c.id },
    });
    await until(async () => {
      await h.pass();
      return (await earningOf(v.id)).status === 'landed';
    }, 'the share to land');
    expect(
      h.nuvion.accounts.get(opened.account!.accountId)!.availableKobo,
    ).toBe(BigInt(SHARE));
    await h.pass();
    expect(
      h.nuvion
        .sendsFrom(h.nuvion.operational.accountId)
        .filter((t) => t.toAccountId === opened.account!.accountId),
    ).toHaveLength(1);
  });

  it("two answers in a day land in the creator's one move, once; a later answer waits for the next day's (R-55)", async () => {
    const c = await creator();
    const fans = [
      await h.person(RICH),
      await h.person(RICH),
      await h.person(RICH),
    ];
    const qs: PaidQuestionWalletView[] = [];
    for (const f of fans) qs.push(await asked(f, c));
    const op0 = h.nuvion.operational.availableKobo;
    const sent0 = paidOut(c).length;

    // Two creators' answers before any sweep: both holds are released at
    // once, neither sends anything of its own.
    for (const q of qs.slice(0, 2))
      expect((await respond(c, q.id)).status).toBe(201);
    expect(paidOut(c)).toHaveLength(sent0);
    for (const q of qs.slice(0, 2)) {
      expect(await holdOf(q.id)).toMatchObject({
        status: 'released',
        transferKobo: null,
      });
      expect((await earningOf(q.id)).status).toBe('owed');
    }

    // The sweeps, run again and twice at once: ONE transfer carries both.
    await until(async () => {
      await h.pass();
      return (await earningOf(qs[0].id)).status === 'landed';
    }, "the day's move to land");
    await Promise.all([h.pass(), h.pass(), questions.sweep()]);
    await h.pass();
    expect(paidOut(c)).toHaveLength(sent0 + 1);
    expect(paidOut(c)[sent0].request.amount).toBe(2 * SHARE);
    expect(balance(c)).toBe(BigInt(2 * SHARE));
    const first = await earningOf(qs[0].id);
    const second = await earningOf(qs[1].id);
    expect(first.moveId).not.toBeNull();
    expect(second.moveId).toBe(first.moveId);
    expect(
      await h.prisma.earningMove.count({ where: { payeeWawuUserId: c.id } }),
    ).toBe(1);
    // WAWU's account paid out the two shares and the charge ONCE for the move
    // (not once per answer); the 15% of each stayed in it.
    expect(h.nuvion.operational.availableKobo - op0).toBe(
      -(BigInt(2 * SHARE) + BigInt(FEE)),
    );

    // A third answer the same day: its earning waits for the next day's move.
    expect((await respond(c, qs[2].id)).status).toBe(201);
    await h.pass();
    await h.pass();
    expect((await earningOf(qs[2].id)).status).toBe('owed');
    expect(paidOut(c)).toHaveLength(sent0 + 1);
    await until(async () => {
      await h.pass(24 * HOUR);
      return (await earningOf(qs[2].id)).status === 'landed';
    }, "the next day's move to land");
    expect(paidOut(c)).toHaveLength(sent0 + 2);
    expect(paidOut(c)[sent0 + 1].request.amount).toBe(SHARE);
    expect(balance(c)).toBe(BigInt(3 * SHARE));
    await h.expectLedgerEqualsStandIn([...fans, c]);
    await operationalAgrees();
  });

  it("a wrong PIN, a short balance, someone else's question and a changed price move nothing", async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    const q = await quoted(fan, c);
    const bad = await pay(fan, q, { pin: '1111' });
    expect(bad.status).toBe(403);
    expect(code(bad)).toBe('pin_incorrect');
    expect(h.sendsFrom(fan)).toHaveLength(0);

    const poor = await h.person(1_000);
    const pq = await quoted(poor, c);
    const short = await pay(poor, pq);
    expect(short.status).toBe(402);
    expect(code(short)).toBe('insufficient_funds');

    const other = await h.person(RICH);
    const stolen = await pay(other, q);
    expect(stolen.status).toBe(404);
    expect(h.sendsFrom(other)).toHaveLength(0);

    // The creator changes the price after the quote.
    await h.prisma.creatorState.update({
      where: { wawuUserId: c.id },
      data: { dmPrice: 2000 },
    });
    const stale = await pay(fan, q);
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('quote_changed');
    expect(h.sendsFrom(fan)).toHaveLength(0);
    await h.prisma.creatorState.update({
      where: { wawuUserId: c.id },
      data: { dmPrice: PRICE / 100 },
    });
    expect((await pay(fan, q)).status).toBe(201);
    await h.expectLedgerEqualsStandIn([fan, poor, other]);
  });

  it('the same Idempotency-Key and question draft once; another question under it is a reuse', async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    const key = randomUUID();
    const a = await ask(fan, c, 'Same?', key);
    const b = await ask(fan, c, 'Same?', key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(body<PaidQuestionQuoteView>(b).data!.question.id).toBe(
      body<PaidQuestionQuoteView>(a).data!.question.id,
    );
    const other = await ask(fan, c, 'Different?', key);
    expect(other.status).toBe(409);
    expect(code(other)).toBe('idempotency_key_reused');
    expect(
      await h.prisma.paidDmDraft.count({ where: { senderWawuId: fan.id } }),
    ).toBe(1);
    expect(PAY_PIN).toHaveLength(4);
  });

  it('I3 "Usually replies in": the quote carries the creator\'s usual reply time, and nothing until they have answered enough (G-146)', async () => {
    const fan = await h.person(RICH);
    const c = await creator();
    const first = await quoted(fan, c);
    expect(first.question.usualReplyMinutes).toBeNull();
    // Three answered questions, 30, 60 and 90 minutes to answer: the median is 60.
    for (const minutes of [30, 60, 90]) {
      const respondedAt = new Date(Date.now() - 5 * 60_000);
      const sentAt = new Date(respondedAt.getTime() - minutes * 60_000);
      await h.prisma.directMessage.create({
        data: {
          creatorWawuId: c.id,
          senderWawuId: fan.id,
          text: 'Earlier question',
          amount: PRICE / 100,
          status: 'responded',
          sentAt,
          deadlineAt: new Date(sentAt.getTime() + 24 * HOUR),
          respondedAt,
          responseText: 'Answered.',
          flutterwaveTxRef: `i17-usual-${randomUUID()}`,
        },
      });
    }
    const again = await quoted(fan, c);
    expect(again.question.usualReplyMinutes).toBe(60);
    // The reopened sheet reads the same figure.
    const reopened = await h.get(
      fan,
      `/dm/send/wallet/${again.question.id}/quote`,
    );
    expect(
      body<PaidQuestionQuoteView>(reopened).data!.question.usualReplyMinutes,
    ).toBe(60);
  });
});
