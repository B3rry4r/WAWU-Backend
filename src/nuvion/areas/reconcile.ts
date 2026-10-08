import type {
  LedgerWebhookReading,
  ProviderDeliveries,
  ProviderLookup,
  ProviderMovementConfirmation,
  ProviderPage,
  ProviderReconciliation,
  ProviderRetryDecision,
  ProviderSendKind,
  ProviderTransaction,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionClient } from '../nuvion-client';
import { rejectNotSupported } from './not-supported';

const AREA = 'reconciliation (NUV-08)';

/**
 * Reconciliation with Nuvion (task NUV-08): finding one of our sends again
 * after a lost answer (Nuvion returns the original transfer for a repeated
 * `unique_reference`, and `GET /transfers/{id}`), the account statements
 * (`GET /accounts/{id}/statements`, one calendar month), missed deliveries
 * (Nuvion stops retrying after 15 minutes), and the nightly figures. The
 * lead's scratchpad `nuvion/docs/api-reference__transfers.md`,
 * `api-reference__accounts.md`, `webhooks__overview.md`. This file is
 * NUV-08's alone.
 *
 * Every method answers `not_supported` (nothing is sent) until NUV-08 gives
 * it its calls. An unknown outcome is therefore never settled under Nuvion
 * before NUV-08: the status sweep leaves it pending.
 *
 * `deliveries`: the ledger consumer reads Fintava's stored deliveries
 * table only. Nuvion's deliveries reach the ledger through their handlers
 * (src/nuvion/handlers/), so the generic reader names no event.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionReconcileMethods = Pick<
  WalletProvider,
  | 'deliveries'
  | 'findTransactionByReference'
  | 'findTransactionById'
  | 'listTransactions'
  | 'reconcileSend'
  | 'decideRetry'
  | 'confirmMovement'
  | 'secondaryReferenceOf'
>;

export class NuvionReconcileArea implements NuvionReconcileMethods {
  constructor(readonly client: NuvionClient) {}

  readonly deliveries: ProviderDeliveries = {
    ledgerEvents: [],
    read: (): LedgerWebhookReading => ({
      kind: 'unreadable',
      why: 'Nuvion deliveries are read by their own handlers, not the ledger consumer',
    }),
  };

  findTransactionByReference(): Promise<ProviderLookup> {
    return rejectNotSupported('find transaction by reference', AREA);
  }

  findTransactionById(): Promise<ProviderLookup> {
    return rejectNotSupported('find transaction by id', AREA);
  }

  listTransactions(): Promise<ProviderPage<ProviderTransaction>> {
    return rejectNotSupported('list transactions', AREA);
  }

  reconcileSend(): Promise<ProviderReconciliation> {
    return rejectNotSupported('reconcile send', AREA);
  }

  /**
   * Pure, so it cannot answer `not_supported` as a failure without breaking
   * the status check that calls it. Until NUV-08 states Nuvion's resend
   * rule, the only safe advice is to wait: never resend, never settle on
   * advice alone (the status check settles a found send itself).
   */
  decideRetry(
    _kind: ProviderSendKind,
    reconciliation: ProviderReconciliation,
  ): ProviderRetryDecision {
    return {
      action: 'wait',
      why: reconciliation.state === 'unknown' ? reconciliation.why : 'pending',
    };
  }

  confirmMovement(): Promise<ProviderMovementConfirmation> {
    return rejectNotSupported('confirm movement', AREA);
  }

  secondaryReferenceOf(): Promise<string | null> {
    return rejectNotSupported('secondary reference', AREA);
  }
}
