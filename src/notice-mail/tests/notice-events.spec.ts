/* eslint-disable @typescript-eslint/require-await -- stand-ins for async services */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { WawuIdNoticeDouble } from '../../../test/money/wawu-id-notice-double';
import { AccountDeletionSweepService } from '../../account/account-deletion-sweep.service';
import { AccountService } from '../../account/account.service';
import { BillPaymentService } from '../../bill-payment/bill-payment.service';
import { EventTicketingService } from '../../event-ticketing/event-ticketing.service';
import { EventCallOffRefundService } from '../../event-ticketing/wallet/event-call-off-refund.service';
import { EventWalletOrderService } from '../../event-ticketing/wallet/event-wallet-order.service';
import { UnlockWalletService } from '../../content-piece/wallet/unlock-wallet.service';
import { MoneyInNoticeService } from '../../money/money-in-notice/money-in-notice.service';
import { PinResetService } from '../../money/pin/pin-reset.service';
import { TransactionPinService } from '../../money/pin/transaction-pin.service';
import { WalletTransferService } from '../../money/transfers/wallet-transfer.service';
import type { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { StoreQuestionService } from '../../store/question/store-question.service';
import { StoreSaleNoticeService } from '../../store/notice/store-sale-notice.service';
import { NoticeFacts } from '../notice-facts';
import { MONEY_EMAILS_SWITCH, NoticeMailer } from '../notice-mailer';

/**
 * Each notice at its real event (EMAIL-02): the real service code, with its
 * database and neighbours stood in, and a real NoticeMailer talking to a
 * stand-in for WAWU ID's notice route. Every notice is asked once, with the
 * facts of the Hub's own rows, only after the move has committed, also when
 * the same event is seen twice or by two callers at once; a move that rolls
 * back sends none; the relay being down does not change what the money path
 * does; the switch off sends none; and nothing that leaves is an address or
 * markup.
 */

const double = new WawuIdNoticeDouble();
let env: Record<string, string | undefined> = {};
let switchOn = 1;
let errors: string[] = [];

const config = { get: (k: string) => env[k] } as unknown as ConfigService;
const settings = {
  number: (k: string) => {
    if (k !== MONEY_EMAILS_SWITCH) throw new Error('unknown setting');
    return switchOn;
  },
} as unknown as PlanSettingsService;

function mailer(): NoticeMailer {
  return new NoticeMailer(config, settings);
}

/** Facts without the database or WAWU ID. */
function factsFor(over: Partial<Record<keyof NoticeFacts, unknown>> = {}) {
  return {
    payment: async () => ({
      priceKobo: 100_000,
      totalKobo: 106_500,
      payeeShareKobo: 85_000,
      reference: 'WAWU-PAY-1',
    }),
    nameOf: async (id: string | null) => (id ? 'Ada O.' : null),
    paidWhen: async () => 'now',
    ...over,
  } as unknown as NoticeFacts;
}

const priv = <T>(o: unknown) => o as T;

beforeAll(async () => {
  await double.start();
  jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((m: unknown) => void errors.push(String(m)));
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await double.stop();
});
beforeEach(() => {
  double.reset();
  errors = [];
  switchOn = 1;
  env = {
    WAWU_ID_BASE_URL: double.baseUrl,
    WAWU_ID_INTERNAL_SERVICE_KEY: double.serviceKey,
    NOTICE_MAIL_RETRY_MS: '5',
  };
});

/** What leaves the Hub never holds an address or markup, for any kind. */
function expectNoAddressOrMarkup(): void {
  for (const r of double.requests) {
    expect(r.raw).not.toMatch(/[<>]/);
    expect(r.raw).not.toMatch(/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i);
    expect(Object.keys(r.body).sort()).toEqual([
      'data',
      'idempotencyKey',
      'kind',
      'wawuId',
    ]);
  }
}

describe('pin_changed (money/pin)', () => {
  const dto = { newPin: '4829', newPinConfirmation: '4829' };
  const row = (setAt: Date) => ({
    wawuUserId: 'user-pin-1',
    pinHash: 'x',
    failedTries: 0,
    lockedUntil: null,
    setAt,
  });

  function pinService(mail: NoticeMailer, commit: () => Promise<void>) {
    const tx = {
      $queryRaw: async () => [],
      transactionPin: { update: async () => row(new Date(Date.now())) },
      transactionPinReset: { updateMany: async () => ({ count: 0 }) },
    };
    const prisma = {
      $transaction: async (cb: (t: unknown) => Promise<unknown>) => {
        const out = await cb(tx);
        await commit();
        return out;
      },
    };
    return new TransactionPinService(prisma as never, config, mail);
  }

  it('is asked once, after the PIN is committed, with the time it was set', async () => {
    const mail = mailer();
    let during = -1;
    const svc = pinService(mail, async () => {
      await mail.settled();
      during = double.requests.length;
    });
    const view = await svc.change('user-pin-1', dto);
    await mail.settled();
    expect(during).toBe(0);
    expect(double.sent).toHaveLength(1);
    expect(double.sent[0].body.kind).toBe('pin_changed');
    expect(double.sent[0].body.wawuId).toBe('user-pin-1');
    expect(double.sent[0].body.data).toEqual({ at: view.changedAt });
    expectNoAddressOrMarkup();
  });

  it('sends nothing when the change rolls back', async () => {
    const mail = mailer();
    const svc = pinService(mail, async () => {
      throw new Error('rolled back');
    });
    await expect(svc.change('user-pin-2', dto)).rejects.toThrow();
    await mail.settled();
    expect(double.requests).toHaveLength(0);
  });

  it('a reset that confirms is asked once, keyed by the reset itself', async () => {
    const mail = mailer();
    const codeHash = await argon2.hash('123456', { type: argon2.argon2id });
    const tx = {
      $queryRaw: async () => [],
      transactionPinReset: { updateMany: async () => ({ count: 1 }) },
      transactionPin: {
        updateMany: async () => ({ count: 1 }),
        findUniqueOrThrow: async () => row(new Date()),
      },
      approvalDevice: { deleteMany: async () => ({ count: 0 }) },
      approvalChallenge: { deleteMany: async () => ({ count: 0 }) },
    };
    const prisma = {
      $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    };
    const svc = new PinResetService(
      prisma as never,
      {} as never,
      {} as never,
      mail,
    );
    Object.assign(svc, {
      claimTry: async () => ({
        id: 'reset-id-0001',
        codeHash,
        failedTries: 0,
      }),
    });
    await svc.confirm('user-pin-3', {
      resetId: 'reset-id-0001',
      code: '123456',
      ...dto,
    });
    await mail.settled();
    expect(double.sent.map((r) => r.body.kind)).toEqual(['pin_changed']);
    expect(double.sent[0].body.idempotencyKey).toBe(
      'pin_changed-reset-reset-id-0001',
    );
  });
});

describe('account_deletion_started and account_deleted (account)', () => {
  it('the request that schedules it is told once; the one that finds it scheduled is not', async () => {
    const mail = mailer();
    const svc = Object.create(AccountService.prototype) as AccountService;
    const calls: boolean[] = [];
    const statuses = ['freezing', 'scheduled'];
    Object.assign(svc, {
      mail,
      prisma: {
        $transaction: async (cb: (t: unknown) => Promise<unknown>) =>
          cb({
            $queryRaw: async () => [{ status: statuses.shift() }],
            accountDeletion: {
              count: async () => 1,
              updateMany: async () => ({ count: 1 }),
              findUnique: async () => ({
                purgeAfter: new Date('2026-11-28T00:00:00Z'),
              }),
            },
          }),
      },
      hideContent: async () => undefined,
    });
    const when = {
      frozen: true,
      scheduledAt: new Date('2026-10-29T00:00:00Z'),
      purgeAfter: new Date('2026-11-28T00:00:00Z'),
    };
    const a = await priv<{
      promote: (id: string, f: typeof when) => Promise<{ fresh?: boolean }>;
    }>(svc).promote('user-del-1', when);
    const b = await priv<{
      promote: (id: string, f: typeof when) => Promise<{ fresh?: boolean }>;
    }>(svc).promote('user-del-1', when);
    calls.push(a.fresh === true, b.fresh === true);
    expect(calls).toEqual([true, false]);
  });

  it('account_deleted is asked and waited for BEFORE WAWU ID anonymises the account', async () => {
    const mail = mailer();
    const order: string[] = [];
    const svc = Object.create(
      AccountDeletionSweepService.prototype,
    ) as AccountDeletionSweepService;
    Object.assign(svc, {
      mail,
      prisma: {
        pointHold: { findMany: async () => [] },
        accountDeletion: { updateMany: async () => ({ count: 1 }) },
      },
      points: { release: async () => undefined },
      purgeService: {
        purge: async () => ({
          pointsLeft: false,
          failed: [],
          keptForBuyers: 0,
          files: { ownerKept: 0, eventKept: 0 },
        }),
      },
      wawuId: {
        finalizeAccountDeletion: async () => {
          order.push(`anonymise after ${double.sent.length} asked`);
        },
      },
    });
    const out = await priv<{
      purgeSteps: (r: unknown, n: Date, g: unknown) => Promise<string>;
    }>(svc).purgeSteps(
      {
        wawuUserId: 'user-del-2',
        status: 'purging',
        purgeAttempts: 0,
        identityMarkedAt: new Date(),
      },
      new Date(),
      { saw: () => undefined },
    );
    expect(out).toBe('purged');
    expect(order).toEqual(['anonymise after 1 asked']);
    expect(double.sent[0].body).toMatchObject({
      wawuId: 'user-del-2',
      kind: 'account_deleted',
      data: {},
    });
  });
});

describe('money_in (the money-in notice)', () => {
  function service(row: Record<string, unknown> | null, markFails = false) {
    const tx = {
      $queryRaw: async () => (row ? [{ id: 'row-1' }] : []),
      fintavaLedgerEntry: { findFirst: async () => row },
      moneyInNotice: {
        create: async () => {
          if (markFails)
            throw Object.assign(new Error('dup'), { code: 'P2002' });
        },
      },
    };
    const prisma = {
      $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    };
    const notifications = {
      isSwitchOff: async () => false,
      emit: async () => ({ id: 'note-1' }),
    };
    return new MoneyInNoticeService(
      prisma as never,
      { name: 'nuvion' } as never,
      notifications as never,
      config,
      mailer(),
    );
  }
  const bank = {
    wawuUserId: 'user-in-1',
    amountKobo: 500_000n,
    category: 'top_up',
    linkKind: null,
    counterpartyKind: 'bank_account',
    counterpartyName: 'Ada <b>Obi</b>',
    counterpartyAccountNumber: '0123456789',
    counterpartyBankName: 'Access Bank',
  };

  it('a credit from a bank is asked once with its amount and the sender name; no account number leaves', async () => {
    const svc = service(bank);
    const mail = priv<{ mail: NoticeMailer }>(svc).mail;
    expect(await svc.noticeEntry('row-1')).toBe('sent');
    await mail.settled();
    expect(double.sent).toHaveLength(1);
    expect(double.sent[0].body.data).toEqual({
      amountMinor: 500_000,
      currency: 'NGN',
      senderName: 'Ada b Obi /b',
    });
    expect(double.sent[0].raw).not.toContain('0123456789');
    expect(double.sent[0].body.idempotencyKey).toBe('money_in-row-1');
    expectNoAddressOrMarkup();
  });

  it('seen twice (the mark exists) it is not asked again', async () => {
    const svc = service(bank, true);
    const mail = priv<{ mail: NoticeMailer }>(svc).mail;
    expect(await svc.noticeEntry('row-1')).toBe('skipped');
    await mail.settled();
    expect(double.requests).toHaveLength(0);
  });

  it('earnings landing and refunds have their own emails, so money_in is not sent for them', async () => {
    const svc = service({
      ...bank,
      category: 'earning',
      counterpartyKind: null,
    });
    const mail = priv<{ mail: NoticeMailer }>(svc).mail;
    expect(await svc.noticeEntry('row-1')).toBe('sent');
    await mail.settled();
    expect(double.requests).toHaveLength(0);
  });
});

describe('bank_send_completed and bank_send_failed (the payout, its final state)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'transfer-0001',
    kind: 'bank_account',
    status: 'completed',
    payerWawuUserId: 'user-bank-1',
    amountKobo: 1_000_000n,
    providerFeeKobo: 4_000n,
    wawuFeeKobo: 2_500n,
    totalKobo: 1_006_500n,
    bankAccountName: 'Ada Obi',
    bankName: 'Access Bank',
    bankAccountNumber: '0123456789',
    customerReference: 'WAWU-TR-1',
    ...over,
  });

  function transferService(mail: NoticeMailer, counts: number[]) {
    const svc = Object.create(
      WalletTransferService.prototype,
    ) as WalletTransferService;
    Object.assign(svc, {
      mail,
      prisma: {
        walletTransfer: {
          updateMany: async () => ({ count: counts.shift() ?? 0 }),
          findUniqueOrThrow: async () => row({ status: 'failed' }),
        },
      },
    });
    return svc;
  }
  const transition = (svc: unknown, status: string) =>
    priv<{
      transition: (t: unknown, s: string, d: unknown) => Promise<unknown>;
    }>(svc).transition(row({ status: 'pending' }), status, {});

  it('a completed bank send tells the fee taken (provider and WAWU), the last 4 digits and no account number', () => {
    const mail = mailer();
    const svc = transferService(mail, []);
    priv<{ tellEnded: (r: unknown, h: string) => void }>(svc).tellEnded(
      row(),
      'completed',
    );
    return mail.settled().then(() => {
      expect(double.sent[0].body.data).toEqual({
        amountMinor: 1_000_000,
        feeMinor: 6_500,
        currency: 'NGN',
        recipientName: 'Ada Obi',
        bankName: 'Access Bank',
        accountLast4: '6789',
        reference: 'WAWU-TR-1',
      });
      expect(double.sent[0].raw).not.toContain('0123456789');
      expect(double.sent[0].body.idempotencyKey).toBe(
        'bank_send_completed-transfer-0001',
      );
    });
  });

  it('a failed send is asked once, even when two callers race it (only the one that moved it tells)', async () => {
    const mail = mailer();
    const svc = transferService(mail, [1, 0]);
    await Promise.all([transition(svc, 'failed'), transition(svc, 'failed')]);
    await mail.settled();
    // The Hub asks once (not twice and left to WAWU ID to fold).
    expect(double.requests).toHaveLength(1);
    expect(double.sent).toHaveLength(1);
    expect(double.sent[0].body).toMatchObject({
      kind: 'bank_send_failed',
      data: {
        amountMinor: 1_000_000,
        returnedMinor: 1_006_500,
        currency: 'NGN',
        reference: 'WAWU-TR-1',
      },
    });
  });

  it('a reversed send is told as failed; a send to another WAWU user is not emailed', async () => {
    const mail = mailer();
    const svc = transferService(mail, [1]);
    await transition(svc, 'reversed');
    priv<{ tellEnded: (r: unknown, h: string) => void }>(svc).tellEnded(
      row({ kind: 'wawu_user', id: 'transfer-0002' }),
      'completed',
    );
    await mail.settled();
    expect(double.sent.map((r) => r.body.kind)).toEqual(['bank_send_failed']);
  });
});

describe('sale_made and tip_received (a store sale)', () => {
  function notices(mail: NoticeMailer, paidWhen = 'in_3_working_days') {
    const notifications = { emitOrThrow: async () => undefined };
    return new StoreSaleNoticeService(
      notifications as never,
      mail,
      factsFor({ paidWhen: async () => paidWhen }),
    );
  }
  const sale = {
    purchaseId: 'purchase-0001',
    creatorWawuId: 'user-creator-1',
    buyerWawuId: 'user-buyer-1',
    targetId: 'piece-1',
    title: 'My <i>song</i>',
    listPriceKobo: 100_000,
  };

  it('a piece sold in the store tells the creator 85% of the list price and the waiting days, after the commit', async () => {
    const mail = mailer();
    let during = -1;
    await mail.within(async () => {
      await notices(mail).told({} as never, { ...sale, kind: 'content' });
      await mail.settled();
      during = double.requests.length;
    });
    await mail.settled();
    expect(during).toBe(0);
    expect(double.sent).toHaveLength(1);
    expect(double.sent[0].body).toMatchObject({
      wawuId: 'user-creator-1',
      kind: 'sale_made',
      data: {
        itemTitle: 'My i song /i',
        buyerName: 'Ada O.',
        earnedMinor: 85_000,
        currency: 'NGN',
        paidWhen: 'in_3_working_days',
      },
    });
    expectNoAddressOrMarkup();
  });

  it('a creator with no wallet is told the money waits for the wallet (R-11)', async () => {
    const mail = mailer();
    await mail.within(() =>
      notices(mail, 'when_wallet_opens').told({} as never, {
        ...sale,
        kind: 'tip',
      }),
    );
    await mail.settled();
    expect(double.sent[0].body).toMatchObject({
      kind: 'tip_received',
      data: {
        earnedMinor: 85_000,
        paidWhen: 'when_wallet_opens',
        fromName: 'Ada O.',
      },
    });
  });

  it('a sale that rolls back sends none; a pass or an answered question sends none here', async () => {
    const mail = mailer();
    await expect(
      mail.within(async () => {
        await notices(mail).told({} as never, { ...sale, kind: 'content' });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow();
    await mail.within(async () => {
      await notices(mail).told(
        { community: { findUnique: async () => null } } as never,
        { ...sale, kind: 'pass' },
      );
      await notices(mail).told({} as never, { ...sale, kind: 'question' });
    });
    await mail.settled();
    expect(double.requests).toHaveLength(0);
  });

  it('the same sale told twice is one email at WAWU ID (same key)', async () => {
    const mail = mailer();
    await mail.within(async () => {
      await notices(mail).told({} as never, { ...sale, kind: 'content' });
      await notices(mail).told({} as never, { ...sale, kind: 'content' });
    });
    await mail.settled();
    expect(double.requests).toHaveLength(2);
    expect(double.sent).toHaveLength(1);
  });
});

describe('sale_made and purchase_receipt (a wallet sale), ticket_confirmed, refund_processed, event_cancelled, bill_paid', () => {
  it('a wallet sale tells the creator and gives the buyer a receipt, from the payment row', async () => {
    const mail = mailer();
    const svc = Object.create(
      UnlockWalletService.prototype,
    ) as UnlockWalletService;
    Object.assign(svc, {
      mail,
      facts: factsFor(),
      prisma: {
        contentPiece: { findUnique: async () => ({ title: 'A song' }) },
      },
    });
    priv<{ emailSale: (p: unknown, c: string) => void }>(svc).emailSale(
      {
        paymentId: 'pay-0000001',
        payerWawuUserId: 'user-buyer-2',
        targetId: 'piece-2',
      },
      'user-creator-2',
    );
    await mail.settled();
    const by = Object.fromEntries(
      double.sent.map((r) => [r.body.kind, r.body]),
    );
    expect(by.sale_made).toMatchObject({
      wawuId: 'user-creator-2',
      data: {
        itemTitle: 'A song',
        earnedMinor: 85_000,
        paidWhen: 'now',
        currency: 'NGN',
      },
    });
    expect(by.purchase_receipt).toMatchObject({
      wawuId: 'user-buyer-2',
      data: {
        itemTitle: 'A song',
        paidMinor: 100_000,
        reference: 'WAWU-PAY-1',
      },
    });
  });

  it('a ticket is confirmed once with the event, the time, the place and what was paid', async () => {
    const mail = mailer();
    const svc = Object.create(
      EventWalletOrderService.prototype,
    ) as EventWalletOrderService;
    Object.assign(svc, { mail, facts: factsFor() });
    const order = {
      id: 'order-0001',
      buyerWawuId: 'user-buyer-3',
      event: {
        name: 'Lagos Night',
        startsAt: new Date('2026-12-01T18:00:00Z'),
        venueName: null,
        location: 'Lagos',
      },
    };
    priv<{ emailTicket: (o: unknown, p: unknown) => void }>(svc).emailTicket(
      order,
      { paymentId: 'pay-0000002' },
    );
    await mail.settled();
    expect(double.sent[0].body).toMatchObject({
      wawuId: 'user-buyer-3',
      kind: 'ticket_confirmed',
      data: {
        eventTitle: 'Lagos Night',
        startsAt: '2026-12-01T18:00:00.000Z',
        place: 'Lagos',
        paidMinor: 106_500,
        currency: 'NGN',
        ticketRef: 'WAWU-PAY-1',
      },
    });
  });

  it('a called-off event tells each buyer once with what is coming back; a free ticket has no sum', async () => {
    const mail = mailer();
    const svc = Object.create(
      EventTicketingService.prototype,
    ) as EventTicketingService;
    Object.assign(svc, {
      mail,
      prisma: {
        eventOrder: {
          findMany: async () => [
            { buyerWawuId: 'user-a-0001', amountNaira: 1500 },
            { buyerWawuId: 'user-a-0001', amountNaira: 500 },
            { buyerWawuId: 'user-b-0001', amountNaira: 0 },
          ],
        },
      },
    });
    priv<{ emailCalledOff: (e: string, t: string) => void }>(
      svc,
    ).emailCalledOff('event-0001', 'Lagos Night');
    await mail.settled();
    const byWho = Object.fromEntries(
      double.sent.map((r) => [r.body.wawuId, r.body.data]),
    );
    expect(byWho['user-a-0001']).toEqual({
      eventTitle: 'Lagos Night',
      refundMinor: 200_000,
      currency: 'NGN',
    });
    expect(byWho['user-b-0001']).toEqual({
      eventTitle: 'Lagos Night',
      refundMinor: null,
      currency: null,
    });
  });

  it('a called-off wallet order refund is told once, by the call that marked it', async () => {
    const mail = mailer();
    const svc = Object.create(
      EventCallOffRefundService.prototype,
    ) as EventCallOffRefundService;
    const counts = [1, 0];
    Object.assign(svc, {
      mail,
      facts: factsFor(),
      prisma: {
        $transaction: async () => [{ count: counts.shift() }, { count: 1 }],
        eventTicket: { updateMany: async () => ({ count: 1 }) },
        eventOrder: {
          updateMany: async () => ({ count: 1 }),
          findUnique: async () => ({
            buyerWawuId: 'user-buyer-4',
            walletPaymentId: 'pay-0000003',
            event: { name: 'Lagos Night' },
          }),
        },
      },
    });
    const mark = (id: string) =>
      priv<{ markRefunded: (o: string) => Promise<void> }>(svc).markRefunded(
        id,
      );
    await Promise.all([mark('order-0002'), mark('order-0002')]);
    await mail.settled();
    expect(double.requests).toHaveLength(1);
    expect(double.sent).toHaveLength(1);
    expect(double.sent[0].body).toMatchObject({
      kind: 'refund_processed',
      data: {
        what: 'Lagos Night',
        amountMinor: 106_500,
        currency: 'NGN',
        returnedTo: 'wallet',
      },
    });
  });

  it('an unanswered store question gives a question credit and says so, after the commit', async () => {
    const mail = mailer();
    const svc = Object.create(
      StoreQuestionService.prototype,
    ) as StoreQuestionService;
    Object.assign(svc, {
      mail,
      notifications: { emitOrThrow: async () => undefined },
    });
    const tx = {
      storeCredit: {
        createMany: async () => ({ count: 1 }),
        findUniqueOrThrow: async () => ({ id: 'credit-1' }),
      },
      directMessage: { update: async () => ({}) },
    };
    const credit = (email: boolean) =>
      priv<{ creditUnanswered: (...a: unknown[]) => Promise<void> }>(
        svc,
      ).creditUnanswered(
        tx,
        {
          id: 'purchase-0002',
          wawuUserId: 'user-asker-1',
          referenceKobo: 200_000,
          creditOriginId: null,
        },
        { id: 'dm-1', creatorWawuId: 'user-creator-3', amount: 2000 },
        new Date(),
        true,
        email,
      );
    await mail.within(() => credit(true));
    await mail.within(() => credit(false));
    await mail.settled();
    expect(double.sent).toHaveLength(1);
    expect(double.sent[0].body).toMatchObject({
      wawuId: 'user-asker-1',
      kind: 'refund_processed',
      data: {
        amountMinor: 200_000,
        currency: 'NGN',
        returnedTo: 'question_credit',
      },
    });
  });

  it('a delivered bill is told once with the token and units when known; the reader that finds it delivered tells nothing', async () => {
    const mail = mailer();
    const svc = Object.create(
      BillPaymentService.prototype,
    ) as BillPaymentService;
    const delivered = {
      id: 'bill-0000001',
      status: 'delivered',
      buyerWawuId: 'user-bill-1',
      billerName: 'IKEDC',
      customerRef: '45012345678',
      amount: 5000,
      token: '1234 5678 9012 3456 7890',
      units: '23.5',
      flutterwaveTxRef: 'WAWU-BILL-1',
    };
    Object.assign(svc, {
      mail,
      prisma: {
        billPayment: {
          updateMany: async () => ({ count: 1 }),
          findUnique: async () => delivered,
        },
      },
    });
    const settle = (status: string) =>
      priv<{
        settleFromProviderStatus: (r: unknown, s: string) => Promise<unknown>;
      }>(svc).settleFromProviderStatus({ ...delivered, status }, 'successful');
    await settle('processing');
    await settle('delivered');
    await mail.settled();
    expect(double.requests).toHaveLength(1);
    expect(double.sent).toHaveLength(1);
    expect(double.sent[0].body).toMatchObject({
      wawuId: 'user-bill-1',
      kind: 'bill_paid',
      data: {
        billerName: 'IKEDC',
        amountMinor: 500_000,
        currency: 'NGN',
        token: '1234 5678 9012 3456 7890',
        units: '23.5',
        reference: 'WAWU-BILL-1',
      },
    });
  });
});

describe('the money path and the switch', () => {
  it('a relay that is down does not change what the money move answers or throws', async () => {
    env.WAWU_ID_BASE_URL = 'http://127.0.0.1:1';
    const mail = mailer();
    const svc = Object.create(
      WalletTransferService.prototype,
    ) as WalletTransferService;
    Object.assign(svc, {
      mail,
      prisma: {
        walletTransfer: {
          updateMany: async () => ({ count: 1 }),
          findUniqueOrThrow: async () => ({
            id: 'transfer-0009',
            kind: 'bank_account',
            payerWawuUserId: 'user-bank-9',
            amountKobo: 1_000n,
            totalKobo: 1_065n,
            customerReference: 'WAWU-TR-9',
            status: 'failed',
          }),
        },
      },
    });
    const row = await priv<{
      transition: (
        t: unknown,
        s: string,
        d: unknown,
      ) => Promise<{ status: string }>;
    }>(svc).transition({ id: 'transfer-0009' }, 'failed', {});
    expect(row.status).toBe('failed');
    await mail.settled();
    expect(
      errors.some((e) =>
        e.includes('bank_send_failed bank_send_failed-transfer-0009'),
      ),
    ).toBe(true);
  });

  it('with the switch off none of them is sent', async () => {
    switchOn = 0;
    const mail = mailer();
    const svc = Object.create(
      UnlockWalletService.prototype,
    ) as UnlockWalletService;
    Object.assign(svc, {
      mail,
      facts: factsFor(),
      prisma: {
        contentPiece: { findUnique: async () => ({ title: 'A song' }) },
      },
    });
    priv<{ emailSale: (p: unknown, c: string) => void }>(svc).emailSale(
      {
        paymentId: 'pay-0000009',
        payerWawuUserId: 'user-buyer-9',
        targetId: 'piece-9',
      },
      'user-creator-9',
    );
    await mail.settled();
    expect(double.requests).toHaveLength(0);
  });
});
