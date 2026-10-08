import {
  WALLET_PROVIDER_NAMES,
  type WalletProviderName,
} from './wallet-provider.interface';

/**
 * Which company holds the wallets: one setting, read at boot (MONEY-20).
 * Unset or blank is `fintava`. Rolling back from one provider to the
 * other is changing it and restarting; nothing else moves.
 */
export const WALLET_PROVIDER_CONFIG_KEY = 'WALLET_PROVIDER';

export const DEFAULT_WALLET_PROVIDER: WalletProviderName = 'fintava';

/** A WALLET_PROVIDER value the server cannot start with. Stops the app at boot. */
export class WalletProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletProviderConfigError';
  }
}

/**
 * The provider WALLET_PROVIDER names: `fintava` (also when unset or blank)
 * or `nuvion`, in any case and with spaces around it. Anything else stops
 * the app with a message that names the setting and what it may be.
 */
export function readWalletProviderName(
  raw: string | undefined | null,
): WalletProviderName {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return DEFAULT_WALLET_PROVIDER;
  const name = WALLET_PROVIDER_NAMES.find((n) => n === value);
  if (!name) {
    throw new WalletProviderConfigError(
      `${WALLET_PROVIDER_CONFIG_KEY} must be one of: ${WALLET_PROVIDER_NAMES.join(', ')} (unset means ${DEFAULT_WALLET_PROVIDER}).`,
    );
  }
  return name;
}

/**
 * Picks the adapter for the configured provider. A provider with no adapter
 * in `adapters` stops the server rather than run the wallet on nothing.
 * Since NUV-01 both `fintava` and `nuvion` have one (wallet-provider.module.ts);
 * set WALLET_PROVIDER=fintava (or unset it) and restart to run on Fintava.
 */
export function selectWalletAdapter<T>(
  name: WalletProviderName,
  adapters: Partial<Record<WalletProviderName, () => T>>,
): T {
  const build = adapters[name];
  if (!build) {
    throw new WalletProviderConfigError(
      `${WALLET_PROVIDER_CONFIG_KEY}=${name} is reserved: the ${name} wallet adapter is not built yet. ` +
        `Set ${WALLET_PROVIDER_CONFIG_KEY}=${DEFAULT_WALLET_PROVIDER} (or leave it unset) and restart.`,
    );
  }
  return build();
}
