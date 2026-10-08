import type { WalletProviderName } from './wallet-provider.interface';

/**
 * Which provider a stored wallet, opening or ledger row belongs to (task
 * NUV-01, MONEY-20 verifier finding 2). The `provider` column on
 * FintavaWallet, FintavaWalletOpening and FintavaLedgerEntry says it; null
 * (a row from before the column) is Fintava, the column's default.
 *
 * A server acts only on rows of the provider it runs: after a rollback to
 * Fintava, a Nuvion wallet's id is never sent to Fintava (its balance, its
 * history, its sends), and the reverse. Such rows are left exactly as they
 * are, for the provider that holds their money.
 */
export const DEFAULT_ROW_PROVIDER: WalletProviderName = 'fintava';

/** The provider a row's `provider` column names. */
export function rowProvider(
  value: string | null | undefined,
): WalletProviderName | 'other' {
  const v = (value ?? DEFAULT_ROW_PROVIDER).trim().toLowerCase();
  if (v === 'fintava' || v === 'nuvion') return v;
  return 'other';
}

/** True when a row with this `provider` value belongs to `running`. */
export function isRowOf(
  running: WalletProviderName,
  value: string | null | undefined,
): boolean {
  return rowProvider(value) === running;
}

/**
 * A Prisma `where` part for rows of `running`. Fintava's also matches
 * null (rows from before the column). Combine with `AND`, never by
 * spreading into a `where` that has its own `OR`.
 */
export function rowsOf(
  running: WalletProviderName,
): { OR: Array<{ provider: string | null }> } {
  return running === DEFAULT_ROW_PROVIDER
    ? { OR: [{ provider: running }, { provider: null }] }
    : { OR: [{ provider: running }] };
}
