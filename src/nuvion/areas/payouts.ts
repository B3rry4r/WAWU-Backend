import type {
  ProviderAccountName,
  ProviderBank,
  ProviderTransferReceipt,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionClient } from '../nuvion-client';
import { rejectNotSupported } from './not-supported';

const AREA = 'payouts (NUV-06)';

/**
 * Sending to a bank and paying out (task NUV-06): Nuvion's Nigerian bank
 * list (`GET /bank-codes/NG`), the account name check
 * (`POST /counterparty-lookups`, SANDBOX-FINDINGS item 7), and NIP payouts
 * (`POST /counterparties`, `POST /payment-details`, `POST /transfers` with
 * `payment_type: "bank-transfer"` and our `unique_reference`). The lead's
 * scratchpad `nuvion/docs/guides__send-a-payout.md`,
 * `api-reference__bank-codes.md`. This file is NUV-06's alone.
 *
 * Every method answers `not_supported` (nothing is sent, nothing moves)
 * until NUV-06 gives it its calls.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionPayoutsMethods = Pick<
  WalletProvider,
  'listBanks' | 'checkAccountName' | 'bankTransfer'
>;

export class NuvionPayoutsArea implements NuvionPayoutsMethods {
  constructor(readonly client: NuvionClient) {}

  listBanks(): Promise<ProviderBank[]> {
    return rejectNotSupported('list banks', AREA);
  }

  checkAccountName(): Promise<ProviderAccountName> {
    return rejectNotSupported('check account name', AREA);
  }

  bankTransfer(): Promise<ProviderTransferReceipt> {
    return rejectNotSupported('bank transfer', AREA);
  }
}
