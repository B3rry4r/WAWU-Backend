import type {
  ProviderBalance,
  ProviderCustomer,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionClient } from '../nuvion-client';
import { rejectNotSupported } from './not-supported';

const AREA = 'accounts (NUV-04)';

/**
 * The account, its account number and its balance (task NUV-04): the naira
 * `checking` account opened once the entity is approved, the account
 * details Nuvion provisions asynchronously (`pending`, then `active`), and
 * the balance, which is Nuvion's `balance.available` read on every request
 * and never a sum of our rows. The lead's scratchpad
 * `nuvion/docs/api-reference__accounts.md`,
 * `api-reference__account-details.md`. This file is NUV-04's alone.
 *
 * Every method answers `not_supported` (nothing is sent) until NUV-04 gives
 * it its calls.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionAccountsMethods = Pick<
  WalletProvider,
  'getWalletAccount' | 'getBalance'
>;

export class NuvionAccountsArea implements NuvionAccountsMethods {
  constructor(readonly client: NuvionClient) {}

  getWalletAccount(): Promise<ProviderCustomer | null> {
    return rejectNotSupported('get wallet account', AREA);
  }

  getBalance(): Promise<ProviderBalance> {
    return rejectNotSupported('get balance', AREA);
  }
}
