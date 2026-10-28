/**
 * The foreign currencies a person can hold at Nuvion (WALLET-21, R-83, R-84):
 * every currency Nuvion gives account details for, and the stablecoins.
 *
 * Amounts that are not naira are an integer in the currency's smallest unit,
 * in a field whose name ends `Minor`, always beside a currency field
 * (docs/contract/CONVENTIONS.md, "Amounts that are not naira"). How many
 * decimals a unit has is `decimals` here; the naira stays kobo (`Kobo`).
 */

/** Currencies with banking coordinates (account number, routing number, IBAN ...). */
export const FX_FIAT_CODES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AED',
  'GHS',
] as const;

/** Stablecoins: a wallet address per chain. */
export const FX_COIN_CODES = ['USDT', 'USDC', 'RLUSD'] as const;

export const FX_CURRENCY_CODES = [...FX_FIAT_CODES, ...FX_COIN_CODES] as const;
export type FxCurrencyCode = (typeof FX_CURRENCY_CODES)[number];
export type FxFiatCode = (typeof FX_FIAT_CODES)[number];
export type FxCoinCode = (typeof FX_COIN_CODES)[number];

/** A quote or a swap can also name the person's naira wallet. */
export const FX_QUOTE_CODES = ['NGN', ...FX_CURRENCY_CODES] as const;
export type FxQuoteCode = (typeof FX_QUOTE_CODES)[number];

/** Nuvion's chains for a wallet address (core-concepts__account-details.md). */
export const FX_CHAINS = ['eth', 'base', 'matic', 'sol'] as const;
export type FxChain = (typeof FX_CHAINS)[number];

export type FxKind = 'fiat' | 'stablecoin';

export interface FxCurrencyDef {
  code: FxCurrencyCode;
  name: string;
  kind: FxKind;
  /** Nuvion's currency code (`UST` for USDT ...). */
  nuvion: string;
  /** Decimals of the smallest unit before any configured override. */
  decimals: number;
  /** The chains it can be held on (stablecoins only). */
  chains: readonly FxChain[];
}

const ALL_CHAINS: readonly FxChain[] = FX_CHAINS;

/**
 * Stablecoin decimals: 2, like every currency. Nuvion's transfers page said six (100000000 is 100.00 USDC) and the dev quotes
 * counted cents; Nuvion answered on 27 Oct 2026 that all amounts use 2 decimals in minor units (100 is 1.00) and that the docs
 * are wrong. There is no setting to change it (NUVION-FIX 10.1; BACKEND_GAPS G-WALLET-21-1 is closed).
 */
export const FX_COIN_DEFAULT_DECIMALS = 2;

export const FX_CURRENCIES: readonly FxCurrencyDef[] = [
  {
    code: 'USD',
    name: 'US dollar',
    kind: 'fiat',
    nuvion: 'USD',
    decimals: 2,
    chains: [],
  },
  {
    code: 'EUR',
    name: 'Euro',
    kind: 'fiat',
    nuvion: 'EUR',
    decimals: 2,
    chains: [],
  },
  {
    code: 'GBP',
    name: 'British pound',
    kind: 'fiat',
    nuvion: 'GBP',
    decimals: 2,
    chains: [],
  },
  {
    code: 'CAD',
    name: 'Canadian dollar',
    kind: 'fiat',
    nuvion: 'CAD',
    decimals: 2,
    chains: [],
  },
  {
    code: 'AED',
    name: 'UAE dirham',
    kind: 'fiat',
    nuvion: 'AED',
    decimals: 2,
    chains: [],
  },
  {
    code: 'GHS',
    name: 'Ghanaian cedi',
    kind: 'fiat',
    nuvion: 'GHS',
    decimals: 2,
    chains: [],
  },
  {
    code: 'USDT',
    name: 'Tether',
    kind: 'stablecoin',
    nuvion: 'UST',
    decimals: FX_COIN_DEFAULT_DECIMALS,
    chains: ALL_CHAINS,
  },
  {
    code: 'USDC',
    name: 'USD Coin',
    kind: 'stablecoin',
    nuvion: 'USC',
    decimals: FX_COIN_DEFAULT_DECIMALS,
    chains: ALL_CHAINS,
  },
  // Nuvion lists RLUSD on Ethereum only (guides__stablecoins.md).
  {
    code: 'RLUSD',
    name: 'Ripple USD',
    kind: 'stablecoin',
    nuvion: 'RLD',
    decimals: FX_COIN_DEFAULT_DECIMALS,
    chains: ['eth'],
  },
];

const BY_CODE = new Map<string, FxCurrencyDef>(
  FX_CURRENCIES.map((c) => [c.code, c]),
);
const BY_NUVION = new Map<string, FxCurrencyDef>(
  FX_CURRENCIES.map((c) => [c.nuvion, c]),
);

export function fxCurrency(code: string): FxCurrencyDef | null {
  return BY_CODE.get(code) ?? null;
}

/** Nuvion's code to ours (`UST` to USDT); null for naira or a code we do not hold. */
export function fxCurrencyOfNuvion(nuvion: string): FxCurrencyDef | null {
  return BY_NUVION.get(nuvion.toUpperCase()) ?? null;
}

/** The currency code Nuvion is asked in: NGN stays NGN. */
export function nuvionCodeOf(code: FxQuoteCode): string {
  return code === 'NGN' ? 'NGN' : fxCurrency(code)!.nuvion;
}

/** The network name Nuvion's payment details take (dev, 24 Oct 2026). */
export const FX_CHAIN_NETWORK: Record<FxChain, string> = {
  eth: 'ETH_MAINNET',
  base: 'BASE_MAINNET',
  matic: 'MATIC_MAINNET',
  sol: 'SOLANA_MAINNET',
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Base58 without 0, O, I, l: a Solana address is 32 to 44 characters. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True when `address` has the form a wallet on `chain` has. */
export function addressSuitsChain(chain: FxChain, address: string): boolean {
  return chain === 'sol'
    ? SOLANA_ADDRESS.test(address)
    : EVM_ADDRESS.test(address);
}

/** The chain a Nuvion network name (or its short form) names, or null. */
export function chainOfNetwork(
  network: string | null | undefined,
): FxChain | null {
  if (!network) return null;
  const n = network.toLowerCase();
  if (n.startsWith('eth')) return 'eth';
  if (n.startsWith('base')) return 'base';
  if (n.startsWith('matic') || n.startsWith('polygon')) return 'matic';
  if (n.startsWith('sol')) return 'sol';
  return null;
}
