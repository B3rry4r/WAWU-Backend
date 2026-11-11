/**
 * The kinds of move WAWU sets a fee for (FEE-01, R-139 point 2), and the
 * currency each is counted in. Names only: no figure lives here.
 */
export const FEE_KINDS = [
  'ngn_bank_withdrawal',
  'usd_bank_payout',
  'intl_wire_in',
  'usd_local_in',
  'fx_swap',
  'wallet_to_wallet',
  'ngn_add_money',
] as const;
export type FeeKind = (typeof FEE_KINDS)[number];

/** The currencies a fee can be set in. */
export const FEE_CURRENCIES = ['NGN', 'USD'] as const;
export type FeeCurrency = (typeof FEE_CURRENCIES)[number];

/** The currency each kind is counted in. */
export const FEE_KIND_CURRENCY: Record<FeeKind, FeeCurrency> = {
  ngn_bank_withdrawal: 'NGN',
  usd_bank_payout: 'USD',
  intl_wire_in: 'USD',
  usd_local_in: 'USD',
  fx_swap: 'USD',
  wallet_to_wallet: 'NGN',
  ngn_add_money: 'NGN',
};

/** Kinds whose fee is the provider's charge passed on (a flag, not a percentage). */
export const PASS_THROUGH_KINDS: readonly FeeKind[] = ['ngn_add_money'];

/**
 * The kinds the provider also has a rate for, beyond the fee kinds
 * (the card's dollar fees), for the rate table.
 */
export const PROVIDER_RATE_KINDS = [
  ...FEE_KINDS,
  'card_issuance',
  'card_maintenance',
  'card_decline',
] as const;
export type ProviderRateKind = (typeof PROVIDER_RATE_KINDS)[number];

/** Which provider a rate belongs to; the one provider with commercials today. */
export const RATE_PROVIDER = 'nuvion';
