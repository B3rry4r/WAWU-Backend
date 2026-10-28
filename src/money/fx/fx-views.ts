import type {
  FxAccount,
  FxOperation,
  FxQuote,
} from '../../../generated/prisma/client';
import type {
  ProviderFxAccount,
  ProviderFxDetails,
} from '../../wallet-provider/wallet-provider-fx';
import { safeKoboNumber } from '../../wallet-provider/wallet-provider.interface';
import {
  fxCurrency,
  type FxChain,
  type FxCurrencyCode,
  type FxQuoteCode,
} from './fx-currencies';
import type { FxSettings } from './fx-settings';
import type {
  FxAccountView,
  FxBalanceView,
  FxQuoteView,
  FxReceivingDetailsView,
  FxSendQuoteView,
  FxSendView,
  FxSwapView,
} from './fx-view.type';

/** A bigint amount as the contract's integer; refuses what a number cannot hold. */
export const num = (v: bigint): number => safeKoboNumber(v);
export const numOrNull = (v: bigint | null | undefined): number | null =>
  v === null || v === undefined ? null : num(v);

export function detailsView(
  d: ProviderFxDetails | null,
): FxReceivingDetailsView | null {
  if (!d) return null;
  return {
    status: d.status,
    beneficiaryName: d.beneficiaryName,
    accountNumber: d.accountNumber,
    routingNumber: d.routingNumber,
    swiftCode: d.swiftCode,
    iban: d.iban,
    sortCode: d.sortCode,
    bankName: d.bankName,
    bankAddress: d.bankAddress,
    chain: d.chain,
    address: d.address,
  };
}

export function balanceView(
  currency: FxCurrencyCode,
  a: ProviderFxAccount | null,
): FxBalanceView | null {
  if (!a) return null;
  return {
    currency,
    availableMinor: num(a.availableMinor),
    bookedMinor: num(a.bookedMinor),
  };
}

export function accountView(
  row: FxAccount,
  settings: FxSettings,
  balance: ProviderFxAccount | null,
  details: ProviderFxDetails | null,
  refusal: string | null = null,
): FxAccountView {
  const code = row.currency as FxCurrencyCode;
  const def = fxCurrency(code)!;
  return {
    id: row.id,
    currency: code,
    kind: def.kind,
    decimals: settings.decimalsOf(code),
    chain: row.chain === '' ? null : (row.chain as FxChain),
    status:
      row.status === 'frozen'
        ? 'frozen'
        : row.status === 'open'
          ? 'open'
          : 'opening',
    balance: balanceView(code, balance),
    details: detailsView(details),
    // NUVION-FIX 9.4: the provider makes the details later (5 to 30 minutes). An account with no record and no refusal is
    // pending, never unavailable; only a refusal, in the provider's words, says unavailable.
    detailsStatus: details
      ? details.status === 'active'
        ? 'ready'
        : 'pending'
      : row.status !== 'opening' && refusal !== null
        ? 'unavailable'
        : 'pending',
    detailsNote: details || row.status === 'opening' ? null : refusal,
    openedAt: row.createdAt.toISOString(),
  };
}

export function quoteView(
  q: FxQuote,
  settings: FxSettings,
  now: Date = new Date(),
): FxQuoteView {
  const from = q.fromCurrency as FxQuoteCode;
  const to = q.toCurrency as FxQuoteCode;
  return {
    id: q.id,
    fromCurrency: from,
    toCurrency: to,
    fromAccountId: q.fromAccountId,
    toAccountId: q.toAccountId,
    amountFromMinor: num(q.amountFromMinor),
    amountToMinor: num(q.amountToMinor),
    fromDecimals: settings.decimalsOf(from),
    toDecimals: settings.decimalsOf(to),
    rate: q.rate,
    providerFeeMinor: numOrNull(q.providerFeeMinor),
    wawuFeeMinor: num(q.wawuFeeMinor),
    totalFromMinor: num(
      q.amountFromMinor + (q.providerFeeMinor ?? 0n) + q.wawuFeeMinor,
    ),
    expiresAt: q.expiresAt.toISOString(),
    validForSeconds: Math.max(
      0,
      Math.floor((q.expiresAt.getTime() - now.getTime()) / 1000),
    ),
  };
}

export function swapView(op: FxOperation, settings: FxSettings): FxSwapView {
  const from = op.fromCurrency as FxQuoteCode;
  const to = (op.toCurrency ?? '') as FxQuoteCode;
  return {
    id: op.id,
    status: op.status as FxSwapView['status'],
    fromCurrency: from,
    toCurrency: to,
    fromAccountId: op.fromAccountId,
    toAccountId: op.toAccountId,
    amountFromMinor: num(op.amountFromMinor),
    amountToMinor: num(op.amountToMinor ?? 0n),
    fromDecimals: settings.decimalsOf(from),
    toDecimals: settings.decimalsOf(to),
    rate: op.rate ?? '',
    providerFeeMinor: numOrNull(op.providerFeeMinor),
    wawuFeeMinor: num(op.wawuFeeMinor),
    failureReason: op.failureReason,
    createdAt: op.createdAt.toISOString(),
    completedAt: op.completedAt?.toISOString() ?? null,
  };
}

export function sendView(op: FxOperation, settings: FxSettings): FxSendView {
  const code = op.fromCurrency as FxCurrencyCode;
  return {
    id: op.id,
    status: op.status as FxSendView['status'],
    accountId: op.fromAccountId ?? '',
    currency: code,
    chain: (op.chain ?? 'eth') as FxChain,
    decimals: settings.decimalsOf(code),
    address: op.address ?? '',
    amountMinor: num(op.amountFromMinor),
    providerFeeMinor: numOrNull(op.providerFeeMinor),
    wawuFeeMinor: num(op.wawuFeeMinor),
    failureReason: op.failureReason,
    createdAt: op.createdAt.toISOString(),
    completedAt: op.completedAt?.toISOString() ?? null,
  };
}

export function sendQuoteView(
  row: FxAccount,
  settings: FxSettings,
  amountMinor: number,
  availableMinor: number,
): FxSendQuoteView {
  const code = row.currency as FxCurrencyCode;
  return {
    accountId: row.id,
    currency: code,
    chain: row.chain as FxChain,
    decimals: settings.decimalsOf(code),
    amountMinor,
    providerFeeMinor: null,
    wawuFeeMinor: num(settings.sendFeeMinor(code)),
    availableMinor,
  };
}
