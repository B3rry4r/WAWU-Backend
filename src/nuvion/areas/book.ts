import type {
  ProviderPlatformAccount,
  ProviderTransferReceipt,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionSettings } from '../nuvion-config';
import type { NuvionClient } from '../nuvion-client';
import { rejectNotSupported } from './not-supported';

const AREA = 'book transfers (NUV-05)';

/**
 * Paying from the wallet and held money (task NUV-05): book transfers on
 * Nuvion's own rail (`payment_type: "book-transfer"`, by the receiving
 * account's `nuvion_ban`), and WAWU's operational account
 * (NUVION_OPERATIONAL_ACCOUNT_ID, R-42), which replaces Fintava's merchant
 * wallet for held money. The lead's scratchpad
 * `nuvion/docs/guides__send-a-payout.md` and `SANDBOX-FINDINGS.md` item 9.
 * This file is NUV-05's alone.
 *
 * Every method answers `not_supported` (nothing is sent, nothing moves)
 * until NUV-05 gives it its calls.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionBookMethods = Pick<
  WalletProvider,
  'getPlatformAccount' | 'walletToWallet'
>;

export class NuvionBookArea implements NuvionBookMethods {
  constructor(
    readonly client: NuvionClient,
    readonly settings: Pick<NuvionSettings, 'operationalAccountId'>,
  ) {}

  getPlatformAccount(): Promise<ProviderPlatformAccount> {
    return rejectNotSupported('get platform account', AREA);
  }

  walletToWallet(): Promise<ProviderTransferReceipt> {
    return rejectNotSupported('wallet to wallet', AREA);
  }
}
