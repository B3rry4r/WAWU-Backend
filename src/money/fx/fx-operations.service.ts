import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { FxAccount, FxOperation } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type OpenWallet, worldWalletOf } from '../gate/wallet-gate';
import { LedgerService } from '../ledger/ledger.service';
import { MoneyError } from '../money-error';
import {
  IdempotencyService,
  type IdempotencyScope,
} from '../payments/idempotency';
import { successBody } from '../payments/wallet-payment.service';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type {
  ProviderFxSide,
  ProviderFxTransfer,
} from '../../wallet-provider/wallet-provider-fx';
import type {
  FxQuoteDto,
  FxSendDto,
  FxSendQuoteQueryDto,
  FxSwapDto,
} from './dto/fx-request.dto';
import { FxAccountsService } from './fx-accounts.service';
import {
  addressSuitsChain,
  fxCurrency,
  type FxQuoteCode,
} from './fx-currencies';
import { FxPort, providerFailure } from './fx-provider';
import { FxSettings } from './fx-settings';
import { num, quoteView, sendQuoteView, sendView, swapView } from './fx-views';
import type {
  FxQuoteView,
  FxSendQuoteView,
  FxSendView,
  FxSwapView,
} from './fx-view.type';

/** WAWU's fee is tried this many times, each under its own reference, before it is given back. */
const FEE_ATTEMPTS = 3;

type FeeResult =
  | { state: 'completed'; platformAccount?: string }
  | { state: 'pending' }
  | { state: 'failed' };

/** Which try a fee leg is on: `owed` is the first, `owed:2` the second. */
function feeAttempt(feeLeg: string | null): number {
  const m = /^owed:(\d+)$/.exec(feeLeg ?? '');
  return m ? Number(m[1]) : 1;
}

/** True while WAWU's fee is still to be collected. */
function feeOwed(feeLeg: string | null): boolean {
  return feeLeg === 'owed' || (feeLeg ?? '').startsWith('owed:');
}

/** A pending operation is looked at by the sweep after this long. */
const SWEEP_AFTER_MS = 20_000;
/** The sweep gives up on an operation the provider never shows after this long. */
const SWEEP_GIVE_UP_MS = 48 * 3_600_000;

/** The Lagos calendar day (UTC+1, no daylight saving) of an instant, `YYYY-MM-DD`. */
export function lagosDay(now: Date): string {
  return new Date(now.getTime() + 3_600_000).toISOString().slice(0, 10);
}

const NGN_LEDGER = 'Swap';

/**
 * Quotes, swaps and crypto sends (task WALLET-21, R-83, R-84), through
 * `WALLET_PROVIDER` only. The rules every money mover here follows (R-10,
 * R-19, MONEY-17): decide under a short lock, call the provider holding
 * nothing, record under a short lock; the provider's balance is the truth; a
 * lost answer is `pending` until the provider's own record says, never sent
 * again blindly; the Idempotency-Key makes a repeat the first answer.
 */
@Injectable()
export class FxOperationsService {
  private readonly logger = new Logger(FxOperationsService.name);

  constructor(
    private readonly port: FxPort,
    private readonly prisma: PrismaService,
    private readonly settings: FxSettings,
    private readonly accounts: FxAccountsService,
    private readonly keys: IdempotencyService,
    private readonly ledger: LedgerService,
  ) {}

  // -------------------------------------------------------------------------
  // Quote
  // -------------------------------------------------------------------------

  async quote(wallet: OpenWallet, dto: FxQuoteDto): Promise<FxQuoteView> {
    const fx = this.port.get();
    this.requireOn('swap', dto.fromCurrency, dto.toCurrency);
    if (
      (dto.amountFromMinor === undefined) ===
      (dto.amountToMinor === undefined)
    ) {
      throw new BadRequestException(
        'send amountFromMinor or amountToMinor, not both and not neither',
      );
    }
    const from = await this.side(wallet, dto.fromCurrency, dto.fromAccountId);
    const to = await this.side(wallet, dto.toCurrency, dto.toAccountId);
    if (from.row && to.row && from.row.id === to.row.id) {
      throw new BadRequestException('pick two different accounts');
    }
    if (!from.row && !to.row) {
      throw new BadRequestException(
        'a swap needs a foreign account on at least one side',
      );
    }
    let q;
    try {
      q = await fx.quote({
        person: this.port.person(wallet),
        from: from.side,
        to: to.side,
        ...(dto.amountFromMinor !== undefined
          ? { amountFromMinor: BigInt(dto.amountFromMinor) }
          : { amountToMinor: BigInt(dto.amountToMinor!) }),
      });
    } catch (e) {
      throw providerFailure(e, { currency: dto.fromCurrency });
    }
    const row = await this.prisma.fxQuote.create({
      data: {
        wawuUserId: wallet.wawuUserId,
        provider: this.port.name,
        providerQuoteId: q.id,
        fromCurrency: dto.fromCurrency,
        toCurrency: dto.toCurrency,
        fromAccountId: from.row?.id ?? null,
        toAccountId: to.row?.id ?? null,
        amountFromMinor: q.amountFromMinor,
        amountToMinor: q.amountToMinor,
        rate: q.rate,
        providerFeeMinor: q.feeMinor,
        wawuFeeMinor: this.settings.swapFeeMinor(dto.fromCurrency),
        expiresAt: q.expiresAt,
      },
    });
    return quoteView(row, this.settings);
  }

  // -------------------------------------------------------------------------
  // Swap
  // -------------------------------------------------------------------------

  async swap(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: FxSwapDto,
  ): Promise<FxSwapView> {
    const fx = this.port.get();
    const quote = await this.prisma.fxQuote.findUnique({
      where: { id: dto.quoteId },
    });
    if (
      !quote ||
      quote.wawuUserId !== wallet.wawuUserId ||
      quote.provider !== this.port.name
    ) {
      throw new MoneyError('not_found', 'We could not find that quote.');
    }
    const fromCode = quote.fromCurrency as FxQuoteCode;
    const toCode = quote.toCurrency as FxQuoteCode;
    this.requireOn('swap', fromCode, toCode);
    if (quote.usedAt || quote.expiresAt.getTime() <= Date.now()) {
      throw new MoneyError(
        'quote_expired',
        'That rate is no longer held. Get a new one.',
      );
    }
    const from = await this.side(
      wallet,
      fromCode,
      quote.fromAccountId ?? undefined,
    );
    const to = await this.side(wallet, toCode, quote.toAccountId ?? undefined);
    const wawuFee = quote.wawuFeeMinor;
    await this.requireFunds(
      wallet,
      from,
      quote.amountFromMinor + wawuFee,
      fromCode,
    );
    const op = await this.claim(scope, wallet, {
      kind: 'swap',
      fromCurrency: fromCode,
      toCurrency: toCode,
      fromAccountId: from.row?.id ?? null,
      toAccountId: to.row?.id ?? null,
      amountFromMinor: quote.amountFromMinor,
      amountToMinor: quote.amountToMinor,
      rate: quote.rate,
      wawuFeeMinor: wawuFee,
      quoteId: quote.id,
      limitCurrency: fromCode,
    });
    let receipt: ProviderFxTransfer;
    try {
      receipt = await fx.swap({
        person: this.port.person(wallet),
        reference: op.reference,
        quoteId: quote.providerQuoteId,
        from: from.side,
        to: to.side,
        amountFromMinor: quote.amountFromMinor,
      });
    } catch (e) {
      return this.afterFailure(scope, op, e, fromCode, (o) =>
        swapView(o, this.settings),
      );
    }
    return this.settle(scope, wallet, op, receipt, (o) =>
      swapView(o, this.settings),
    );
  }

  async readSwap(wallet: OpenWallet, id: string): Promise<FxSwapView> {
    this.port.get();
    return swapView(await this.operationOf(wallet, id, 'swap'), this.settings);
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  async sendQuote(
    wallet: OpenWallet,
    q: FxSendQuoteQueryDto,
  ): Promise<FxSendQuoteView> {
    const fx = this.port.get();
    const row = await this.sendAccount(
      wallet,
      q.accountId,
      q.chain,
      q.currency,
    );
    this.requireOn('crypto_send', row.currency as FxQuoteCode);
    let available: bigint;
    try {
      available = (
        await fx.readAccount(this.port.person(wallet), row.providerAccountId!)
      ).availableMinor;
    } catch (e) {
      throw providerFailure(e, { currency: row.currency });
    }
    return sendQuoteView(row, this.settings, q.amountMinor, num(available));
  }

  async send(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: FxSendDto,
  ): Promise<FxSendView> {
    const fx = this.port.get();
    const row = await this.sendAccount(
      wallet,
      dto.accountId,
      dto.chain,
      dto.currency,
    );
    const code = row.currency as FxQuoteCode;
    this.requireOn('crypto_send', code);
    if (!addressSuitsChain(dto.chain, dto.address)) {
      throw new MoneyError(
        'address_invalid',
        `That is not an address on ${dto.chain}.`,
      );
    }
    const amount = BigInt(dto.amountMinor);
    const wawuFee = this.settings.sendFeeMinor(row.currency as never);
    const side = {
      row,
      side: {
        currency: row.currency,
        accountId: row.providerAccountId,
      } as ProviderFxSide,
    };
    await this.requireFunds(wallet, side, amount + wawuFee, code);
    const op = await this.claim(scope, wallet, {
      kind: 'send',
      fromCurrency: code,
      toCurrency: null,
      fromAccountId: row.id,
      toAccountId: null,
      amountFromMinor: amount,
      amountToMinor: null,
      rate: null,
      wawuFeeMinor: wawuFee,
      quoteId: null,
      chain: dto.chain,
      address: dto.address,
      limitCurrency: code,
    });
    let receipt: ProviderFxTransfer;
    try {
      receipt = await fx.send({
        person: this.port.person(wallet),
        reference: op.reference,
        accountId: row.providerAccountId!,
        currency: row.currency,
        chain: dto.chain,
        address: dto.address,
        amountMinor: amount,
        holderName: 'Outside wallet',
      });
    } catch (e) {
      return this.afterFailure(scope, op, e, code, (o) =>
        sendView(o, this.settings),
      );
    }
    return this.settle(scope, wallet, op, receipt, (o) =>
      sendView(o, this.settings),
    );
  }

  async readSend(wallet: OpenWallet, id: string): Promise<FxSendView> {
    this.port.get();
    return sendView(await this.operationOf(wallet, id, 'send'), this.settings);
  }

  // -------------------------------------------------------------------------
  // Claim, settle, fail
  // -------------------------------------------------------------------------

  /**
   * Decides under one short lock: the per-currency daily limit is checked over
   * the person's day (so two at once cannot both pass), the quote is spent,
   * the key is tied to the operation and the operation is written. Nothing
   * is asked of the provider inside it.
   */
  private async claim(
    scope: IdempotencyScope,
    wallet: OpenWallet,
    f: {
      kind: 'swap' | 'send';
      fromCurrency: FxQuoteCode;
      toCurrency: FxQuoteCode | null;
      fromAccountId: string | null;
      toAccountId: string | null;
      amountFromMinor: bigint;
      amountToMinor: bigint | null;
      rate: string | null;
      wawuFeeMinor: bigint;
      quoteId: string | null;
      chain?: string;
      address?: string;
      limitCurrency: FxQuoteCode;
    },
  ): Promise<FxOperation> {
    const now = new Date();
    const day = lagosDay(now);
    const limit = this.settings.dailyLimitMinor(f.limitCurrency);
    const id = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fx:${wallet.wawuUserId}`}))`;
      if (limit !== null) {
        const used = await tx.fxOperation.aggregate({
          _sum: { amountFromMinor: true, wawuFeeMinor: true },
          where: {
            wawuUserId: wallet.wawuUserId,
            fromCurrency: f.limitCurrency,
            day,
            status: { in: ['pending', 'completed'] },
          },
        });
        const spent =
          (used._sum.amountFromMinor ?? 0n) + (used._sum.wawuFeeMinor ?? 0n);
        const wants = f.amountFromMinor + f.wawuFeeMinor;
        if (spent + wants > limit) {
          const left = limit > spent ? limit - spent : 0n;
          throw new MoneyError(
            'daily_limit_exceeded',
            'That is more than you can move today from this currency.',
            {
              currency: f.limitCurrency,
              limitMinor: num(limit),
              remainingTodayMinor: num(left),
              totalMinor: num(wants),
            },
          );
        }
      }
      if (f.quoteId) {
        const { count } = await tx.fxQuote.updateMany({
          where: { id: f.quoteId, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (count !== 1) {
          throw new MoneyError(
            'quote_expired',
            'That rate is no longer held. Get a new one.',
          );
        }
      }
      await this.keys.attach(tx, scope, id);
      return tx.fxOperation.create({
        data: {
          id,
          wawuUserId: wallet.wawuUserId,
          provider: this.port.name,
          kind: f.kind,
          status: 'pending',
          reference: `wawu-fx-${id}`,
          fromCurrency: f.fromCurrency,
          toCurrency: f.toCurrency,
          fromAccountId: f.fromAccountId,
          toAccountId: f.toAccountId,
          amountFromMinor: f.amountFromMinor,
          amountToMinor: f.amountToMinor,
          rate: f.rate,
          wawuFeeMinor: f.wawuFeeMinor,
          quoteId: f.quoteId,
          chain: f.chain ?? null,
          address: f.address ?? null,
          day,
        },
      });
    });
  }

  /** The provider answered: record it, move the fee, answer and keep the answer for a repeat. */
  private async settle<V>(
    scope: IdempotencyScope,
    wallet: Pick<
      OpenWallet,
      'wawuUserId' | 'accountNumber' | 'customerId' | 'walletId'
    >,
    op: FxOperation,
    receipt: ProviderFxTransfer,
    present: (o: FxOperation) => V,
  ): Promise<V> {
    const updated = await this.record(op, receipt);
    if (updated.status === 'completed') await this.finish(wallet, updated);
    const row =
      (await this.prisma.fxOperation.findUnique({ where: { id: op.id } })) ??
      updated;
    const view = present(row);
    await this.keys.finish(scope, 201, successBody(view));
    return view;
  }

  /** Writes the provider's word on the operation (once: only a pending one changes). */
  private async record(
    op: FxOperation,
    r: ProviderFxTransfer,
  ): Promise<FxOperation> {
    const status =
      r.status === 'completed'
        ? 'completed'
        : r.status === 'failed'
          ? 'failed'
          : 'pending';
    await this.prisma.fxOperation.updateMany({
      where: { id: op.id, status: 'pending' },
      data: {
        status,
        providerTransferId: r.transferId,
        providerFeeMinor: r.feeMinor,
        failureReason:
          status === 'failed'
            ? (r.failureReason ?? 'The provider did not complete it.')
            : null,
        completedAt: status === 'pending' ? null : new Date(),
      },
    });
    return (
      (await this.prisma.fxOperation.findUnique({ where: { id: op.id } })) ?? op
    );
  }

  /** What a completed operation still owes: the naira side in the ledger, WAWU's fee. Idempotent. */
  private async finish(
    wallet: Pick<
      OpenWallet,
      'wawuUserId' | 'accountNumber' | 'customerId' | 'walletId'
    >,
    op: FxOperation,
  ): Promise<void> {
    await this.ledgerNaira(wallet, op).catch((e: unknown) =>
      this.logger.error(
        `fx ${op.id}: the naira ledger could not be written (${e instanceof Error ? e.name : 'error'})`,
      ),
    );
    await this.feeLeg(wallet, op).catch((e: unknown) =>
      this.logger.error(
        `fx ${op.id}: WAWU's fee could not be moved (${e instanceof Error ? e.name : 'error'})`,
      ),
    );
  }

  private async ledgerNaira(
    wallet: Pick<OpenWallet, 'wawuUserId' | 'accountNumber'>,
    op: FxOperation,
  ): Promise<void> {
    if (op.kind !== 'swap' || op.ledgerAt) return;
    const out = op.fromCurrency === 'NGN';
    const into = op.toCurrency === 'NGN';
    if (!out && !into) return;
    const other = out ? op.toCurrency : op.fromCurrency;
    const kobo = out ? op.amountFromMinor : (op.amountToMinor ?? 0n);
    await this.ledger.record({
      wallet: {
        kind: 'user',
        wawuUserId: wallet.wawuUserId,
        accountNumber: wallet.accountNumber,
      },
      direction: out ? 'out' : 'in',
      status: 'completed',
      category: 'transfer',
      amountKobo: num(kobo),
      feeKobo: out ? num(op.providerFeeMinor ?? 0n) : 0,
      counterparty: {
        kind: 'wawu',
        name: `${NGN_LEDGER} ${out ? 'to' : 'from'} ${other}`,
      },
      note: `${NGN_LEDGER} ${out ? 'to' : 'from'} ${other}`,
      references: {
        customerReference: op.reference,
        ...(op.providerTransferId
          ? {
              fintavaReference: op.providerTransferId,
              fintavaTransactionId: op.providerTransferId,
            }
          : {}),
      },
      source: 'send',
      occurredAt: op.completedAt ?? new Date(),
    });
    await this.prisma.fxOperation.updateMany({
      where: { id: op.id, ledgerAt: null },
      data: { ledgerAt: new Date() },
    });
  }

  /**
   * WAWU's fee on top (R-10): a second transfer, in the source currency, under
   * our reference plus `-fee`. A naira fee goes the way a naira send's does
   * (the provider's own platform account, WALLET-07); any other currency pays
   * the collector account in that currency. The leg is marked `done` ONLY when
   * the provider says the transfer completed (verifier H1: it was marked done
   * on a failed record). What it answers decides the next step:
   * - completed: `done`;
   * - unfinished, or an answer that was lost: `owed`, asked again under the
   *   SAME reference (the provider answers a repeat with the original);
   * - refused for good (a failed record, a refusal): the reference is spent at
   *   the provider, so the next try uses a new one (`-fee-2`, `-fee-3`:
   *   `owed:2`, `owed:3`); after the third the fee is given back (`uncollected`,
   *   WAWU's fee on the operation set to 0), never shown as paid.
   */
  private async feeLeg(
    wallet: Pick<
      OpenWallet,
      'wawuUserId' | 'customerId' | 'walletId' | 'accountNumber'
    >,
    op: FxOperation,
  ): Promise<void> {
    if (
      op.wawuFeeMinor <= 0n ||
      op.feeLeg === 'done' ||
      op.feeLeg === 'uncollected'
    ) {
      return;
    }
    const attempt = feeAttempt(op.feeLeg);
    const reference =
      attempt === 1 ? `${op.reference}-fee` : `${op.reference}-fee-${attempt}`;
    const code = op.fromCurrency as FxQuoteCode;
    let result: FeeResult;
    try {
      result =
        code === 'NGN'
          ? await this.nairaFee(wallet, op, reference)
          : await this.foreignFee(wallet, op, code, reference);
    } catch (e) {
      if (e instanceof WalletProviderError && !e.recordMayExist) {
        result = { state: 'failed' };
      } else {
        this.logger.warn(
          `fx ${op.id}: WAWU's fee is not confirmed yet (${e instanceof WalletProviderError ? e.kind : 'error'}); asked again under the same reference`,
        );
        result = { state: 'pending' };
      }
    }
    if (result.state === 'completed') {
      await this.prisma.fxOperation.update({
        where: { id: op.id },
        data: { feeLeg: 'done' },
      });
      if (result.platformAccount) {
        await this.ledgerFee(wallet, op, reference, result.platformAccount);
      }
      return;
    }
    if (result.state === 'failed') {
      if (attempt >= FEE_ATTEMPTS) {
        this.logger.error(
          `fx ${op.id}: WAWU's fee was refused ${FEE_ATTEMPTS} times; given back, not collected`,
        );
        await this.prisma.fxOperation.update({
          where: { id: op.id },
          data: { feeLeg: 'uncollected', wawuFeeMinor: 0n },
        });
      } else {
        await this.prisma.fxOperation.update({
          where: { id: op.id },
          data: { feeLeg: `owed:${attempt + 1}` },
        });
      }
      return;
    }
    await this.prisma.fxOperation.update({
      where: { id: op.id },
      data: { feeLeg: attempt === 1 ? 'owed' : `owed:${attempt}` },
    });
  }

  /** The naira fee: the naira send's own path, a book transfer to WAWU's account. */
  private async nairaFee(
    wallet: Pick<OpenWallet, 'accountNumber'>,
    op: FxOperation,
    reference: string,
  ): Promise<FeeResult> {
    const provider = this.port.provider;
    const platform = await provider.getPlatformAccount();
    const receipt = await provider.walletToWallet({
      fromAccountNumber: wallet.accountNumber,
      toAccountNumber: platform.accountNumber,
      amountKobo: op.wawuFeeMinor,
      reference,
      narration: 'WAWU fee',
    });
    return receipt.pending === true
      ? { state: 'pending' }
      : { state: 'completed', platformAccount: platform.accountNumber };
  }

  /** A fee in another currency: a transfer to the collector's routing number. */
  private async foreignFee(
    wallet: Pick<OpenWallet, 'customerId' | 'walletId'>,
    op: FxOperation,
    code: FxQuoteCode,
    reference: string,
  ): Promise<FeeResult> {
    const ban = this.settings.feeCollector(code);
    if (!ban) {
      this.logger.error(
        `fx ${op.id}: no collector account is set for ${code}; the fee stays owed`,
      );
      return { state: 'pending' };
    }
    const fromRow = op.fromAccountId
      ? await this.prisma.fxAccount.findUnique({
          where: { id: op.fromAccountId },
        })
      : null;
    const receipt = await this.port.get().swap({
      person: this.port.person(wallet),
      reference,
      quoteId: null,
      from: { currency: code, accountId: fromRow?.providerAccountId ?? null },
      to: { currency: code, accountId: null, ban },
      amountFromMinor: op.wawuFeeMinor,
      narration: 'WAWU fee',
    });
    return { state: receipt.status };
  }

  /** The naira ledger of a collected naira fee: the payer's debit and WAWU's credit, once each. */
  private async ledgerFee(
    wallet: Pick<OpenWallet, 'wawuUserId' | 'accountNumber'>,
    op: FxOperation,
    reference: string,
    platformAccount: string,
  ): Promise<void> {
    try {
      const amountKobo = num(op.wawuFeeMinor);
      const base = {
        status: 'completed' as const,
        category: 'transfer' as const,
        amountKobo,
        feeKobo: 0,
        narration: 'WAWU fee',
        references: { customerReference: reference },
        source: 'send' as const,
      };
      await this.ledger.record({
        ...base,
        wallet: {
          kind: 'user',
          wawuUserId: wallet.wawuUserId,
          accountNumber: wallet.accountNumber,
        },
        direction: 'out',
        counterparty: { kind: 'wawu', name: 'WAWU fee' },
        note: 'WAWU fee',
      });
      await this.ledger.record(
        {
          ...base,
          wallet: { kind: 'merchant', accountNumber: platformAccount },
          direction: 'in',
          totalKobo: amountKobo,
          counterparty: {
            kind: 'wawu_user',
            name: null,
            wawuUserId: wallet.wawuUserId,
            accountNumber: wallet.accountNumber,
          },
        },
        undefined,
        { quiet: true },
      );
    } catch (e) {
      this.logger.error(
        `fx ${op.id}: the naira ledger could not record WAWU's fee (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** The provider refused, or its answer was lost. */
  private async afterFailure<V>(
    scope: IdempotencyScope,
    op: FxOperation,
    e: unknown,
    currency: FxQuoteCode,
    present: (o: FxOperation) => V,
  ): Promise<V> {
    const err = e instanceof WalletProviderError ? e : null;
    if (err && err.requestNotSent) {
      await this.fail(
        op,
        'The provider could not be reached. Nothing was moved.',
      );
      await this.keys.release(scope);
      throw err.toHttpException();
    }
    if (!err || (err.recordMayExist && err.kind !== 'insufficient_funds')) {
      // Money may have moved. Pending until the provider says: never sent again.
      this.logger.warn(
        `fx ${op.id}: outcome unknown (${err?.kind ?? 'error'}); pending until the provider says`,
      );
      const view = present(
        (await this.prisma.fxOperation.findUnique({ where: { id: op.id } })) ??
          op,
      );
      await this.keys.finish(scope, 201, successBody(view));
      return view;
    }
    const mapped = providerFailure(e, { currency });
    const reason =
      mapped instanceof MoneyError
        ? mapped.message
        : 'The provider did not complete it.';
    await this.fail(op, reason);
    await this.keys.release(scope);
    throw mapped;
  }

  private async fail(op: FxOperation, reason: string): Promise<void> {
    await this.prisma.fxOperation.updateMany({
      where: { id: op.id, status: 'pending', providerTransferId: null },
      data: {
        status: 'failed',
        failureReason: reason,
        completedAt: new Date(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // The sweep: pending operations the provider has since settled
  // -------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_MINUTE, { name: 'fx-operations-sweep' })
  async sweepScheduled(): Promise<void> {
    if (!this.port.supported) return;
    try {
      await this.sweep();
    } catch (e) {
      this.logger.error(
        `fx sweep failed (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  async sweep(now: Date = new Date()): Promise<number> {
    this.port.get();
    const before = new Date(now.getTime() - SWEEP_AFTER_MS);
    const rows = await this.prisma.fxOperation.findMany({
      where: {
        provider: this.port.name,
        OR: [
          { status: 'pending', createdAt: { lt: before } },
          { status: 'completed', feeLeg: 'owed' },
          { status: 'completed', feeLeg: { startsWith: 'owed:' } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    let settled = 0;
    for (const op of rows) {
      try {
        if (await this.settleOne(op, now)) settled += 1;
      } catch (e) {
        this.logger.warn(
          `fx sweep ${op.id}: ${e instanceof Error ? e.name : 'error'}`,
        );
      }
    }
    return settled;
  }

  /** Asks the provider about one operation now (a webhook named it) and settles it. */
  async refreshOperation(
    id: string,
  ): Promise<'settled' | 'pending' | 'unknown'> {
    const op = await this.prisma.fxOperation.findUnique({ where: { id } });
    if (!op || op.provider !== this.port.name) return 'unknown';
    if (op.status === 'completed' && !feeOwed(op.feeLeg)) return 'settled';
    return (await this.settleOne(op, new Date())) ? 'settled' : 'pending';
  }

  /** True when the operation is settled (completed or failed) after this look. */
  private async settleOne(op: FxOperation, now: Date): Promise<boolean> {
    const fx = this.port.get();
    const wallet = await this.walletOf(op.wawuUserId);
    if (!wallet) return false;
    if (op.status === 'completed') {
      await this.feeLeg(wallet, op);
      return true;
    }
    if (op.status !== 'pending') return true;
    const person = this.port.person(wallet);
    const fromRow = op.fromAccountId
      ? await this.prisma.fxAccount.findUnique({
          where: { id: op.fromAccountId },
        })
      : null;
    const look = op.providerTransferId
      ? await fx.readTransfer(person, op.providerTransferId)
      : await fx.findTransferByReference(
          person,
          fromRow?.providerAccountId ?? this.nairaAccountId(wallet),
          op.reference,
        );
    if (look.state === 'found') {
      const updated = await this.record(op, look.transfer);
      if (updated.status === 'completed') await this.finish(wallet, updated);
      return updated.status !== 'pending';
    }
    if (
      look.state === 'absent' &&
      now.getTime() - op.createdAt.getTime() > SWEEP_GIVE_UP_MS
    ) {
      await this.prisma.fxOperation.updateMany({
        where: { id: op.id, status: 'pending' },
        data: {
          status: 'failed',
          failureReason: 'The provider has no record of it. Nothing was moved.',
          completedAt: now,
        },
      });
      return true;
    }
    return false;
  }

  /** The naira wallet's account id inside a Nuvion wallet id (`<entity>:<account>`). */
  private nairaAccountId(wallet: Pick<OpenWallet, 'walletId'>): string {
    return wallet.walletId.split(':')[1] ?? wallet.walletId;
  }

  private async walletOf(wawuUserId: string): Promise<OpenWallet | null> {
    const w = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
    });
    // WALLET-41: a person outside Nigeria has no naira wallet; their operations are settled on their world wallet.
    if (!w) return worldWalletOf(this.prisma, wawuUserId);
    if (w.provider !== this.port.name || !w.walletId || !w.accountNumber)
      return null;
    return {
      wawuUserId,
      customerId: w.customerId,
      walletId: w.walletId,
      accountNumber: w.accountNumber,
    };
  }

  // -------------------------------------------------------------------------
  // Shared checks
  // -------------------------------------------------------------------------

  private async operationOf(
    wallet: OpenWallet,
    id: string,
    kind: 'swap' | 'send',
  ): Promise<FxOperation> {
    const op = await this.prisma.fxOperation.findUnique({ where: { id } });
    if (
      !op ||
      op.wawuUserId !== wallet.wawuUserId ||
      op.kind !== kind ||
      op.provider !== this.port.name
    ) {
      throw new MoneyError('not_found', 'We could not find that.');
    }
    return op;
  }

  private requireOn(
    product: 'swap' | 'crypto_send',
    ...codes: FxQuoteCode[]
  ): void {
    if (!this.settings.productOn(product)) {
      throw new MoneyError(
        'fx_switched_off',
        product === 'swap'
          ? 'Swaps are switched off for now.'
          : 'Sending crypto is switched off for now.',
      );
    }
    for (const c of codes) {
      if (!this.settings.currencyOn(c)) {
        throw new MoneyError(
          'fx_switched_off',
          `${c} is switched off for now.`,
        );
      }
    }
  }

  /** A side of a swap: the naira wallet, or one of the person's own open foreign accounts. */
  private async side(
    wallet: OpenWallet,
    currency: FxQuoteCode,
    accountId: string | undefined,
  ): Promise<{ row: FxAccount | null; side: ProviderFxSide }> {
    if (currency === 'NGN') {
      if (accountId)
        throw new BadRequestException('the naira wallet takes no account id');
      // WALLET-41: a world wallet has no naira account to swap from or into.
      if (!wallet.walletId) {
        throw new MoneyError(
          'fx_account_not_open',
          'You have no naira account. Swap between your other accounts.',
        );
      }
      return { row: null, side: { currency: 'NGN', accountId: null } };
    }
    if (!accountId)
      throw new BadRequestException(`${currency} needs its account id`);
    const row = await this.accounts.rowFor(wallet.wawuUserId, accountId);
    if (row.currency !== currency)
      throw new BadRequestException('that account is not in that currency');
    if (!row.providerAccountId || row.status === 'opening') {
      throw new MoneyError(
        'fx_account_not_open',
        'That account is not open yet.',
      );
    }
    if (row.status === 'frozen') {
      throw new MoneyError(
        'account_frozen',
        'That account is frozen. Contact support.',
      );
    }
    return {
      row,
      side: { currency, accountId: row.providerAccountId, ban: row.ban },
    };
  }

  private async sendAccount(
    wallet: OpenWallet,
    accountId: string,
    chain: string,
    currency: string,
  ): Promise<FxAccount> {
    const row = await this.accounts.rowFor(wallet.wawuUserId, accountId);
    if (row.currency !== currency) {
      throw new BadRequestException(
        `that account is ${row.currency}, not ${currency}`,
      );
    }
    const def = fxCurrency(row.currency);
    if (!def || def.kind !== 'stablecoin') {
      throw new MoneyError(
        'chain_mismatch',
        'Only USDT, USDC and RLUSD are sent to an address.',
      );
    }
    if (!row.providerAccountId || row.status === 'opening') {
      throw new MoneyError(
        'fx_account_not_open',
        'That account is not open yet.',
      );
    }
    if (row.status === 'frozen') {
      throw new MoneyError(
        'account_frozen',
        'That account is frozen. Contact support.',
      );
    }
    if (row.chain !== chain) {
      throw new MoneyError(
        'chain_mismatch',
        `This account is on ${row.chain}, not ${chain}.`,
      );
    }
    return row;
  }

  /** The provider's balance covers the amount and WAWU's fee (read now; the provider enforces it again). */
  private async requireFunds(
    wallet: OpenWallet,
    from: { row: FxAccount | null; side: ProviderFxSide },
    needed: bigint,
    currency: FxQuoteCode,
  ): Promise<void> {
    let available: bigint;
    try {
      available = from.row
        ? (
            await this.port
              .get()
              .readAccount(
                this.port.person(wallet),
                from.row.providerAccountId!,
              )
          ).availableMinor
        : (await this.port.provider.getBalance({ walletId: wallet.walletId }))
            .availableKobo;
    } catch (e) {
      throw providerFailure(e, { currency });
    }
    if (available < needed) {
      throw new MoneyError(
        'insufficient_funds',
        'There is not enough in the account for this.',
        {
          currency,
          balanceMinor: num(available),
          totalMinor: num(needed),
          shortfallMinor: num(needed - available),
        },
      );
    }
  }
}
