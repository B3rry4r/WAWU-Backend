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
  AbroadService,
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
const SWEEP_BATCH = 50;
const TERMINAL: AbroadSendStatus[] = [
  'completed',
  'failed',
  'reversed',
  'cancelled',
];

type SendRow = Prisma.AbroadSendGetPayload<{ include: { recipient: true } }>;

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
      select: { usedAt: true, expiresAt: true },
    });
    if (!q) throw new MoneyError('not_found', 'We could not find that quote.');
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
            wawuFeeTaken: q.wawuFeeKobo === 0n,
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
    const row = await this.load(sendId);
    const next = statusOf(t);
    if (row.status === 'completed' && next === 'pending') return row;
    const now = new Date();
    const terminal = TERMINAL.includes(next);
    const data: Prisma.AbroadSendUpdateInput = {
      providerTransferId: row.providerTransferId ?? t.id,
      providerStatus: t.providerStatus,
      providerFeeMinor: t.feeMinor === null ? undefined : BigInt(t.feeMinor),
      checkedAt: now,
    };
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
      await this.prisma.abroadSend.update({ where: { id: sendId }, data });
    } catch (e) {
      // Two lookups of one send at once: the second finds the transfer id already stored.
      if (!(e instanceof Error) || !/Unique constraint/i.test(e.message))
        throw e;
    }
    return this.load(sendId);
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
   * (a book transfer to WAWU's account under `<reference>-fee`). A fee that
   * cannot be taken is tried again by the sweep and never fails the send.
   */
  async takeFee(sendId: string): Promise<void> {
    const row = await this.load(sendId);
    if (row.wawuFeeTaken || row.wawuFeeKobo === 0n) return;
    if (row.status === 'failed' || row.status === 'cancelled') return;
    if (row.feeAttempts >= FEE_ATTEMPTS) return;
    await this.prisma.abroadSend.update({
      where: { id: sendId },
      data: { feeAttempts: { increment: 1 } },
    });
    try {
      const wallet = await this.prisma.fintavaWallet.findFirst({
        where: {
          wawuUserId: row.wawuUserId,
          provider: this.walletProvider.name,
        },
        select: { accountNumber: true },
      });
      if (!wallet?.accountNumber) return;
      const platform = await this.walletProvider.getPlatformAccount();
      await this.walletProvider.walletToWallet({
        fromAccountNumber: wallet.accountNumber,
        toAccountNumber: platform.accountNumber,
        amountKobo: row.wawuFeeKobo,
        reference: `${row.reference}-fee`,
        narration: 'WAWU fee',
      });
      await this.prisma.abroadSend.update({
        where: { id: sendId },
        data: { wawuFeeTaken: true },
      });
    } catch (e) {
      this.logger.warn(
        `abroad send ${sendId}: WAWU's fee was not taken yet (${e instanceof WalletProviderError ? e.kind : 'error'}); the sweep tries again`,
      );
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
    return { checked, settled };
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
