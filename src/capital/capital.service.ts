import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CapitalOrder as OrderRow,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  insufficientFunds,
  BALANCE_CHANGED_MESSAGE,
} from '../money/insufficient-funds';
import { lagosDayStart } from '../money/limits/lagos-window';
import { WalletGate, type OpenWallet } from '../money/gate/wallet-gate';
import { MoneyError } from '../money/money-error';
import {
  type IdempotencyScope,
  IdempotencyService,
} from '../money/payments/idempotency';
import { isUniqueViolation } from '../money/prisma-unique';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import {
  type CapitalAccount,
  type CapitalOrder as ProviderOrder,
  type CapitalProductType,
  WalletProviderCapitalError,
  type WalletProviderCapital,
} from '../wallet-provider/wallet-provider-capital';
import { WalletProviderError } from '../wallet-provider/wallet-provider-error';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../wallet-provider/wallet-provider.interface';
import { capitalFeeKobo, CapitalSettings } from './capital-config';
import { CapitalLedger } from './capital-ledger';
import {
  CAPITAL_ENDED_STATES,
  isTerminalLifecycle,
  orderView,
  productView,
  readSnapshot,
  statusOf,
  withdrawBlock,
} from './capital-mapping';
import type { CapitalReserveDto } from './capital.dto';
import type {
  CapitalOrderPageView,
  CapitalOrderView,
  CapitalPortfolioView,
  CapitalProductDetailView,
  CapitalProductPageView,
  CapitalTransactionPageView,
  CapitalWithdrawalPreviewView,
} from './capital-view.type';

/** The plan setting that switches Capital on or off (default on). */
export const CAPITAL_ENABLED_SETTING = 'capital.enabled';

export const CONFIRM_ROUTE = 'POST /capital/orders/:id/confirm';
export const WITHDRAW_ROUTE = 'POST /capital/orders/:id/withdrawal';

export const UNAVAILABLE_MESSAGE = 'Capital is not available right now.';
const HELD_MESSAGE = 'This investment is on hold. Contact support to continue.';
const EXPIRED_MESSAGE = 'This reservation has run out. Start again to invest.';
const NOT_PAYABLE_MESSAGE = 'That product cannot be ordered right now.';
const TERMS_MESSAGE = 'Open and agree to the documents before you invest.';
const IN_PROGRESS_MESSAGE =
  'This is still going through. Check again in a moment.';

/** A reservation record left `reserving` this long was abandoned by a request that died. */
const RESERVING_STALE_MS = 30_000;

/** The wire body a stored answer carries (the interceptor's envelope). */
export function capitalBody(view: unknown): string {
  return JSON.stringify({ statusCode: 200, message: 'OK', data: view });
}

function fingerprintOf(dto: CapitalReserveDto): string {
  const canonical = JSON.stringify({
    a: dto.amountKobo,
    l: dto.lockInvestment === true,
    p: dto.productId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function productTypeOf(kind: string): CapitalProductType {
  return kind === 'SHARE_OFFERING' ? 'SHARE_OFFERING' : 'FIXED_RETURN';
}

@Injectable()
export class CapitalService {
  private readonly logger = new Logger(CapitalService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly settings: CapitalSettings,
    private readonly plan: PlanSettingsService,
    private readonly keys: IdempotencyService,
    private readonly gate: WalletGate,
    readonly ledger: CapitalLedger,
  ) {}

  // -------------------------------------------------------------------------
  // The switch and the provider
  // -------------------------------------------------------------------------

  /** Whether the plan setting has Capital on. */
  isOn(): boolean {
    try {
      return this.plan.number(CAPITAL_ENABLED_SETTING) !== 0;
    } catch {
      return true;
    }
  }

  /** The provider's capital calls, or the plain refusal when Capital is off or not offered. */
  private capital(): WalletProviderCapital {
    const cap = this.provider.capital;
    if (!this.isOn() || !cap || !this.provider.configured) {
      throw new MoneyError('capital_unavailable', UNAVAILABLE_MESSAGE);
    }
    return cap;
  }

  /** Whether Capital is on and the running provider serves it (for the Wallet tab's row). */
  available(): boolean {
    return this.isOn() && !!this.provider.capital && this.provider.configured;
  }

  private fail(e: unknown): never {
    if (e instanceof WalletProviderCapitalError) {
      if (e.refusal === 'reservation_expired') {
        throw new MoneyError('reservation_expired', EXPIRED_MESSAGE);
      }
      if (e.refusal === 'withdrawal_not_available') {
        throw new MoneyError(
          'withdrawal_not_available',
          'This investment cannot be withdrawn right now.',
        );
      }
      if (e.refusal === 'already_processing') {
        throw new MoneyError('idempotency_in_progress', IN_PROGRESS_MESSAGE, {
          retryAfterSeconds: 3,
        });
      }
      throw new MoneyError('target_not_payable', NOT_PAYABLE_MESSAGE);
    }
    if (e instanceof WalletProviderError) throw e.toHttpException();
    throw e;
  }

  // -------------------------------------------------------------------------
  // Reading: products, portfolio, orders
  // -------------------------------------------------------------------------

  async products(
    wallet: OpenWallet,
    q: {
      kind?: 'fixed_return' | 'share_offering';
      cursor?: string;
      limit?: number;
    },
  ): Promise<CapitalProductPageView> {
    const cap = this.capital();
    const now = new Date();
    try {
      const page = await cap.listProducts(
        { walletId: wallet.walletId },
        {
          type:
            q.kind === undefined
              ? undefined
              : productTypeOf(q.kind.toUpperCase()),
          currency: 'NGN',
          cursor: q.cursor,
          limit: q.limit,
        },
      );
      return {
        items: page.items.map((p) => productView(p, now, false)),
        nextCursor: page.nextCursor,
      };
    } catch (e) {
      this.fail(e);
    }
  }

  async product(
    wallet: OpenWallet,
    id: string,
  ): Promise<CapitalProductDetailView> {
    const cap = this.capital();
    try {
      const p = await cap.getProduct({ walletId: wallet.walletId }, id);
      if (!p)
        throw new MoneyError(
          'target_not_found',
          'We could not find that product.',
        );
      return {
        ...productView(p, new Date(), true),
        terms: {
          wawuMinKobo: this.settings.limits.minKobo,
          wawuMaxKobo: this.settings.limits.maxKobo,
          wawuFeeFlatKobo: this.settings.fee.flatKobo,
          wawuFeeBasisPoints: this.settings.fee.basisPoints,
        },
      };
    } catch (e) {
      if (e instanceof MoneyError) throw e;
      this.fail(e);
    }
  }

  async portfolio(wallet: OpenWallet): Promise<CapitalPortfolioView> {
    const cap = this.capital();
    try {
      const lines = await cap.portfolio({ walletId: wallet.walletId });
      const naira = lines.find((l) => l.currency === 'NGN');
      const holdings = await this.prisma.capitalOrder.count({
        where: {
          wawuUserId: wallet.wawuUserId,
          state: 'confirmed',
          NOT: { lifecycle: { in: ['WITHDRAWN', 'CLOSED', 'REFUNDED'] } },
        },
      });
      return {
        investedKobo: naira?.investedMinor ?? 0,
        returnKobo: naira?.returnMinor ?? null,
        valueKobo: naira?.valueMinor ?? null,
        holdings,
        otherCurrencies: lines.filter((l) => l.currency !== 'NGN').length,
      };
    } catch (e) {
      this.fail(e);
    }
  }

  /** The caller's orders, newest first. Local rows; a few holdings are refreshed from the provider. */
  async orders(
    wallet: OpenWallet,
    q: { show?: 'holding' | 'ended'; cursor?: string; limit?: number },
  ): Promise<CapitalOrderPageView> {
    this.capital();
    const take = Math.min(q.limit ?? 20, 50);
    const where: Prisma.CapitalOrderWhereInput = {
      wawuUserId: wallet.wawuUserId,
      // A reservation that never reached the provider is not an order.
      NOT: { nuvionOrderId: null },
    };
    if (q.show === 'holding') {
      where.state = { in: ['reserved', 'confirming', 'confirmed', 'review'] };
      where.NOT = [
        { nuvionOrderId: null },
        { lifecycle: { in: ['WITHDRAWN', 'CLOSED', 'REFUNDED'] } },
      ];
    } else if (q.show === 'ended') {
      where.OR = [
        { state: { in: [...CAPITAL_ENDED_STATES] } },
        { lifecycle: { in: ['WITHDRAWN', 'CLOSED', 'REFUNDED'] } },
      ];
    }
    const rows = await this.prisma.capitalOrder.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    const fresh = await Promise.all(
      page.map((r, i) =>
        i < 5 ? this.refreshIfStale(wallet, r) : Promise.resolve(r),
      ),
    );
    const now = new Date();
    return {
      items: fresh.map((r) => orderView(r, now)),
      nextCursor: rows.length > take ? page[page.length - 1].id : null,
    };
  }

  private async mine(wawuUserId: string, id: string): Promise<OrderRow> {
    const row = await this.prisma.capitalOrder.findFirst({
      where: { id, wawuUserId, NOT: { nuvionOrderId: null } },
    });
    if (!row)
      throw new MoneyError('not_found', 'We could not find that order.');
    return row;
  }

  async order(wallet: OpenWallet, id: string): Promise<CapitalOrderView> {
    this.capital();
    const row = await this.mine(wallet.wawuUserId, id);
    const fresh = await this.refresh(wallet, row);
    return orderView(fresh, new Date());
  }

  async transactions(
    wallet: OpenWallet,
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<CapitalTransactionPageView> {
    const cap = this.capital();
    const row = await this.mine(wallet.wawuUserId, id);
    const accountId = row.capitalAccountId;
    if (!accountId) return { items: [], nextCursor: null };
    try {
      const page = await cap.transactions(
        { walletId: wallet.walletId },
        accountId,
        q,
      );
      return {
        items: page.items.map((t) => ({
          id: t.id,
          event: t.eventType,
          amountKobo: t.amountMinor,
          accruedOn: t.accruedOn,
          at: t.createdAt,
        })),
        nextCursor: page.nextCursor,
      };
    } catch (e) {
      this.fail(e);
    }
  }

  // -------------------------------------------------------------------------
  // Reserving
  // -------------------------------------------------------------------------

  private assertAmount(
    amountKobo: number,
    min: number | null,
    max: number | null,
  ): void {
    const lo = Math.max(this.settings.limits.minKobo ?? 1, min ?? 1);
    const hiCandidates = [this.settings.limits.maxKobo, max].filter(
      (v): v is number => v !== null,
    );
    const hi = hiCandidates.length > 0 ? Math.min(...hiCandidates) : null;
    if (amountKobo < lo || (hi !== null && amountKobo > hi)) {
      throw new MoneyError(
        'amount_out_of_range',
        hi !== null && amountKobo > hi
          ? 'That is more than this product takes.'
          : 'That is less than this product takes.',
        { minimumKobo: lo, ...(hi !== null ? { maximumKobo: hi } : {}) },
      );
    }
  }

  private async availableKobo(wallet: OpenWallet): Promise<number> {
    try {
      const b = await this.provider.getBalance({ walletId: wallet.walletId });
      return Number(b.availableKobo);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Today's total in the Lagos day, for the daily limit (confirmed and confirming orders). */
  private async todayKobo(wawuUserId: string, now: Date): Promise<number> {
    const rows = await this.prisma.capitalOrder.findMany({
      where: {
        wawuUserId,
        state: { in: ['confirming', 'confirmed', 'review'] },
        updatedAt: { gte: lagosDayStart(now) },
      },
      select: { totalDebitMinor: true, amountMinor: true, feeKobo: true },
    });
    return rows.reduce(
      (sum, r) =>
        sum + Number(r.totalDebitMinor ?? r.amountMinor) + Number(r.feeKobo),
      0,
    );
  }

  private async assertDaily(
    wawuUserId: string,
    addKobo: number,
    now: Date,
  ): Promise<void> {
    const cap = this.settings.limits.dailyMaxKobo;
    if (cap === null) return;
    const today = await this.todayKobo(wawuUserId, now);
    if (today + addKobo > cap) {
      throw new MoneyError(
        'limit_reached',
        'That passes the most you can invest in a day.',
        {
          limit: 'daily',
        },
      );
    }
  }

  async reserve(
    wallet: OpenWallet,
    dto: CapitalReserveDto,
    key: string,
  ): Promise<CapitalOrderView> {
    const cap = this.capital();
    if (dto.agreedToDocuments !== true) {
      throw new MoneyError('target_not_payable', TERMS_MESSAGE);
    }
    const fingerprint = fingerprintOf(dto);
    const now = new Date();

    // 1. The product, as the provider offers it to this person.
    let product;
    try {
      product = await cap.getProduct(
        { walletId: wallet.walletId },
        dto.productId,
      );
    } catch (e) {
      this.fail(e);
    }
    if (!product) {
      throw new MoneyError(
        'target_not_found',
        'We could not find that product.',
      );
    }
    const shown = productView(product, now, false);
    if (!shown.orderable) {
      throw new MoneyError('target_not_payable', NOT_PAYABLE_MESSAGE);
    }
    this.assertAmount(dto.amountKobo, product.minMinor, product.maxMinor);
    const fee = capitalFeeKobo(this.settings.fee, dto.amountKobo);
    const needed = dto.amountKobo + fee;
    await this.assertDaily(wallet.wawuUserId, needed, now);
    const balance = await this.availableKobo(wallet);
    if (balance < needed) throw insufficientFunds(balance, needed);

    // 2. Decide under a short lock: one row per (person, key).
    let row: OrderRow;
    try {
      row = await this.prisma.capitalOrder.create({
        data: {
          wawuUserId: wallet.wawuUserId,
          reserveKey: key,
          fingerprint,
          state: 'reserving',
          productId: product.id,
          productName: product.name,
          productType: product.type,
          currency: product.currency,
          amountMinor: BigInt(dto.amountKobo),
          feeKobo: BigInt(fee),
          feeState: fee > 0 ? 'owed' : 'none',
        },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await this.prisma.capitalOrder.findUnique({
        where: {
          wawuUserId_reserveKey: {
            wawuUserId: wallet.wawuUserId,
            reserveKey: key,
          },
        },
      });
      if (!existing) throw e;
      if (existing.fingerprint !== fingerprint) {
        throw new MoneyError(
          'idempotency_key_reused',
          'This key was already used for a different order. Start again.',
        );
      }
      if (existing.state !== 'reserving') return orderView(existing, now);
      if (now.getTime() - existing.updatedAt.getTime() < RESERVING_STALE_MS) {
        throw new MoneyError('idempotency_in_progress', IN_PROGRESS_MESSAGE, {
          retryAfterSeconds: 2,
        });
      }
      // A request that died before the provider answered: ask again. A
      // stray reservation it may have left lapses by itself in minutes.
      row = existing;
      await this.prisma.capitalOrder.update({
        where: { id: row.id },
        data: { updatedAt: now },
      });
    }

    // 3. Call the provider holding nothing.
    try {
      const reserved = await cap.reserve(
        { walletId: wallet.walletId },
        {
          productId: product.id,
          type: product.type,
          amountMinor: dto.amountKobo,
          lockInvestment: dto.lockInvestment === true,
        },
      );
      const updated = await this.prisma.capitalOrder.update({
        where: { id: row.id },
        data: {
          state: 'reserved',
          nuvionOrderId: reserved.orderId,
          expiresAt: new Date(reserved.expiresAt),
          totalDebitMinor: BigInt(reserved.quote.totalDebitMinor),
          snapshot: {
            quote: reserved.quote,
            account: null,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return orderView(updated, new Date());
    } catch (e) {
      const definite =
        e instanceof WalletProviderError &&
        !e.recordMayExist &&
        e.kind !== 'unavailable';
      if (e instanceof WalletProviderCapitalError || definite) {
        // Nothing was reserved: give the key back so the person can correct and retry.
        await this.prisma.capitalOrder
          .delete({ where: { id: row.id } })
          .catch(() => undefined);
      }
      this.fail(e);
    }
  }

  // -------------------------------------------------------------------------
  // Confirming (the only call that moves money)
  // -------------------------------------------------------------------------

  /**
   * The checks that come BEFORE the PIN: the order is the caller's and still
   * open, not held by an admin, within the daily limit, and the balance
   * covers the product and WAWU's fee. A request that cannot succeed answers
   * here and uses no PIN try.
   */
  async assertMayConfirm(wawuUserId: string, id: string): Promise<void> {
    this.capital();
    const wallet = await this.gate.requireOpen(wawuUserId);
    const row = await this.prisma.capitalOrder.findFirst({
      where: { id, wawuUserId, NOT: { nuvionOrderId: null } },
    });
    if (!row)
      throw new MoneyError('not_found', 'We could not find that order.');
    const now = new Date();
    if (row.state === 'confirmed' || row.state === 'review') return;
    if (row.frozenAt !== null || row.state === 'cancelled') {
      throw new MoneyError('capital_unavailable', HELD_MESSAGE);
    }
    if (row.state === 'confirming') return;
    const status = statusOf(row, now);
    if (row.state !== 'reserved' || status === 'expired') {
      throw new MoneyError('reservation_expired', EXPIRED_MESSAGE);
    }
    if (
      row.expiresAt !== null &&
      row.expiresAt.getTime() - now.getTime() <
        this.settings.expirySafetySeconds * 1000
    ) {
      throw new MoneyError('reservation_expired', EXPIRED_MESSAGE);
    }
    const total =
      Number(row.totalDebitMinor ?? row.amountMinor) + Number(row.feeKobo);
    await this.assertDaily(wawuUserId, total, now);
    const balance = await this.availableKobo(wallet);
    if (balance < total) throw insufficientFunds(balance, total);
  }

  async confirm(
    wallet: OpenWallet,
    id: string,
    scope: IdempotencyScope,
  ): Promise<CapitalOrderView> {
    const cap = this.capital();
    let row = await this.mine(wallet.wawuUserId, id);
    if (row.state === 'confirmed' || row.state === 'review') {
      // Already through (a second device, a lost answer): the order as it stands.
      const view = orderView(await this.refresh(wallet, row), new Date());
      await this.keys.finish(scope, 201, capitalBody(view));
      return view;
    }

    // Decide under a short lock, and link the key to the order.
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.capitalOrder.updateMany({
        where: {
          id: row.id,
          state: { in: ['reserved', 'confirming'] },
          frozenAt: null,
          cancelledAt: null,
        },
        data: { state: 'confirming' },
      });
      if (count !== 1) {
        throw new MoneyError('capital_unavailable', HELD_MESSAGE);
      }
      await this.keys.attach(tx, scope, row.id);
    });
    row = await this.mine(wallet.wawuUserId, id);

    // Call the provider holding nothing. A repeat resumes; it never debits twice.
    try {
      const conf = await cap.confirm(
        { walletId: wallet.walletId },
        row.nuvionOrderId!,
      );
      if (conf.status === 'APPROVED') {
        const done = await this.settleApproved(
          wallet,
          row,
          conf.capitalAccountId,
          conf.userCapitalAccountId,
        );
        const view = orderView(done, new Date());
        await this.keys.finish(scope, 201, capitalBody(view));
        return view;
      }
      return await this.stillConfirming(row, scope);
    } catch (e) {
      return this.afterConfirmFailure(wallet, row, scope, e);
    }
  }

  private async stillConfirming(
    row: OrderRow,
    scope: IdempotencyScope,
  ): Promise<CapitalOrderView> {
    const current = await this.mine(row.wawuUserId, row.id);
    const view = orderView(current, new Date());
    await this.keys.finish(scope, 201, capitalBody(view));
    return view;
  }

  private async afterConfirmFailure(
    wallet: OpenWallet,
    row: OrderRow,
    scope: IdempotencyScope,
    e: unknown,
  ): Promise<CapitalOrderView> {
    const cap = this.capital();
    // The provider's words for "this can no longer be confirmed" also cover
    // an order that WAS confirmed (dev: a repeat answers 400, not the first
    // result), so the order itself is read before anything is said.
    if (
      e instanceof WalletProviderCapitalError &&
      (e.refusal === 'reservation_expired' ||
        e.refusal === 'already_processing')
    ) {
      let seen: ProviderOrder | null = null;
      try {
        seen = await cap.getOrder(
          { walletId: wallet.walletId },
          row.nuvionOrderId!,
        );
      } catch {
        seen = null;
      }
      if (seen?.status === 'APPROVED') {
        const done = await this.settleApproved(
          wallet,
          row,
          seen.account?.id ?? null,
          null,
          seen,
        );
        const view = orderView(done, new Date());
        await this.keys.finish(scope, 201, capitalBody(view));
        return view;
      }
      if (
        seen === null ||
        seen.status === 'CONFIRMING' ||
        seen.status === 'RECOVERY_REQUIRED'
      ) {
        if (seen?.status === 'RECOVERY_REQUIRED') {
          await this.prisma.capitalOrder.update({
            where: { id: row.id },
            data: { state: 'review' },
          });
        }
        return this.stillConfirming(row, scope);
      }
      const ended = seen.status === 'REJECTED' ? 'rejected' : 'expired';
      await this.prisma.capitalOrder.update({
        where: { id: row.id },
        data: { state: ended, lastCheckedAt: new Date() },
      });
      await this.keys.release(scope);
      throw new MoneyError('reservation_expired', EXPIRED_MESSAGE);
    }
    if (e instanceof WalletProviderError && e.kind === 'insufficient_funds') {
      await this.prisma.capitalOrder.updateMany({
        where: { id: row.id, state: 'confirming' },
        data: { state: 'reserved' },
      });
      await this.keys.release(scope);
      const total =
        Number(row.totalDebitMinor ?? row.amountMinor) + Number(row.feeKobo);
      const balance = await this.availableKobo(wallet);
      throw balance < total
        ? insufficientFunds(balance, total)
        : new MoneyError('insufficient_funds', BALANCE_CHANGED_MESSAGE);
    }
    if (
      e instanceof WalletProviderError &&
      !(e instanceof WalletProviderCapitalError) &&
      !e.recordMayExist &&
      e.kind !== 'unavailable' &&
      e.kind !== 'rate_limited'
    ) {
      // A definite refusal (a limit, an auth problem, a validation): nothing moved.
      await this.prisma.capitalOrder.updateMany({
        where: { id: row.id, state: 'confirming' },
        data: { state: 'reserved' },
      });
      await this.keys.release(scope);
      throw e.toHttpException();
    }
    // Unknown outcome: the provider may have taken the money. Keep the order
    // confirming, say so, and let the sweep read the order back.
    this.logger.warn(
      `capital order ${row.id}: the confirm's outcome is not known yet`,
    );
    return this.stillConfirming(row, scope);
  }

  /**
   * The provider approved the order: record it, the money out, and WAWU's
   * fee. Idempotent: a second call (the sweep, a webhook) finds it done.
   */
  async settleApproved(
    wallet: { wawuUserId: string; walletId: string; accountNumber: string },
    row: OrderRow,
    capitalAccountId: string | null,
    userCapitalAccountId: string | null,
    seen?: ProviderOrder | null,
  ): Promise<OrderRow> {
    const cap = this.provider.capital!;
    let order = seen ?? null;
    if (!order) {
      try {
        order = await cap.getOrder(
          { walletId: wallet.walletId },
          row.nuvionOrderId!,
        );
      } catch {
        order = null;
      }
    }
    const account = order?.account ?? null;
    const snap = readSnapshot(row);
    const updated = await this.prisma.capitalOrder.update({
      where: { id: row.id },
      data: {
        state: 'confirmed',
        confirmedAt:
          row.confirmedAt ??
          (order?.confirmedAt ? new Date(order.confirmedAt) : new Date()),
        capitalAccountId:
          capitalAccountId ?? account?.id ?? row.capitalAccountId,
        userCapitalAccountId: userCapitalAccountId ?? row.userCapitalAccountId,
        lifecycle: account?.lifecycle ?? row.lifecycle ?? 'ACTIVE',
        payoutStatus: account?.payoutStatus ?? row.payoutStatus,
        lastCheckedAt: new Date(),
        snapshot: {
          quote: snap.quote,
          account: account ?? snap.account,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await this.ledger.recordPurchase(updated, wallet.accountNumber);
    await this.collectFee(updated, wallet);
    return updated;
  }

  /** Takes WAWU's fee, once, after the purchase. Zero by default: nothing happens. */
  async collectFee(
    row: OrderRow,
    wallet: { wawuUserId: string; walletId: string; accountNumber: string },
  ): Promise<void> {
    if (row.feeState !== 'owed' || Number(row.feeKobo) <= 0) return;
    const reference = row.feeReference ?? `wawu-capfee-${row.id}`;
    try {
      const to = await this.provider.getPlatformAccount();
      const receipt = await this.provider.walletToWallet({
        fromAccountNumber: wallet.accountNumber,
        toAccountNumber: to.accountNumber,
        amountKobo: row.feeKobo,
        reference,
        narration: 'Capital fee',
      });
      await this.prisma.capitalOrder.update({
        where: { id: row.id },
        data: {
          feeState: receipt.pending ? 'owed' : 'paid',
          feeReference: reference,
        },
      });
      if (!receipt.pending) {
        await this.ledger.recordFee(
          row,
          wallet.accountNumber,
          reference,
          receipt.providerReference,
        );
      }
    } catch (e) {
      // The investment stands; the fee is tried again by the sweep. The
      // person is never charged twice (the reference is fixed) and never
      // refused for a fee that could not be taken.
      await this.prisma.capitalOrder
        .update({ where: { id: row.id }, data: { feeReference: reference } })
        .catch(() => undefined);
      this.logger.error(
        `capital order ${row.id}: the fee was not taken (${e instanceof Error ? e.name : 'error'}); the sweep tries again`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Withdrawing
  // -------------------------------------------------------------------------

  async assertMayWithdraw(wawuUserId: string, id: string): Promise<void> {
    this.capital();
    await this.gate.requireOpen(wawuUserId);
    const row = await this.prisma.capitalOrder.findFirst({
      where: { id, wawuUserId, NOT: { nuvionOrderId: null } },
    });
    if (!row)
      throw new MoneyError('not_found', 'We could not find that order.');
    if (row.frozenAt !== null)
      throw new MoneyError('capital_unavailable', HELD_MESSAGE);
    const snap = readSnapshot(row);
    const block = withdrawBlock(row, snap.account, snap.quote, new Date());
    if (block !== null && block !== 'in_progress') {
      throw new MoneyError(
        'withdrawal_not_available',
        'This investment cannot be withdrawn right now.',
      );
    }
  }

  async preview(
    wallet: OpenWallet,
    id: string,
  ): Promise<CapitalWithdrawalPreviewView> {
    const cap = this.capital();
    const row = await this.mine(wallet.wawuUserId, id);
    try {
      const p = await cap.withdrawalPreview(
        { walletId: wallet.walletId },
        row.nuvionOrderId!,
      );
      return {
        early: p.penaltyRate > 0 || row.lifecycle !== 'MATURED',
        grossInterestKobo: p.grossInterestMinor,
        penaltyRate: p.penaltyRate,
        penaltyKobo: p.penaltyMinor,
        deductionsKobo: p.deductionsMinor,
        netPayoutKobo: p.netPayoutMinor,
        daysHeld: p.daysElapsed,
      };
    } catch (e) {
      this.fail(e);
    }
  }

  async withdraw(
    wallet: OpenWallet,
    id: string,
    scope: IdempotencyScope,
  ): Promise<CapitalOrderView> {
    const cap = this.capital();
    const row = await this.mine(wallet.wawuUserId, id);
    if (row.frozenAt !== null)
      throw new MoneyError('capital_unavailable', HELD_MESSAGE);
    await this.prisma.$transaction(async (tx) => {
      await tx.capitalOrder.update({
        where: { id: row.id },
        data: { withdrawRequestedAt: row.withdrawRequestedAt ?? new Date() },
      });
      await this.keys.attach(tx, scope, row.id);
    });
    try {
      const after = await cap.withdraw(
        { walletId: wallet.walletId },
        row.nuvionOrderId!,
      );
      const saved = await this.saveHolding(row, after.account);
      const view = orderView(saved, new Date());
      await this.keys.finish(scope, 201, capitalBody(view));
      await this.afterHoldingChange(wallet, saved);
      return view;
    } catch (e) {
      // Starting a payout is safe to repeat, so a lost answer gives the key
      // back: the person's next try reads the order and finds it going out.
      if (
        e instanceof WalletProviderCapitalError &&
        e.refusal === 'withdrawal_not_available'
      ) {
        const fresh = await this.refresh(wallet, row);
        const view = orderView(fresh, new Date());
        if (
          statusOf(fresh, new Date()) === 'paying_out' ||
          statusOf(fresh, new Date()) === 'paid_out'
        ) {
          await this.keys.finish(scope, 201, capitalBody(view));
          return view;
        }
      }
      await this.keys.release(scope);
      this.fail(e);
    }
  }

  // -------------------------------------------------------------------------
  // Keeping the local side current
  // -------------------------------------------------------------------------

  /** Writes the holding the provider reports onto the row. */
  async saveHolding(
    row: OrderRow,
    account: CapitalAccount | null,
  ): Promise<OrderRow> {
    if (!account) return row;
    const snap = readSnapshot(row);
    return this.prisma.capitalOrder.update({
      where: { id: row.id },
      data: {
        lifecycle: account.lifecycle ?? row.lifecycle,
        payoutStatus: account.payoutStatus ?? row.payoutStatus,
        capitalAccountId: account.id,
        lastCheckedAt: new Date(),
        snapshot: {
          quote: snap.quote,
          account,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** Records the payout once the holding has paid out. */
  async afterHoldingChange(
    wallet: { wawuUserId: string; accountNumber: string },
    row: OrderRow,
  ): Promise<void> {
    if (isTerminalLifecycle(row.lifecycle) && row.state === 'confirmed') {
      await this.ledger.recordPayout(row, wallet.accountNumber, null);
    }
  }

  private async refreshIfStale(
    wallet: OpenWallet,
    row: OrderRow,
  ): Promise<OrderRow> {
    const open =
      row.state === 'confirming' ||
      (row.state === 'confirmed' && !isTerminalLifecycle(row.lifecycle));
    const age = row.lastCheckedAt
      ? Date.now() - row.lastCheckedAt.getTime()
      : Infinity;
    return open && age > 120_000 ? this.refresh(wallet, row) : row;
  }

  /**
   * Reads the order from the provider and brings the row up to date. A
   * provider that cannot be reached leaves the row as it is: what the person
   * sees is the last thing read, never a guess.
   */
  async refresh(
    wallet: { wawuUserId: string; walletId: string; accountNumber: string },
    row: OrderRow,
  ): Promise<OrderRow> {
    if (!row.nuvionOrderId || !this.provider.capital) return row;
    if (CAPITAL_ENDED_STATES.includes(row.state as never)) return row;
    let seen: ProviderOrder | null;
    try {
      seen = await this.provider.capital.getOrder(
        { walletId: wallet.walletId },
        row.nuvionOrderId,
      );
    } catch {
      return row;
    }
    if (!seen) return row;
    if (
      seen.status === 'APPROVED' &&
      (row.state === 'confirming' || row.state === 'reserved')
    ) {
      return this.settleApproved(
        wallet,
        row,
        seen.account?.id ?? null,
        null,
        seen,
      );
    }
    if (row.state === 'confirming' || row.state === 'reserved') {
      if (seen.status === 'EXPIRED' || seen.status === 'REJECTED') {
        return this.prisma.capitalOrder.update({
          where: { id: row.id },
          data: {
            state: seen.status === 'REJECTED' ? 'rejected' : 'expired',
            lastCheckedAt: new Date(),
          },
        });
      }
      if (seen.status === 'RECOVERY_REQUIRED') {
        return this.prisma.capitalOrder.update({
          where: { id: row.id },
          data: { state: 'review', lastCheckedAt: new Date() },
        });
      }
      if (row.state === 'confirming' && seen.status === 'RESERVED') {
        const live = seen.expiresAt
          ? new Date(seen.expiresAt).getTime() > Date.now()
          : false;
        return this.prisma.capitalOrder.update({
          where: { id: row.id },
          data: {
            state: live ? 'reserved' : 'expired',
            lastCheckedAt: new Date(),
          },
        });
      }
      return row;
    }
    if (seen.account) {
      const saved = await this.saveHolding(row, seen.account);
      await this.afterHoldingChange(wallet, saved);
      return saved;
    }
    return row;
  }

  /** The wallet of a person for the sweep and the handler (no request, so no gate). */
  async walletOf(wawuUserId: string): Promise<{
    wawuUserId: string;
    walletId: string;
    accountNumber: string;
  } | null> {
    const w = await this.prisma.fintavaWallet.findFirst({
      where: { wawuUserId, provider: this.provider.name },
      select: { walletId: true, accountNumber: true },
    });
    return w
      ? { wawuUserId, walletId: w.walletId, accountNumber: w.accountNumber }
      : null;
  }
}
