import type {
  CapitalAccount,
  CapitalConfirmation,
  CapitalDeductible,
  CapitalDocument,
  CapitalListQuery,
  CapitalOrder,
  CapitalPage,
  CapitalPortfolioLine,
  CapitalProduct,
  CapitalProductType,
  CapitalQuote,
  CapitalRateBand,
  CapitalReservation,
  CapitalTransaction,
  CapitalWallet,
  CapitalWithdrawalPreview,
  WalletProviderCapital,
} from '../../wallet-provider/wallet-provider-capital';
import {
  CAPITAL_PRODUCT_TYPES,
  WalletProviderCapitalError,
} from '../../wallet-provider/wallet-provider-capital';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { maskNuvionText, NuvionError } from '../nuvion-error';
import { isNuvionId, NUVION_NAIRA, readNuvionWalletId } from './accounts';

const AREA = 'capital (NUV-12)';

/**
 * Capital (task NUV-12, R-84): Nuvion's fixed-return and share-offering
 * products, `/products`, `/product-orders`, `/capital-portfolio` and
 * `/capital-transactions` (nuvion docs: core-concepts/capital,
 * api-reference/capital), as dev answered them on 24 Oct 2026
 * (mobile docs/nuvion/DEV-RESULTS.md, "Capital"). This file is the only
 * place that knows Nuvion's words for them. Reached only through
 * `WalletProvider.capital`.
 *
 * Orders are funded from the person's naira account (the one in their wallet
 * id): a product in another currency is never listed or ordered until the
 * other currency accounts are built. Nothing here moves money except
 * `confirm` and `withdraw`, which Nuvion repeats safely (a repeat resumes
 * from the stored order and never debits twice).
 *
 * Facts dev showed that the docs do not state, and that the readers allow for:
 * - a third product kind, `PRIVATE_EQUITY`, with no terms: left out;
 * - a share offering's `availability` may carry `orderable` and `reason`
 *   (`sale_window_closed`), and its `config.share_offering` an `offer_stage`;
 * - a document's name carries its extension ("Terms & Conditions.pdf"), and
 *   every one is affirmed by that exact name;
 * - `capital-transactions` filters by `capital_id`, the capital ACCOUNT's id
 *   (the order's id answers an empty list, not an error);
 * - a withdrawal before the first day is allowed when the product allows an
 *   early exit (`early_action_date` was the confirmation moment);
 * - on dev a payout settled within seconds.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** A whole number of minor units (or a count). Anything else is absent. */
function whole(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

/** A decimal the provider states (a rate). */
function decimal(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function flag(o: Record<string, unknown>, key: string): boolean | null {
  const v = o[key];
  return typeof v === 'boolean' ? v : null;
}

/** Unix milliseconds to an ISO time; absent for null, zero or nonsense. */
function when(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function productType(v: unknown): CapitalProductType | null {
  return typeof v === 'string' &&
    (CAPITAL_PRODUCT_TYPES as readonly string[]).includes(v)
    ? (v as CapitalProductType)
    : null;
}

function deductibles(raw: unknown): CapitalDeductible[] {
  if (!Array.isArray(raw)) return [];
  const out: CapitalDeductible[] = [];
  for (const d of raw) {
    if (!isRecord(d)) continue;
    const name = text(d, 'name');
    const value = decimal(d, 'value');
    const valueType = d.value_type;
    const appliesTo = d.applicable_to;
    if (
      !name ||
      value === null ||
      (valueType !== 'flat' && valueType !== 'percentage') ||
      (appliesTo !== 'principal' && appliesTo !== 'interest')
    ) {
      continue;
    }
    out.push({ name, value, valueType, appliesTo });
  }
  return out;
}

function documents(raw: unknown): CapitalDocument[] {
  if (!Array.isArray(raw)) return [];
  const out: CapitalDocument[] = [];
  for (const d of raw) {
    if (!isRecord(d)) continue;
    const name = text(d, 'name');
    const url = text(d, 'url');
    if (name && url && /^https:\/\//i.test(url)) out.push({ name, url });
  }
  return out;
}

/** A product object (a list row or the detail). Null for a kind this build does not serve. */
export function readCapitalProduct(raw: unknown): CapitalProduct | null {
  if (!isRecord(raw)) return null;
  const id = text(raw, 'id');
  const type = productType(raw.capital_product_type);
  const name = text(raw, 'name');
  const currency = text(raw, 'currency')?.toUpperCase();
  if (!isNuvionId(id) || !type || !name || !currency) return null;
  const config = isRecord(raw.config) ? raw.config : {};
  const principal = isRecord(config.principal) ? config.principal : {};
  const tenor = isRecord(config.tenor) ? config.tenor : {};
  const rates = isRecord(config.rates) ? config.rates : {};
  const interest = isRecord(rates.interest) ? rates.interest : {};
  const orders = isRecord(config.orders) ? config.orders : {};
  const liquidation = isRecord(orders.liquidation) ? orders.liquidation : {};
  const so = isRecord(config.share_offering) ? config.share_offering : null;
  const avail = isRecord(raw.availability) ? raw.availability : null;

  const bands: CapitalRateBand[] = [];
  if (Array.isArray(interest.bands)) {
    for (const b of interest.bands) {
      if (!isRecord(b)) continue;
      const bandName = text(b, 'name');
      const rate = decimal(b, 'rate');
      if (!bandName || rate === null) continue;
      bands.push({
        name: bandName,
        rate,
        minMinor: whole(b, 'min_principal_amount'),
        maxMinor: whole(b, 'max_principal_amount'),
      });
    }
  }

  return {
    id,
    type,
    name,
    currency,
    startsAt: when(raw, 'start_date'),
    endsAt: when(raw, 'end_date'),
    minMinor: whole(principal, 'min'),
    maxMinor: whole(principal, 'max'),
    tenorDays: whole(tenor, 'tenor_days'),
    earliestWithdrawalDays: whole(tenor, 'earliest_withdrawal_days'),
    annualRate: decimal(interest, 'primary'),
    rateBands: bands,
    allowEarlyWithdrawal: flag(liquidation, 'allow_early_withdrawal'),
    deductibles: deductibles(rates.deductibles),
    documents: documents(config.documents),
    share: so
      ? {
          issuerName: text(so, 'issuer_name'),
          offerPriceMinor: whole(so, 'offer_price'),
          lockPeriodDays: whole(so, 'lock_period_days'),
          prospectusUrl: (() => {
            const u = text(so, 'prospectus_url');
            return u && /^https:\/\//i.test(u) ? u : null;
          })(),
          stage: text(so, 'offer_stage'),
        }
      : null,
    availability: avail
      ? {
          status: text(avail, 'status'),
          orderable: flag(avail, 'orderable'),
          reason: text(avail, 'reason'),
          quantity: whole(avail, 'quantity'),
        }
      : null,
  };
}

function readQuote(raw: unknown, currency: string): CapitalQuote | null {
  if (!isRecord(raw)) return null;
  const type = productType(raw.product_type);
  const total = whole(raw, 'total_debit');
  if (!type || total === null) return null;
  const penalty = isRecord(raw.penalty) ? raw.penalty : {};
  return {
    type,
    currency: text(raw, 'currency')?.toUpperCase() ?? currency,
    totalDebitMinor: total,
    principalMinor: whole(raw, 'principal'),
    tenorDays: whole(raw, 'tenor_days'),
    lockedRate: decimal(raw, 'locked_rate'),
    rateSource: text(raw, 'rate_source'),
    dayCount: whole(raw, 'day_count'),
    locked: flag(raw, 'is_locked'),
    allowEarlyWithdrawal: flag(raw, 'allow_early_withdrawal'),
    earliestWithdrawalDays: whole(raw, 'earliest_withdrawal_days'),
    penaltyRate: decimal(penalty, 'primary'),
    deductibles: deductibles(raw.deductibles),
    requestedMinor: whole(raw, 'requested_amount'),
    requestedShares: whole(raw, 'requested_shares'),
    allocatedShares: whole(raw, 'allocated_shares'),
    unallocatedMinor: whole(raw, 'unallocated_amount'),
    offerPriceMinor: whole(raw, 'offer_price'),
    baseCostMinor: whole(raw, 'base_cost'),
    brokerageFeeMinor: whole(raw, 'brokerage_fee'),
    crossDealFeeMinor: whole(raw, 'cross_deal_fee'),
    lockPeriodDays: whole(raw, 'lock_period_days'),
  };
}

function last4(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function readAccount(raw: unknown): CapitalAccount | null {
  if (!isRecord(raw)) return null;
  const id = text(raw, 'id');
  const type = productType(raw.product_type);
  if (!isNuvionId(id) || !type) return null;
  const lifecycle = isRecord(raw.lifecycle) ? raw.lifecycle : {};
  return {
    id,
    type,
    currency: text(raw, 'currency')?.toUpperCase() ?? NUVION_NAIRA,
    numberLast4: last4(text(raw, 'account_number')),
    lifecycle: text(lifecycle, 'status'),
    payoutStatus:
      text(lifecycle, 'payout_status') ?? text(lifecycle, 'refund_status'),
    principalMinor: whole(raw, 'principal'),
    lockedRate: decimal(raw, 'locked_rate'),
    dayCount: whole(raw, 'day_count'),
    tenorDays: whole(raw, 'tenor_days'),
    startedAt: when(raw, 'start_date'),
    maturesAt: when(raw, 'maturity_date'),
    earlyActionAt: when(raw, 'early_action_date'),
    accruedMinor: whole(raw, 'accrued_interest'),
    dueInterestMinor: whole(raw, 'due_interest'),
    grossInterestMinor: whole(raw, 'gross_interest'),
    totalDeductionsMinor: whole(raw, 'total_deductions'),
    expectedNetPayoutMinor: whole(raw, 'expected_net_payout'),
    netPayoutMinor: whole(raw, 'net_payout'),
    settlementAt: when(raw, 'settlement_date'),
    sharesPurchased: whole(raw, 'shares_purchased'),
    unitsHeld: whole(raw, 'units_held'),
    baseCostMinor: whole(raw, 'base_cost'),
    totalDebitedMinor: whole(raw, 'total_amount_debited'),
    lockExpiresAt: when(raw, 'lock_expiry_date'),
    currentValueMinor: whole(raw, 'current_market_value'),
    pendingRefundMinor: whole(raw, 'pending_refund_amount'),
  };
}

/** An order object (a list row, the detail, or a withdrawal's answer). */
export function readCapitalOrder(raw: unknown): CapitalOrder | null {
  if (!isRecord(raw)) return null;
  const id = text(raw, 'id');
  const type = productType(raw.product_type);
  const productId = text(raw, 'product_id');
  const status = text(raw, 'status');
  const amount = whole(raw, 'amount');
  if (
    !isNuvionId(id) ||
    !type ||
    !isNuvionId(productId) ||
    !status ||
    amount === null
  ) {
    return null;
  }
  return {
    id,
    productId,
    type,
    currency: text(raw, 'currency')?.toUpperCase() ?? NUVION_NAIRA,
    amountMinor: amount,
    reservedQuantity: whole(raw, 'reserved_quantity'),
    status,
    statusReason: (() => {
      const r = text(raw, 'status_reason');
      return r ? maskNuvionText(r) : null;
    })(),
    expiresAt: when(raw, 'expires_at'),
    confirmedAt: when(raw, 'confirmed_at'),
    createdAt: when(raw, 'created'),
    account: readAccount(raw.capital_account),
    agreements: Array.isArray(raw.agreements)
      ? raw.agreements.flatMap((a) =>
          isRecord(a) && isRecord(a.document) ? documents([a.document]) : [],
        )
      : [],
  };
}

function pageOf<T>(
  raw: unknown,
  read: (row: unknown) => T | null,
): CapitalPage<T> {
  const data = isRecord(raw) ? raw : {};
  const rows = Array.isArray(data.data) ? data.data : [];
  const meta = isRecord(data.meta) ? data.meta : {};
  const pagination = isRecord(meta.pagination) ? meta.pagination : {};
  const items: T[] = [];
  for (const row of rows) {
    const item = read(row);
    if (item !== null) items.push(item);
  }
  const next =
    pagination.has_next === true ? text(pagination, 'next_cursor') : null;
  return { items, nextCursor: next && isNuvionId(next) ? next : null };
}

/** Nuvion's failure types that mean something specific for capital. */
function refusalOf(
  err: NuvionError,
  call: 'reserve' | 'confirm' | 'withdraw',
): WalletProviderCapitalError | null {
  const t = err.nuvionType;
  const make = (
    refusal: ConstructorParameters<
      typeof WalletProviderCapitalError
    >[0]['refusal'],
  ) =>
    new WalletProviderCapitalError({
      refusal,
      provider: 'nuvion',
      operation: err.operation,
      httpStatus: err.httpStatus,
      fields: err.messages.map((m) => maskNuvionText(m)).slice(0, 5),
      recordMayExist: err.recordMayExist,
    });
  if (t === 'error_resource_expired') return make('reservation_expired');
  if (t === 'error_transfer_already_processing')
    return make('already_processing');
  if (t === 'error_operation_invalid_for_state') {
    if (call === 'confirm') return make('reservation_expired');
    if (call === 'withdraw') return make('withdrawal_not_available');
    return make('not_orderable');
  }
  if (call === 'reserve' && err.httpStatus === 422)
    return make('not_orderable');
  return null;
}

/**
 * The capital calls over one Nuvion client. A person is named by the wallet
 * id the accounts area made (`<entity>:<account>`): the entity is whose
 * products, orders and portfolio these are, the account is the one an order
 * is funded from.
 */
export class NuvionCapitalArea implements WalletProviderCapital {
  readonly currencies: readonly string[] = [NUVION_NAIRA];

  constructor(private readonly client: NuvionClient) {}

  private ids(op: NuvionOp, wallet: CapitalWallet) {
    const ids = readNuvionWalletId(wallet.walletId);
    if (!ids) {
      throw new NuvionError({
        kind: 'not_found',
        operation: op.name,
        messages: [`${AREA}: the stored wallet id is not a Nuvion account`],
      });
    }
    return ids;
  }

  private checkId(op: NuvionOp, id: string): string {
    if (!isNuvionId(id)) {
      throw new NuvionError({
        kind: 'not_found',
        operation: op.name,
        messages: [`${AREA}: that is not a Nuvion id`],
      });
    }
    return encodeURIComponent(id);
  }

  async listProducts(
    wallet: CapitalWallet,
    query: CapitalListQuery,
  ): Promise<CapitalPage<CapitalProduct>> {
    const op: NuvionOp = { name: 'list capital products', call: 'read' };
    const { entityId } = this.ids(op, wallet);
    const currency = query.currency ?? NUVION_NAIRA;
    if (!this.currencies.includes(currency))
      return { items: [], nextCursor: null };
    const answer = await this.client.get<unknown>(op, '/products', {
      entity_id: entityId,
      currency,
      ...(query.type ? { capital_product_type: query.type } : {}),
      limit: Math.min(Math.max(query.limit ?? 25, 1), 100),
      ...(query.cursor && isNuvionId(query.cursor)
        ? { cursor: query.cursor }
        : {}),
    });
    const page = pageOf(answer.data, readCapitalProduct);
    return {
      ...page,
      items: page.items.filter((p) => this.currencies.includes(p.currency)),
    };
  }

  async getProduct(
    wallet: CapitalWallet,
    productId: string,
  ): Promise<CapitalProduct | null> {
    const op: NuvionOp = { name: 'get capital product', call: 'read' };
    const { entityId } = this.ids(op, wallet);
    const id = this.checkId(op, productId);
    try {
      const answer = await this.client.get<unknown>(op, `/products/${id}`, {
        entity_id: entityId,
      });
      const product = readCapitalProduct(answer.data);
      return product && this.currencies.includes(product.currency)
        ? product
        : null;
    } catch (e) {
      if (e instanceof NuvionError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  async reserve(
    wallet: CapitalWallet,
    input: {
      productId: string;
      type: CapitalProductType;
      amountMinor: number;
      lockInvestment: boolean;
    },
  ): Promise<CapitalReservation> {
    const op: NuvionOp = { name: 'reserve capital order', call: 'write' };
    const { entityId, accountId } = this.ids(op, wallet);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new RangeError('The amount is a whole number above zero.');
    }
    // The documents to affirm are the product's own, read now: one
    // affirmation for each, by the exact name (dev: "Terms & Conditions.pdf").
    const product = await this.getProduct(wallet, input.productId);
    if (!product) {
      throw new NuvionError({
        kind: 'not_found',
        operation: op.name,
        messages: [`${AREA}: the product is not offered`],
      });
    }
    const body: Record<string, unknown> = {
      product_id: product.id,
      account_id: accountId,
      entity_id: entityId,
      agreement_acceptances: product.documents.map((d) => ({
        document_name: d.name,
        action_type: 'affirmation',
      })),
    };
    if (product.type === 'FIXED_RETURN') {
      body.principal = input.amountMinor;
      body.lock_investment = input.lockInvestment;
    } else {
      body.amount = input.amountMinor;
    }
    try {
      const answer = await this.client.post<unknown>(
        op,
        '/product-orders',
        body,
      );
      const d = isRecord(answer.data) ? answer.data : {};
      const orderId = text(d, 'id');
      const currency = text(d, 'currency')?.toUpperCase() ?? product.currency;
      const quote = readQuote(d.quote, currency);
      const expiresAt = when(d, 'expires_at');
      if (!isNuvionId(orderId) || !quote || !expiresAt) {
        throw new NuvionError({
          kind: 'not_confirmed',
          operation: op.name,
          httpStatus: answer.httpStatus,
          messages: [`${AREA}: the answer is not a reservation`],
          recordMayExist: true,
          requestId: answer.requestId,
        });
      }
      return { orderId, expiresAt, currency, quote };
    } catch (e) {
      throw (e instanceof NuvionError && refusalOf(e, 'reserve')) || e;
    }
  }

  async confirm(
    wallet: CapitalWallet,
    orderId: string,
  ): Promise<CapitalConfirmation> {
    const op: NuvionOp = { name: 'confirm capital order', call: 'write' };
    const { entityId } = this.ids(op, wallet);
    const id = this.checkId(op, orderId);
    try {
      const answer = await this.client.post<unknown>(
        op,
        `/product-orders/${id}/confirm`,
        { entity_id: entityId },
      );
      const d = isRecord(answer.data) ? answer.data : {};
      const status = text(d, 'status');
      if (text(d, 'id') !== orderId || !status) {
        throw new NuvionError({
          kind: 'not_confirmed',
          operation: op.name,
          httpStatus: answer.httpStatus,
          messages: [`${AREA}: the answer is not this order`],
          recordMayExist: true,
          requestId: answer.requestId,
        });
      }
      const cap = text(d, 'capital_account_id');
      const user = text(d, 'user_capital_account_id');
      return {
        orderId,
        status,
        capitalAccountId: isNuvionId(cap) ? cap : null,
        userCapitalAccountId: isNuvionId(user) ? user : null,
      };
    } catch (e) {
      throw (e instanceof NuvionError && refusalOf(e, 'confirm')) || e;
    }
  }

  async getOrder(
    wallet: CapitalWallet,
    orderId: string,
  ): Promise<CapitalOrder | null> {
    const op: NuvionOp = { name: 'get capital order', call: 'read' };
    const { entityId } = this.ids(op, wallet);
    const id = this.checkId(op, orderId);
    try {
      const answer = await this.client.get<unknown>(
        op,
        `/product-orders/${id}`,
        {
          entity_id: entityId,
        },
      );
      return readCapitalOrder(answer.data);
    } catch (e) {
      if (e instanceof NuvionError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  async listOrders(
    wallet: CapitalWallet,
    query: CapitalListQuery,
  ): Promise<CapitalPage<CapitalOrder>> {
    const op: NuvionOp = { name: 'list capital orders', call: 'read' };
    const { entityId } = this.ids(op, wallet);
    const answer = await this.client.get<unknown>(op, '/product-orders', {
      entity_id: entityId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { product_type: query.type } : {}),
      limit: Math.min(Math.max(query.limit ?? 25, 1), 100),
      ...(query.cursor && isNuvionId(query.cursor)
        ? { cursor: query.cursor }
        : {}),
    });
    return pageOf(answer.data, readCapitalOrder);
  }

  async portfolio(wallet: CapitalWallet): Promise<CapitalPortfolioLine[]> {
    const op: NuvionOp = { name: 'capital portfolio', call: 'read' };
    const { entityId } = this.ids(op, wallet);
    const answer = await this.client.get<unknown>(op, '/capital-portfolio', {
      entity_id: entityId,
    });
    const d = isRecord(answer.data) ? answer.data : {};
    const rows = Array.isArray(d.currencies) ? d.currencies : [];
    const out: CapitalPortfolioLine[] = [];
    for (const r of rows) {
      if (!isRecord(r)) continue;
      const currency = text(r, 'currency')?.toUpperCase();
      const totals = isRecord(r.totals) ? r.totals : {};
      const inv = isRecord(totals.investment) ? totals.investment : null;
      const invested = inv ? whole(inv, 'amount_invested') : null;
      if (!currency || invested === null || !inv) continue;
      out.push({
        currency,
        investedMinor: invested,
        returnMinor: whole(inv, 'total_return'),
        valueMinor: whole(inv, 'current_value'),
      });
    }
    return out;
  }

  async transactions(
    wallet: CapitalWallet,
    capitalAccountId: string,
    query: CapitalListQuery,
  ): Promise<CapitalPage<CapitalTransaction>> {
    const op: NuvionOp = { name: 'list capital transactions', call: 'read' };
    const { entityId } = this.ids(op, wallet);
    this.checkId(op, capitalAccountId);
    const answer = await this.client.get<unknown>(op, '/capital-transactions', {
      entity_id: entityId,
      capital_id: capitalAccountId,
      limit: Math.min(Math.max(query.limit ?? 25, 1), 100),
      ...(query.cursor && isNuvionId(query.cursor)
        ? { cursor: query.cursor }
        : {}),
    });
    return pageOf(answer.data, (row): CapitalTransaction | null => {
      if (!isRecord(row)) return null;
      const id = text(row, 'id');
      const eventType = text(row, 'event_type');
      const amount = whole(row, 'amount');
      if (!isNuvionId(id) || !eventType || amount === null) return null;
      return {
        id,
        eventType,
        amountMinor: amount,
        accruedOn: when(row, 'accrual_date'),
        createdAt: when(row, 'created'),
      };
    });
  }

  async withdrawalPreview(
    wallet: CapitalWallet,
    orderId: string,
  ): Promise<CapitalWithdrawalPreview> {
    const op: NuvionOp = { name: 'preview capital withdrawal', call: 'read' };
    const { entityId } = this.ids(op, wallet);
    const id = this.checkId(op, orderId);
    try {
      const answer = await this.client.get<unknown>(
        op,
        `/product-orders/${id}/withdrawal/preview`,
        { entity_id: entityId },
      );
      const d = isRecord(answer.data) ? answer.data : {};
      const gross = whole(d, 'gross_interest');
      const net = whole(d, 'net_payout');
      const penaltyRate = decimal(d, 'penalty_rate');
      const penalty = whole(d, 'penalty_amount');
      const deductions = whole(d, 'total_deductions');
      const days = whole(d, 'days_elapsed');
      if (
        gross === null ||
        net === null ||
        penaltyRate === null ||
        penalty === null ||
        deductions === null ||
        days === null
      ) {
        throw new NuvionError({
          kind: 'bad_response',
          operation: op.name,
          httpStatus: answer.httpStatus,
          messages: [`${AREA}: the answer is not a withdrawal preview`],
          requestId: answer.requestId,
        });
      }
      return {
        grossInterestMinor: gross,
        penaltyRate,
        penaltyMinor: penalty,
        deductionsMinor: deductions,
        netPayoutMinor: net,
        daysElapsed: days,
      };
    } catch (e) {
      if (e instanceof NuvionError && e.kind === 'not_found') {
        // Dev (24 Oct): an order that is not confirmed has no capital account to preview.
        throw new WalletProviderCapitalError({
          refusal: 'withdrawal_not_available',
          provider: 'nuvion',
          operation: op.name,
          httpStatus: e.httpStatus,
        });
      }
      throw (e instanceof NuvionError && refusalOf(e, 'withdraw')) || e;
    }
  }

  async withdraw(
    wallet: CapitalWallet,
    orderId: string,
  ): Promise<CapitalOrder> {
    const op: NuvionOp = { name: 'withdraw capital order', call: 'write' };
    const { entityId } = this.ids(op, wallet);
    const id = this.checkId(op, orderId);
    try {
      const answer = await this.client.post<unknown>(
        op,
        `/product-orders/${id}/withdrawal`,
        { entity_id: entityId },
      );
      const order = readCapitalOrder(answer.data);
      if (!order || order.id !== orderId) {
        throw new NuvionError({
          kind: 'not_confirmed',
          operation: op.name,
          httpStatus: answer.httpStatus,
          messages: [`${AREA}: the answer is not this order`],
          recordMayExist: true,
          requestId: answer.requestId,
        });
      }
      return order;
    } catch (e) {
      throw (e instanceof NuvionError && refusalOf(e, 'withdraw')) || e;
    }
  }
}
