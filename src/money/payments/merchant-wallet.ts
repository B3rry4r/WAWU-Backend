import { Inject, Injectable } from '@nestjs/common';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { MoneyError } from '../money-error';

export const PAYMENTS_UNAVAILABLE_MESSAGE =
  'Payments are not available right now. Your money is safe. Try again in a moment.';

/**
 * What an account the provider names may look like before money is sent to
 * it: letters and digits only, 6 to 34 of them. A NUBAN (Fintava's merchant
 * wallet, ten digits) and a Nuvion `nuvion_ban` (`0010650099`,
 * `NVXYT1GUCM`, `NVN0000012345` in its docs) both pass; an empty, spaced or
 * garbled answer never becomes the receiver of a payment.
 */
const PLATFORM_ACCOUNT = /^[A-Za-z0-9]{6,34}$/;

/**
 * WAWU's own account at the wallet provider, where every wallet payment
 * goes: Fintava's merchant wallet (R-19) or Nuvion's operational account
 * (R-42), whichever `WALLET_PROVIDER` runs (MONEY-20). Its account as the
 * provider reports it (`getPlatformAccount`), read once per process, the
 * way the ledger consumer reads it (MONEY-10). Never a figure from config:
 * the account is whatever the provider says WAWU's is. One process runs one
 * provider, so the cache never mixes two.
 */
@Injectable()
export class MerchantWallet {
  private accountNumber: string | null = null;

  constructor(
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  /** The account, or `503 provider_unreachable` when the provider does not say. */
  async account(): Promise<string> {
    if (this.accountNumber) return this.accountNumber;
    try {
      const platform = await this.provider.getPlatformAccount();
      if (!PLATFORM_ACCOUNT.test(platform.accountNumber)) {
        throw new Error(
          `${this.provider.label} answered no usable account for WAWU.`,
        );
      }
      this.accountNumber = platform.accountNumber;
      return platform.accountNumber;
    } catch (e) {
      if (e instanceof WalletProviderError || e instanceof Error) {
        throw new MoneyError(
          'provider_unreachable',
          PAYMENTS_UNAVAILABLE_MESSAGE,
          { retryAfterSeconds: this.provider.timings.retryAfterSeconds },
        );
      }
      throw e;
    }
  }
}
