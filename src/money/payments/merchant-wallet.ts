import { Injectable } from '@nestjs/common';
import { FintavaClient } from '../../fintava/fintava-client';
import { FINTAVA_DEFAULTS } from '../../fintava/fintava-config';
import { FintavaError } from '../../fintava/fintava-error';
import { MoneyError } from '../money-error';

export const PAYMENTS_UNAVAILABLE_MESSAGE =
  'Payments are not available right now. Your money is safe. Try again in a moment.';

/**
 * WAWU's Fintava merchant wallet, where every wallet payment goes (R-19):
 * its account number as Fintava reports it (`GET /merchant/balance`), read
 * once per process, the way the ledger consumer reads it (MONEY-10). Never
 * a figure from config: the account is whatever the key Fintava was given
 * belongs to.
 */
@Injectable()
export class MerchantWallet {
  private accountNumber: string | null = null;

  constructor(private readonly fintava: FintavaClient) {}

  /** The account number, or `503 provider_unreachable` when Fintava does not say. */
  async account(): Promise<string> {
    if (this.accountNumber) return this.accountNumber;
    try {
      const merchant = await this.fintava.getMerchantBalance();
      if (!/^[0-9]{10}$/.test(merchant.accountNumber)) {
        throw new Error('Fintava answered no merchant account number.');
      }
      this.accountNumber = merchant.accountNumber;
      return merchant.accountNumber;
    } catch (e) {
      if (e instanceof FintavaError || e instanceof Error) {
        throw new MoneyError(
          'provider_unreachable',
          PAYMENTS_UNAVAILABLE_MESSAGE,
          { retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds },
        );
      }
      throw e;
    }
  }
}
