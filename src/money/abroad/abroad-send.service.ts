import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AbroadRefusal,
  type AbroadTransfer,
} from '../../wallet-provider/abroad-provider';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import {
  type IdempotencyScope,
  IdempotencyService,
} from '../payments/idempotency';
import { successBody } from '../payments/wallet-payment.service';
import { ABROAD_DECIMALS } from './abroad-corridors';
import {
  foreignPort,
  readLeg,
  readLegWith,
  settleLeg,
  settleLegWith,
  type LegRead,
  type LegResult,
} from './abroad-fee-legs';
import {
  AbroadService,
  NOT_OFFERED_NOTE,
  recipientView,
  refusalError,
  speedOf,
} from './abroad.service';
import type {
  AbroadSendPage,
  AbroadSendStatus,
  AbroadSendView,
} from './abroad-view.type';
import type { AbroadSendDto } from './dto/abroad-request.dto';

/** The route a send's Idempotency-Key is scoped to. */
export const ABROAD_SEND_ROUTE = 'POST money/abroad/sends';

/** How our reference at the provider begins, so a delivery is told from a naira send's. */
export const ABROAD_REFERENCE_PREFIX = 'wawu-abroad-';

export const SEND_NOT_FOUND_MESSAGE = 'We could not find that send.';
export const SEND_FAILED_REASON =
  'The payment partner could not deliver this send. Any money taken comes back to your account.';
export const SEND_REVERSED_REASON =
  'This send was returned to your account after it was made.';
export const SEND_CANCELLED_REASON =
  'WAWU cancelled this send before it reached the payment partner. Nothing was taken.';
export const SEND_UNSURE_MESSAGE =
  'We are still confirming this send. Check your history before you try again.';

/** A send whose answer was lost waits this long for the provider's record before it is looked for. */
export const LOOK_AFTER_MS = 60_000;
/** After this long with no record at the provider, a send waits for a person (silence is never proof). */
export const REVIEW_AFTER_MS = 30 * 60_000;
/** A pending send is read from the provider after at least this long, backing off to the cap. */
export const PENDING_CHECK_BASE_MS = 30_000;
export const PENDING_CHECK_CAP_MS = 30 * 60_000;
/** How many times WAWU's fee is tried before it is left to finance (it never fails a send). */
export const FEE_ATTEMPTS = 5;
/** A fee given back that is still not done a day after the send ended waits for a person. */
export const FEE_BACK_HOLD_MS = 24 * 3_600_000;
/** The name on an audit row the sweep itself writes. */
export const SYSTEM_ACTOR = 'system';
const SWEEP_BATCH = 50;
const TERMINAL: AbroadSendStatus[] = [
  'completed',
  'failed',
  'reversed',
  'cancelled',
];

type SendRow = Prisma.AbroadSendGetPayload<{ include: { recipient: true } }>;

/**
 * WAWU's fee on a send, whichever account it leaves (WALLET-42): `foreign` when it is taken from the foreign account the money
 * leaves (a person with no naira wallet, `wawuFeeMinor`, in that currency), else the naira wallet's (`wawuFeeKobo`). At most one is
 * above 0.
 */
export function feeOf(row: { wawuFeeKobo: bigint; wawuFeeMinor: bigint }): {
  amount: bigint;
  foreign: boolean;
} {
  return row.wawuFeeMinor > 0n
    ? { amount: row.wawuFeeMinor, foreign: true }
    : { amount: row.wawuFeeKobo, foreign: false };
}

/** The sends whose fee is above 0 in either account (for a where clause). */
export const HAS_FEE: Prisma.AbroadSendWhereInput = {
  OR: [{ wawuFeeKobo: { gt: 0n } }, { wawuFeeMinor: { gt: 0n } }],
};

function statusOf(t: AbroadTransfer): AbroadSendStatus {
  return t.state;
}

/**
 * The send itself, and keeping it true (task NUV-11, R-84). The money moves
 * at the provider; this service decides under a short lock, calls the
 * provider holding nothing, and records its answer. A send is `sending`
 * before the provider is asked; its reference is its idempotency key at the
 * provider, so a lost answer is found again by that reference and the send is
 * never made a second time under a new one. A delivery, or the sweep, brings
 * `pending` to `completed`, `failed` or `reversed`. The provider's balance is
 * the truth: no row here is added up into one.
 */
@Injectable()
export class AbroadSendService {
  private readonly logger = new Logger(AbroadSendService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly walletProvider: WalletProvider,
    private readonly abroad: AbroadService,
    private readonly keys: IdempotencyService,
  ) {}

  // -- the send ----------------------------------------------------------------

  /**
   * Refusals that must come before the PIN is looked at (the route's
   * before-approval guard): the switch, the freeze, the provider, and a quote
   * that is the person's, unused and held. Reads our records only.
   */
  async checkBeforePin(wawuUserId: string, quoteId: unknown): Promise<void> {
    await this.abroad.assertOpenFor(wawuUserId);
    this.abroad.provider();
    if (typeof quoteId !== 'string' || !/^[0-9a-f-]{36}$/i.test(quoteId))
      return;
    const q = await this.prisma.abroadQuote.findFirst({
      where: { id: quoteId, wawuUserId },
      select: {
        usedAt: true,
        expiresAt: true,
        recipient: { select: { country: true } },
      },
    });
    if (!q) throw new MoneyError('not_found', 'We could not find that quote.');
    // A country switched off after the quote was taken is not sent to (F7).
    if (this.abroad.settings.countriesOff().has(q.recipient.country)) {
      throw new MoneyError('corridor_not_supported', NOT_OFFERED_NOTE);
    }
    if (q.usedAt !== null || q.expiresAt.getTime() <= Date.now()) {
      throw new MoneyError(
        'quote_expired',
        'This quote has run out. Get a new one and try again.',
      );
    }
  }

  async send(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: AbroadSendDto,
  ): Promise<AbroadSendView> {
    const userId = wallet.wawuUserId;
    let claimed: SendRow;
    let quote: Prisma.AbroadQuoteGetPayload<object>;
    try {
      await this.abroad.assertOpenFor(userId);
      const provider = this.abroad.provider();
      void provider;
      const now = new Date();
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`abroad:${userId}`}))`;
        const q = await tx.abroadQuote.findFirst({
          where: { id: dto.quoteId, wawuUserId: userId },
          include: { recipient: true },
        });
        if (!q)
          throw new MoneyError('not_found', 'We could not find that quote.');
        if (q.usedAt !== null || q.expiresAt.getTime() <= now.getTime()) {
          throw new MoneyError(
            'quote_expired',
            'This quote has run out. Get a new one and try again.',
          );
        }
        if (this.abroad.settings.countriesOff().has(q.recipient.country)) {
          throw new MoneyError('corridor_not_supported', NOT_OFFERED_NOTE);
        }
        if (q.recipient.removedAt !== null) {
          throw new MoneyError(
            'not_found',
            'We could not find that recipient.',
          );
        }
        await this.abroad.assertWithinLimits(
          tx,
          userId,
          q.fromCurrency,
          q.amountFromMinor,
        );
        const id = randomUUID();
        await this.keys.attach(tx, scope, id);
        await tx.abroadQuote.update({
          where: { id: q.id },
          data: { usedAt: now },
        });
        const row = await tx.abroadSend.create({
          data: {
            id,
            wawuUserId: userId,
            recipientId: q.recipientId,
            quoteId: q.id,
            fromCurrency: q.fromCurrency,
            toCurrency: q.toCurrency,
            fromAccountRef: q.fromAccountRef,
            amountFromMinor: q.amountFromMinor,
            amountToMinor: q.amountToMinor,
            rate: q.rate,
            status: 'sending',
            narration: dto.narration?.trim() || null,
            reference: `${ABROAD_REFERENCE_PREFIX}${id}`,
            wawuFeeKobo: q.wawuFeeKobo,
            wawuFeeMinor: q.wawuFeeMinor,
            providerFeeEstimateMinor: q.providerFeeEstimateMinor,
            wawuFeeTaken: q.wawuFeeKobo === 0n && q.wawuFeeMinor === 0n,
            attemptedAt: now,
          },
          include: { recipient: true },
        });
        return { row, q };
      });
      claimed = result.row;
      quote = result.q;
    } catch (e) {
      await this.keys.release(scope);
      throw e;
    }

    let transfer: AbroadTransfer;
    try {
      transfer = await this.abroad.provider().send({
        holder: AbroadService.holder(wallet),
        fromAccountRef: claimed.fromAccountRef,
        fromCurrency: claimed.fromCurrency,
        toCurrency: claimed.toCurrency,
        amountFromMinor: Number(claimed.amountFromMinor),
        counterpartyId: claimed.recipient.providerCounterpartyId,
        paymentDetailId: claimed.recipient.providerPaymentDetailId,
        method: claimed.recipient.method as 'bank' | 'mobile_money',
        quoteRef: quote.providerQuoteId,
        narration: claimed.narration ?? 'WAWU transfer',
        reference: claimed.reference,
      });
    } catch (e) {
      return this.afterFailure(claimed, quote.id, scope, e);
    }
    return this.afterAccepted(claimed, scope, transfer);
  }

  /** A refusal of the send call. Nothing moved unless the outcome is unknown. */
  private async afterFailure(
    row: SendRow,
    quoteId: string,
    scope: IdempotencyScope,
    e: unknown,
  ): Promise<AbroadSendView> {
    const definite =
      e instanceof AbroadRefusal ||
      (e instanceof WalletProviderError &&
        (e.requestNotSent ||
          (!e.recordMayExist &&
            [
              'validation',
              'insufficient_funds',
              'refused',
              'wallet_inactive',
              'auth',
              'not_configured',
              'rate_limited',
              'below_minimum',
              'payouts_blocked',
              'not_supported',
            ].includes(e.kind))));
    if (definite) {
      // The provider took nothing: the attempt leaves no row, and the quote can be used again.
      await this.prisma.$transaction([
        this.prisma.abroadSend.delete({ where: { id: row.id } }),
        this.prisma.abroadQuote.update({
          where: { id: quoteId },
          data: { usedAt: null },
        }),
      ]);
      await this.keys.release(scope);
      if (e instanceof AbroadRefusal) throw refusalError(e, row.fromCurrency);
      throw e.toHttpException();
    }
    this.logger.warn(
      `abroad send ${row.id}: the provider's answer is not known (${e instanceof WalletProviderError ? e.kind : 'error'}); it is found again by its reference`,
    );
    return this.answer(scope, row);
  }

  private async afterAccepted(
    row: SendRow,
    scope: IdempotencyScope,
    transfer: AbroadTransfer,
  ): Promise<AbroadSendView> {
    const updated = await this.apply(row.id, transfer);
    await this.takeFee(updated.id);
    return this.answer(scope, await this.load(row.id));
  }

  private async answer(
    scope: IdempotencyScope,
    row: SendRow,
  ): Promise<AbroadSendView> {
    const view = this.view(row);
    await this.keys.finish(scope, 201, successBody(view));
    return view;
  }

  // -- keeping a send true -----------------------------------------------------

  /**
   * Brings a send to what the provider's transfer says. Idempotent: the same
   * transfer twice changes nothing the second time. The provider's word wins,
   * except that a completed send is never taken back to pending.
   */
  async apply(sendId: string, t: AbroadTransfer): Promise<SendRow> {
    // The write below holds only for the status this call read (compare-and-set): an admin cancel that commits between the read and
    // the write makes the write find nothing, and the call looks again from the row as it now is (R1-2). Three looks at most; a
    // row that keeps moving is left to the next pass, which asks the provider again.
    for (let look = 1; look <= 3; look += 1) {
      const row = await this.load(sendId);
      if (await this.applyTo(row, t)) {
        return this.load(sendId);
      }
    }
    return this.load(sendId);
  }

  /** Applies the provider's word to the row as it was read. False when the row moved under the write and must be read again. */
  private async applyTo(row: SendRow, t: AbroadTransfer): Promise<boolean> {
    const sendId = row.id;
    const next = statusOf(t);
    if (row.status === 'cancelled') {
      // An admin cancelled it because the provider had nothing; now it has. The cancel stands (a decided row is never reopened):
      // the provider's facts are kept beside it and a person is told by the log and the admin list (`providerStatus`).
      await this.prisma.abroadSend
        .updateMany({
          where: { id: sendId, status: 'cancelled' },
          data: {
            providerTransferId: row.providerTransferId ?? t.id,
            providerStatus: t.providerStatus,
            checkedAt: new Date(),
          },
        })
        .catch(() => undefined);
      this.logger.error(
        `abroad send ${sendId}: cancelled by an admin, yet the provider holds transfer ${t.id} (${t.providerStatus}); the row stays cancelled and needs a person`,
      );
      return true;
    }
    if (row.status === 'completed' && next === 'pending') return true;
    const now = new Date();
    const terminal = TERMINAL.includes(next);
    const data: Prisma.AbroadSendUpdateManyMutationInput = {
      providerTransferId: row.providerTransferId ?? t.id,
      providerStatus: t.providerStatus,
      checkedAt: now,
    };
    if (t.feeMinor !== null) {
      // What the provider really charged, against what the review showed (R-10: from config): a difference flags the send so config
      // can be corrected. Without a configured figure, a charge above nothing is a difference too.
      data.providerFeeMinor = BigInt(t.feeMinor);
      data.feeDiffers =
        Number(row.providerFeeEstimateMinor ?? 0n) !== t.feeMinor;
    }
    if (row.status !== next) {
      data.status = next;
      data.completedAt = terminal ? now : null;
      data.failureReason =
        next === 'failed'
          ? SEND_FAILED_REASON
          : next === 'reversed'
            ? SEND_REVERSED_REASON
            : null;
    }
    try {
      const { count } = await this.prisma.abroadSend.updateMany({
        where: { id: sendId, status: row.status },
        data,
      });
      if (count !== 1) return false;
    } catch (e) {
      // Two lookups of one send at once: the second finds the transfer id already stored.
      if (!(e instanceof Error) || !/Unique constraint/i.test(e.message))
        throw e;
    }
    // A send that did not stand gives WAWU's fee back, once; the sweep asks again until it has landed.
    if (
      row.status !== next &&
      (next === 'failed' || next === 'reversed') &&
      row.wawuFeeTaken
    ) {
      await this.giveBack(sendId).catch(() => undefined);
    }
    return true;
  }

  async byReference(reference: string): Promise<SendRow | null> {
    return this.prisma.abroadSend.findUnique({
      where: { reference },
      include: { recipient: true },
    });
  }

  async byProviderId(id: string): Promise<SendRow | null> {
    return this.prisma.abroadSend.findUnique({
      where: { providerTransferId: id },
      include: { recipient: true },
    });
  }

  private load(id: string): Promise<SendRow> {
    return this.prisma.abroadSend.findUniqueOrThrow({
      where: { id },
      include: { recipient: true },
    });
  }

  /**
   * WAWU's fee, taken from the naira wallet after the provider has the send
   * (a book transfer to WAWU's account under `<reference>-fee`). It is taken
   * only when the provider's own record says the transfer completed; one that
   * cannot be taken is tried again by the sweep and never fails the send. A
   * send that ended while the fee was on its way gives it back at once.
   */
  async takeFee(sendId: string): Promise<void> {
    const row = await this.load(sendId);
    const fee = feeOf(row);
    if (row.wawuFeeTaken || fee.amount === 0n) return;
    if (['failed', 'reversed', 'cancelled'].includes(row.status)) return;
    if (row.feeAttempts >= FEE_ATTEMPTS) return;
    await this.prisma.abroadSend.update({
      where: { id: sendId },
      data: { feeAttempts: { increment: 1 } },
    });
    try {
      const warn = (m: string) =>
        this.logger.warn(`abroad send ${sendId}: WAWU's fee ${m}`);
      const moved = await this.settleFeeLeg(row, 'take', fee.amount, warn);
      if (moved === null) return;
      if (moved.result === 'spent') {
        this.logger.error(
          `abroad send ${sendId}: the provider failed WAWU's fee under three references; it waits for a person`,
        );
      }
      if (moved.result !== 'done') return;
      // Taken: a fee question the sweep closed as "nothing taken" in the meantime is open again.
      await this.prisma.abroadSend.update({
        where: { id: sendId },
        data: { wawuFeeTaken: true, feeSettledAt: null, feeSettledHow: null },
      });
    } catch (e) {
      this.logger.warn(
        `abroad send ${sendId}: WAWU's fee was not taken yet (${e instanceof WalletProviderError ? e.kind : 'error'}); the sweep tries again`,
      );
      return;
    }
    const after = await this.load(sendId);
    if (after.status === 'failed' || after.status === 'reversed') {
      await this.giveBack(sendId);
    }
  }

  /**
   * Makes the fee leg of a send once, through the one set of legs: out of the naira wallet to WAWU's account, or (a person with no
   * naira wallet, WALLET-42) out of the foreign account to WAWU's collecting account in the same currency, or back. Null when the
   * leg cannot be made yet (no wallet, no collecting account, no foreign fee support at the provider): it waits for a later pass.
   */
  private async settleFeeLeg(
    row: Prisma.AbroadSendGetPayload<object>,
    direction: 'take' | 'give_back',
    amount: bigint,
    warn: (message: string) => void,
  ): Promise<LegResult | null> {
    const base =
      direction === 'take'
        ? `${row.reference}-fee`
        : `${row.reference}-fee-back`;
    if (feeOf(row).foreign) {
      const ref = await this.foreignRef(row, direction);
      const abroad = this.abroad.provider();
      if (!ref || !abroad.feeLeg) return null;
      return settleLegWith(
        foreignPort(
          abroad,
          ref,
          amount,
          direction === 'take' ? 'WAWU fee' : 'WAWU fee given back',
        ),
        base,
        warn,
      );
    }
    const wallet = await this.prisma.fintavaWallet.findFirst({
      where: {
        wawuUserId: row.wawuUserId,
        provider: this.walletProvider.name,
      },
      select: { accountNumber: true },
    });
    if (!wallet?.accountNumber) return null;
    const platform = await this.walletProvider.getPlatformAccount();
    return settleLeg(
      this.walletProvider,
      base,
      direction === 'take'
        ? {
            fromAccountNumber: wallet.accountNumber,
            toAccountNumber: platform.accountNumber,
            amountKobo: amount,
            narration: 'WAWU fee',
          }
        : {
            fromAccountNumber: platform.accountNumber,
            toAccountNumber: wallet.accountNumber,
            amountKobo: amount,
            narration: 'WAWU fee given back',
          },
      warn,
    );
  }

  /** The foreign account and WAWU's collecting account a fee leg runs between; null while either is missing. */
  private async foreignRef(
    row: Prisma.AbroadSendGetPayload<object>,
    direction: 'take' | 'give_back',
  ) {
    const holder = await this.abroad.holderOf(row.wawuUserId);
    const collectorBan = this.abroad.settings.feeCollectorBan(row.fromCurrency);
    if (!holder || !collectorBan) return null;
    return {
      holder,
      currency: row.fromCurrency,
      accountRef: row.fromAccountRef,
      collectorBan,
      direction,
    };
  }

  /**
   * The provider's record of a send's fee leg (`fee`) or of its give-back (`fee_back`), read and never made. A leg that cannot be
   * looked for yet reads as `wait`.
   */
  async readFeeLeg(
    row: Prisma.AbroadSendGetPayload<object>,
    which: 'fee' | 'fee_back',
  ): Promise<LegRead> {
    const base =
      which === 'fee' ? `${row.reference}-fee` : `${row.reference}-fee-back`;
    if (!feeOf(row).foreign) return readLeg(this.walletProvider, base);
    const ref = await this.foreignRef(
      row,
      which === 'fee' ? 'take' : 'give_back',
    );
    const abroad = this.abroad.provider();
    if (!ref || !abroad.findFeeLeg) return { result: 'wait' };
    return readLegWith(foreignPort(abroad, ref), base);
  }

  /**
   * A send that failed or was reversed owes its sender the fee back, once
   * (`<reference>-fee-back`, from WAWU's account to the person's wallet): the
   * fee leg's own completed record says what was taken, and the give-back is
   * marked only when the provider's record says it completed. A reference the
   * provider failed is replaced in a later pass; three failed ones, or a day
   * of trying, hold it for a person with the fee still owed.
   */
  async giveBack(sendId: string, now = new Date()): Promise<void> {
    const row = await this.load(sendId);
    const fee = feeOf(row);
    if (!row.wawuFeeTaken || fee.amount === 0n) return;
    if (row.feeGivenBackAt !== null || row.feeBackHeldAt !== null) return;
    if (row.status !== 'failed' && row.status !== 'reversed') return;
    const since = (row.completedAt ?? row.updatedAt).getTime();
    const hold = async (why: string) => {
      await this.holdForPerson(
        row,
        `WAWU's fee could not be given back (${why}); still owed to the sender`,
        now,
      );
    };
    try {
      const taken = await this.readFeeLeg(row, 'fee');
      if (taken.result === 'none') {
        await hold('the fee leg has no completed record at the provider');
        return;
      }
      if (taken.result === 'wait') {
        await this.waitOrHold(sendId, now, since, hold);
        return;
      }
      const moved = await this.settleFeeLeg(
        row,
        'give_back',
        taken.moved.amountKobo + taken.moved.feeKobo,
        (m) =>
          this.logger.warn(`abroad send ${sendId}: the fee given back ${m}`),
      );
      if (moved === null) return;
      if (moved.result === 'done') {
        await this.prisma.abroadSend.updateMany({
          where: { id: sendId, feeGivenBackAt: null },
          data: { feeGivenBackAt: now },
        });
        return;
      }
      if (moved.result === 'spent') {
        await hold('the provider failed it under three references');
        return;
      }
      await this.waitOrHold(sendId, now, since, hold);
    } catch (e) {
      this.logger.warn(
        `abroad send ${sendId}: giving WAWU's fee back failed (${e instanceof WalletProviderError ? e.kind : 'error'}); asked again`,
      );
    }
  }

  private async waitOrHold(
    sendId: string,
    now: Date,
    since: number,
    hold: (why: string) => Promise<void>,
  ): Promise<void> {
    await this.prisma.abroadSend.update({
      where: { id: sendId },
      data: { feeBackAttempts: { increment: 1 } },
    });
    if (now.getTime() - since >= FEE_BACK_HOLD_MS) {
      await hold('a day of trying');
    }
  }

  /** Looks at the sends that are not finished, the way the naira send's sweep does. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'abroad-send-sweep' })
  async sweepOnSchedule(): Promise<void> {
    if (this.sweeping) return;
    if (this.walletProvider.name !== 'nuvion') return;
    this.sweeping = true;
    try {
      await this.sweep();
    } catch (e) {
      this.logger.error(
        `abroad sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  async sweep(now = new Date()): Promise<{ checked: number; settled: number }> {
    const open = await this.prisma.abroadSend.findMany({
      where: { status: { in: ['sending', 'pending'] } },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_BATCH,
      include: { recipient: true },
    });
    let checked = 0;
    let settled = 0;
    for (const row of open) {
      if (!this.due(row, now)) continue;
      checked += 1;
      const before = row.status;
      try {
        const after = await this.look(row, now);
        if (after !== before) settled += 1;
      } catch (e) {
        this.logger.warn(
          `abroad send ${row.id}: could not be checked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
        );
      }
    }
    const fees = await this.prisma.abroadSend.findMany({
      where: {
        wawuFeeTaken: false,
        feeAttempts: { lt: FEE_ATTEMPTS },
        status: { in: ['pending', 'completed'] },
      },
      take: 20,
      select: { id: true },
    });
    for (const f of fees) await this.takeFee(f.id);
    const owed = await this.prisma.abroadSend.findMany({
      where: {
        wawuFeeTaken: true,
        AND: [HAS_FEE],
        feeGivenBackAt: null,
        feeBackHeldAt: null,
        status: { in: ['failed', 'reversed'] },
      },
      take: 20,
      select: { id: true },
    });
    for (const f of owed) await this.giveBack(f.id, now);
    await this.followOpenFees(now);
    return { checked, settled };
  }

  /**
   * The fee questions that are open and that nothing makes any more (NUV-11 round 2, R1-3 and R1-4): a fee leg that was still on
   * its way when the send failed, and a fee that could not be taken in its last try. The sweep only READS the leg here, it never
   * makes one: a leg that completed is marked taken (and given back, once, if the send did not stand); one still on its way is
   * waited for, and held for a person after a day; one that never completed closes the question, so that nothing waits on it for
   * ever (an account deletion included). A fee WAWU could not take from a send that went through is written off with a row in the
   * admin audit; for a send that failed there was nothing to take and nothing is said.
   */
  private async followOpenFees(now: Date): Promise<void> {
    const rows = await this.prisma.abroadSend.findMany({
      where: {
        wawuFeeTaken: false,
        AND: [HAS_FEE],
        feeSettledAt: null,
        feeAttempts: { gt: 0 },
        OR: [
          { status: { in: ['failed', 'reversed'] } },
          { status: 'completed', feeAttempts: { gte: FEE_ATTEMPTS } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 20,
    });
    for (const row of rows) {
      try {
        await this.followFeeLeg(row, now);
      } catch (e) {
        this.logger.warn(
          `abroad send ${row.id}: WAWU's fee leg could not be read (${e instanceof WalletProviderError ? e.kind : 'error'}); asked again`,
        );
      }
    }
  }

  private async followFeeLeg(
    row: Prisma.AbroadSendGetPayload<object>,
    now: Date,
  ): Promise<void> {
    const leg = await this.readFeeLeg(row, 'fee');
    const failedSend = row.status === 'failed' || row.status === 'reversed';
    if (leg.result === 'done') {
      await this.prisma.abroadSend.updateMany({
        where: { id: row.id, wawuFeeTaken: false },
        data: { wawuFeeTaken: true },
      });
      if (failedSend) await this.giveBack(row.id, now);
      return;
    }
    const since = (row.completedAt ?? row.updatedAt).getTime();
    if (leg.result === 'wait') {
      if (now.getTime() - since >= FEE_BACK_HOLD_MS) {
        await this.holdForPerson(
          row,
          "WAWU's fee leg is still on its way a day after the send ended",
          now,
        );
      }
      return;
    }
    // The leg never completed. A send that failed is given a minute first: a take in flight may be about to make it.
    if (failedSend && now.getTime() - since < LOOK_AFTER_MS) return;
    await this.closeFee(row, failedSend ? 'nothing_taken' : 'not_taken', now);
  }

  /**
   * The sweep's last word on a fee it cannot settle: held for a person (`feeBackHeldAt`), with a row in the admin audit so finance
   * sees it however long it takes, and `POST /admin/money/abroad/sends/{id}/settle-fee` closes it. A held fee does not hold an
   * account deletion (R1-4): the row of what is owed is the audit row, which a deletion keeps.
   */
  private async holdForPerson(
    row: Prisma.AbroadSendGetPayload<object>,
    why: string,
    now: Date,
  ): Promise<void> {
    const held = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.abroadSend.updateMany({
        where: { id: row.id, feeSettledAt: null, feeBackHeldAt: null },
        data: { feeBackHeldAt: now },
      });
      if (count !== 1) return false;
      await tx.abroadAdminAudit.create({
        data: {
          action: 'fee_held',
          subjectWawuId: row.wawuUserId,
          sendId: row.id,
          reason: why,
          detail: {
            feeKobo: row.wawuFeeKobo.toString(),
            feeMinor: row.wawuFeeMinor.toString(),
            status: row.status,
            feeTaken: row.wawuFeeTaken,
          },
          adminId: SYSTEM_ACTOR,
          adminEmail: SYSTEM_ACTOR,
          adminRole: SYSTEM_ACTOR,
        },
      });
      return true;
    });
    if (held) {
      this.logger.error(
        `abroad send ${row.id}: ${why}; it waits for a person (admin: settle-fee)`,
      );
    }
  }

  /** Closes the fee question of a send (once); a fee written off on a send that went through leaves a row in the admin audit. */
  private async closeFee(
    row: Prisma.AbroadSendGetPayload<object>,
    how: 'not_taken' | 'nothing_taken',
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.abroadSend.updateMany({
        where: { id: row.id, wawuFeeTaken: false, feeSettledAt: null },
        data: { feeSettledAt: now, feeSettledHow: how },
      });
      if (count !== 1 || how !== 'not_taken') return;
      await tx.abroadAdminAudit.create({
        data: {
          action: 'fee_not_taken',
          subjectWawuId: row.wawuUserId,
          sendId: row.id,
          reason:
            "WAWU's fee could not be taken after the last try and was written off",
          detail: {
            feeKobo: row.wawuFeeKobo.toString(),
            feeMinor: row.wawuFeeMinor.toString(),
            attempts: row.feeAttempts,
          },
          adminId: SYSTEM_ACTOR,
          adminEmail: SYSTEM_ACTOR,
          adminRole: SYSTEM_ACTOR,
        },
      });
    });
    this.logger.warn(
      `abroad send ${row.id}: the fee question is closed (${how})`,
    );
  }

  private due(row: SendRow, now: Date): boolean {
    const since = (row.checkedAt ?? row.attemptedAt ?? row.createdAt).getTime();
    if (row.status === 'sending') return now.getTime() - since >= LOOK_AFTER_MS;
    const wait = Math.min(
      PENDING_CHECK_CAP_MS,
      PENDING_CHECK_BASE_MS * 2 ** Math.min(row.checks, 7),
    );
    return now.getTime() - since >= wait;
  }

  /** Asks the provider about one send; returns the status it now has. */
  private async look(row: SendRow, now: Date): Promise<AbroadSendStatus> {
    const holder = await this.abroad.holderOf(row.wawuUserId);
    if (!holder) return row.status as AbroadSendStatus;
    const provider = this.abroad.provider();
    await this.prisma.abroadSend.update({
      where: { id: row.id },
      data: { checks: { increment: 1 }, checkedAt: now },
    });
    if (row.providerTransferId) {
      const t = await provider.read(holder, row.providerTransferId);
      return (await this.apply(row.id, t)).status as AbroadSendStatus;
    }
    const found = await provider.findByReference(
      holder,
      row.reference,
      row.attemptedAt ?? row.createdAt,
    );
    if (found.state === 'found') {
      const applied = await this.apply(row.id, found.transfer);
      await this.takeFee(row.id);
      return applied.status as AbroadSendStatus;
    }
    const age = now.getTime() - (row.attemptedAt ?? row.createdAt).getTime();
    if (
      found.state === 'absent' &&
      age >= REVIEW_AFTER_MS &&
      row.status === 'sending'
    ) {
      await this.prisma.abroadSend.update({
        where: { id: row.id },
        data: { status: 'needs_review' },
      });
      this.logger.error(
        `abroad send ${row.id}: the provider holds no record after ${Math.round(age / 60000)} minutes; it waits for a person`,
      );
      return 'needs_review';
    }
    return row.status as AbroadSendStatus;
  }

  // -- reading ---------------------------------------------------------------

  async read(wawuUserId: string, id: string): Promise<AbroadSendView> {
    const row = await this.prisma.abroadSend.findFirst({
      where: { id, wawuUserId },
      include: { recipient: true },
    });
    if (!row) throw new MoneyError('not_found', SEND_NOT_FOUND_MESSAGE);
    return this.view(row);
  }

  async list(
    wawuUserId: string,
    cursor: string | undefined,
    limit = 20,
  ): Promise<AbroadSendPage> {
    const at = decodeCursor(cursor);
    const rows = await this.prisma.abroadSend.findMany({
      where: {
        wawuUserId,
        ...(at
          ? {
              OR: [
                { createdAt: { lt: at.createdAt } },
                { createdAt: at.createdAt, id: { lt: at.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { recipient: true },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.view(r)),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  view(r: SendRow): AbroadSendView {
    return {
      id: r.id,
      status: r.status as AbroadSendStatus,
      recipient: recipientView(r.recipient),
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      fromDecimals: ABROAD_DECIMALS,
      toDecimals: ABROAD_DECIMALS,
      amountFromMinor: Number(r.amountFromMinor),
      amountToMinor: Number(r.amountToMinor),
      rate: r.rate,
      providerFeeMinor:
        r.providerFeeMinor === null ? null : Number(r.providerFeeMinor),
      wawuFeeKobo: Number(r.wawuFeeKobo),
      wawuFeeMinor: Number(r.wawuFeeMinor),
      narration: r.narration,
      failureReason: r.failureReason,
      speed: speedOf(r.recipient),
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    };
  }
}

export function encodeCursor(r: { createdAt: Date; id: string }): string {
  return Buffer.from(`${r.createdAt.getTime()}:${r.id}`).toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [ms, id] = Buffer.from(cursor, 'base64url').toString().split(':');
  const t = Number(ms);
  if (!Number.isSafeInteger(t) || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new MoneyError('not_found', 'That page cannot be found.');
  }
  return { createdAt: new Date(t), id };
}
