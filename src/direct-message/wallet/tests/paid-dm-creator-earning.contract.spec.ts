import {
  bootPayApp,
  type PayHarness,
  type PayPerson,
} from '../../../../test/payments/wallet-pay-harness';
import { body, until } from '../../../../test/payments/poll-helpers';
import { PaidDmWalletModule } from '../paid-dm-wallet.module';
import { PaidDmWalletService } from '../paid-dm-wallet.service';
import type {
  PaidQuestionQuoteView,
  PaidQuestionWalletView,
} from '../paid-dm-wallet-view.type';
import type {
  PaidDmQuestion,
  PaidDmQueuePage,
  PaidDmThreadDetail,
  PaidDmWaiting,
} from '../../paid-dm-view.type';

/**
 * INBOX-18 on the Nuvion stand-in: what the creator's screens read. The
 * waiting list's figures cover every waiting question, a question carries the
 * creator's share and where it is (pending, on its way, waiting for a wallet,
 * in the wallet), the fan never reads it, an answer after the window is
 * refused in the Hub's words and the fan is repaid every naira. Nothing here
 * is a balance: the ledger agrees with the stand-in after each.
 */

jest.setTimeout(240_000);

const PRICE = 150_000; // ₦1,500
const SHARE = 127_500; // 85% (R-5)
const RICH = 50_000_000;
const HOUR = 3_600_000;

describe('The creator answers a paid question (INBOX-18), Nuvion stood in', () => {
  let h: PayHarness;
  let questions: PaidDmWalletService;
  const creators: string[] = [];

  beforeAll(async () => {
    h = await bootPayApp('i18', {
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
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.nuvion.mode = 'successful';
  });

  async function makeCreator(person?: PayPerson): Promise<PayPerson> {
    const c = person ?? (await h.person(0));
    await h.prisma.userProfile.create({
      data: {
        wawuUserId: c.id,
        accountType: 'creator',
        handle: `c${c.id.slice(0, 8)}`,
      },
    });
    await h.prisma.creatorState.create({
      data: { wawuUserId: c.id, dmPrice: PRICE / 100, dmEnabled: true },
    });
    creators.push(c.id);
    return c;
  }
  async function asked(
    fan: PayPerson,
    c: PayPerson,
    text = 'How do I price a logo for a bank?',
  ): Promise<PaidQuestionWalletView> {
    const q = body<PaidQuestionQuoteView>(
      await h.post(fan, `/dm/${c.id}/send/wallet`, { text }, { pin: null }),
    ).data!;
    const res = await h.post(
      fan,
      '/dm/send/wallet/pay',
      {
        questionId: q.question.id,
        expectedTotalKobo: q.payment.totalKobo,
        quoteToken: q.payment.quoteToken,
      },
      {},
    );
    expect(res.status).toBe(201);
    return body<PaidQuestionWalletView>(res).data!;
  }
  const reply = (
    c: PayPerson,
    id: string,
    text = 'Price the use, not the file.',
  ) => h.post(c, `/paid-dm/questions/${id}/replies`, { text }, { pin: null });
  const thread = async (
    reader: PayPerson,
    other: PayPerson,
    as: 'creator' | 'fan',
  ) =>
    body<PaidDmThreadDetail>(
      await h.get(reader, `/paid-dm/threads/${other.id}?as=${as}`),
    ).data!;
  const earningOf = async (id: string) => {
    const m = await h.prisma.directMessage.findUniqueOrThrow({ where: { id } });
    return h.prisma.earningSettlement.findUniqueOrThrow({
      where: { paymentId: m.flutterwaveTxRef.slice('wallet:'.length) },
    });
  };
  const balance = (p: PayPerson) =>
    h.nuvion.accounts.get(p.account!.accountId)!.availableKobo;

  it('I9: the waiting figures cover every waiting question; the list is soonest first', async () => {
    const c = await makeCreator();
    const fanA = await h.person(RICH);
    const fanB = await h.person(RICH);
    const first = await asked(fanA, c, 'First, a long way off');
    const second = await asked(fanB, c, 'Second, sooner');
    await h.prisma.directMessage.update({
      where: { id: second.id },
      data: { deadlineAt: new Date(Date.now() + HOUR) },
    });
    expect(
      body<PaidDmWaiting>(await h.get(c, '/paid-dm/waiting')).data,
    ).toEqual({ count: 2, amountKobo: 2 * PRICE });
    const page = body<PaidDmQueuePage>(
      await h.get(c, '/paid-dm/queue?limit=1'),
    ).data!;
    // One question on this page, the figures above it are for both.
    expect(page.items.map((i) => i.id)).toEqual([second.id]);
    expect(page.waitingTotal).toBe(2);
    // A plain account has no waiting list.
    expect((await h.get(fanA, '/paid-dm/waiting')).status).toBe(403);
    // An answered question leaves the figures.
    expect((await reply(c, first.id)).status).toBe(201);
    expect(
      body<PaidDmWaiting>(await h.get(c, '/paid-dm/waiting')).data,
    ).toEqual({ count: 1, amountKobo: PRICE });
  });

  it('I10, I11: the creator reads the share and where it is; the fan reads none; the share lands in the wallet once', async () => {
    const fan = await h.person(RICH);
    const c = await makeCreator();
    const v = await asked(fan, c);

    const before = (await thread(c, fan, 'creator')).questions[0];
    expect(before).toMatchObject({
      id: v.id,
      status: 'awaiting_response',
      amountKobo: PRICE,
      creatorEarning: { amountKobo: SHARE, sharePct: 85, state: 'pending' },
    });
    expect(
      (await thread(fan, c, 'fan')).questions[0].creatorEarning,
    ).toBeNull();

    const res = await reply(c, v.id);
    expect(res.status).toBe(201);
    const answered = body<PaidDmQuestion>(res).data!;
    expect(answered).toMatchObject({
      status: 'responded',
      creatorEarning: { amountKobo: SHARE, sharePct: 85, state: 'on_its_way' },
    });
    expect(answered.respondedAt).not.toBeNull();
    expect(
      (await thread(fan, c, 'fan')).questions[0].creatorEarning,
    ).toBeNull();

    // A second bubble is only a bubble: one earning, the same share.
    expect((await reply(c, v.id, 'And ask for half up front.')).status).toBe(
      201,
    );
    expect(
      await h.prisma.earningSettlement.count({
        where: { payeeWawuUserId: c.id },
      }),
    ).toBe(1);

    await until(async () => {
      await h.pass();
      return (await earningOf(v.id)).status === 'landed';
    }, "the earning to land in the creator's move");
    const landed = (await thread(c, fan, 'creator')).questions[0];
    expect(landed.creatorEarning).toEqual({
      amountKobo: SHARE,
      sharePct: 85,
      state: 'in_wallet',
    });
    expect(landed.replies).toHaveLength(2);
    expect(balance(c)).toBe(BigInt(SHARE));
    await h.expectLedgerEqualsStandIn([fan, c]);
  });

  it('a creator without a wallet reads that the share waits for one (R-11)', async () => {
    const fan = await h.person(RICH);
    const c = await makeCreator(h.walletless());
    const v = await asked(fan, c);
    expect((await reply(c, v.id)).status).toBe(201);
    await h.pass();
    expect(
      (await thread(c, fan, 'creator')).questions[0].creatorEarning,
    ).toEqual({ amountKobo: SHARE, sharePct: 85, state: 'waiting_for_wallet' });
  });

  it('an answer after the window is refused in the Hub words, and the fan is repaid every naira', async () => {
    const fan = await h.person(RICH);
    const c = await makeCreator();
    const v = await asked(fan, c);
    await h.prisma.directMessage.update({
      where: { id: v.id },
      data: { deadlineAt: new Date(Date.now() - 1000) },
    });
    const late = await reply(c, v.id);
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.body)).toContain('response window');
    expect(JSON.stringify(late.body)).toContain('has passed');
    await until(async () => {
      await h.pass();
      await questions.sweep();
      const m = await h.prisma.directMessage.findUniqueOrThrow({
        where: { id: v.id },
      });
      return m.refundStatus === 'settled';
    }, 'the refund to be confirmed');
    expect(balance(fan)).toBe(BigInt(RICH));
    const row = (await thread(c, fan, 'creator')).questions[0];
    expect(row.status).toBe('refunded');
    expect(row.creatorEarning).toBeNull();
    expect(row.replies).toEqual([]);
    // Answering it now is refused as already settled, and earns nothing.
    const again = await reply(c, v.id);
    expect(again.status).toBe(409);
    expect(
      await h.prisma.earningSettlement.count({
        where: { payeeWawuUserId: c.id },
      }),
    ).toBe(0);
    await h.expectLedgerEqualsStandIn([fan, c]);
  });
});
