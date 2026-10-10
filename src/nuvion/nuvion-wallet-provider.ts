import type {
  ProviderAccountNameInput,
  ProviderBankTransferInput,
  ProviderBvnDigest,
  ProviderConfirmLimits,
  ProviderHolder,
  ProviderKycSubmission,
  ProviderOpenWalletInput,
  ProviderPageQuery,
  ProviderReconciliation,
  ProviderSelfieInput,
  ProviderSendKind,
  ProviderTransaction,
  ProviderWalletTransferInput,
  WalletProvider,
  WalletProviderCapabilities,
  WalletProviderTimings,
} from '../wallet-provider/wallet-provider.interface';
import {
  NuvionAccountsArea,
  type NuvionAccountsMethods,
} from './areas/accounts';
import { NuvionBookArea, type NuvionBookMethods } from './areas/book';
import {
  NuvionDocumentsArea,
  type NuvionDocumentsMethods,
} from './areas/documents';
import { NuvionOpeningArea, type NuvionOpeningMethods } from './areas/opening';
import { NuvionPayoutsArea, type NuvionPayoutsMethods } from './areas/payouts';
import {
  NuvionReconcileArea,
  type NuvionReconcileMethods,
} from './areas/reconcile';
import type { NuvionClient } from './nuvion-client';

/**
 * What Nuvion can do, said ahead (the seam's `capabilities`):
 * - no selfie matched against a BVN photo, and no standalone BVN lookup
 *   (the BVN and NIN are checked inside Nuvion's review of the entity);
 * - the KYC is its own submission (entity, documents, onboarding
 *   submission), and the account number is provisioned after opening;
 * - the hosted selfie is off unless `NUVION_HOSTED_LIVENESS=on` (NUV-03,
 *   read from the documents area, which also turns it off for an hour when
 *   Nuvion refuses to start a session for a child entity: SANDBOX-FINDINGS
 *   item 4). `capabilities.hostedLiveness` below is that, live.
 */
export const NUVION_CAPABILITIES: WalletProviderCapabilities = {
  selfieMatch: false,
  hostedLiveness: false,
  separateKyc: true,
  asyncAccountNumber: true,
  identityLookup: false,
};

/** Every area the adapter delegates to, one per later task. */
export interface NuvionAreas {
  opening: NuvionOpeningMethods;
  documents: NuvionDocumentsMethods & { readonly hostedLiveness?: boolean };
  accounts: NuvionAccountsMethods;
  book: NuvionBookMethods;
  payouts: NuvionPayoutsMethods;
  reconcile: NuvionReconcileMethods;
}

/** The areas over one client. */
export function nuvionAreas(client: NuvionClient): NuvionAreas {
  return {
    opening: new NuvionOpeningArea(client),
    documents: new NuvionDocumentsArea(client),
    accounts: new NuvionAccountsArea(client),
    book: new NuvionBookArea(client, client.settings),
    payouts: new NuvionPayoutsArea(client),
    reconcile: new NuvionReconcileArea(client),
  };
}

/**
 * The Nuvion adapter behind the wallet provider seam (task NUV-01, R-39):
 * picked by WALLET_PROVIDER=nuvion. It holds no logic of its own: every
 * method is one line that hands the call to the area file that owns it
 * (src/nuvion/areas/), so NUV-02 to NUV-08 each fill their own file and
 * never edit this one, and two of them never edit the same file:
 *
 * | Area | Task | Methods |
 * |---|---|---|
 * | opening.ts | NUV-02 | checkIdentity, openWallet, findCustomerByPhone, getCustomerMatch, listCustomerSightings |
 * | documents.ts | NUV-03 | matchSelfie, startLivenessSession, getLivenessResult, submitKyc |
 * | accounts.ts | NUV-04 | getWalletAccount, getBalance |
 * | book.ts | NUV-05 | getPlatformAccount, walletToWallet |
 * | payouts.ts | NUV-06 | listBanks, checkAccountName, bankTransfer |
 * | reconcile.ts | NUV-08 | deliveries, the lookups, listTransactions, reconcileSend, decideRetry, confirmMovement, secondaryReferenceOf |
 *
 * A method whose area has no Nuvion call yet answers `not_supported`:
 * nothing is sent and nothing moves.
 */
export class NuvionWalletProvider implements WalletProvider {
  readonly name = 'nuvion' as const;
  readonly label = 'Nuvion';
  /** Built only with every Nuvion setting present (nuvion-config.ts). */
  readonly configured = true;
  /** NUVION_CAPABILITIES, with the hosted selfie as the documents area says now (NUV-03). */
  get capabilities(): WalletProviderCapabilities {
    return {
      ...NUVION_CAPABILITIES,
      hostedLiveness: this.areas.documents.hostedLiveness === true,
    };
  }
  /**
   * Nuvion names the issuing bank per account (account details' `issuer`),
   * not one bank for every wallet; NUV-04 records it per person
   * (NuvionEntity). No party is a WAWU wallet by bank code alone.
   */
  readonly walletBankCode = '';
  readonly timings: WalletProviderTimings;
  private readonly areas: NuvionAreas;

  constructor(
    readonly client: NuvionClient,
    areas?: NuvionAreas,
  ) {
    const s = client.settings;
    this.timings = {
      readTimeoutMs: s.readTimeoutMs,
      moneyTimeoutMs: s.moneyTimeoutMs,
      checkTimeoutMs: s.checkTimeoutMs,
      resendSafetyMs: s.resendSafetyMs,
      retryAfterSeconds: s.retryAfterSeconds,
    };
    this.areas = areas ?? nuvionAreas(client);
  }

  get deliveries() {
    return this.areas.reconcile.deliveries;
  }

  /** The documents area (NUV-03): the upload, the submission and the hosted selfie. */
  get documents(): NuvionDocumentsArea {
    const area = this.areas.documents;
    if (!(area instanceof NuvionDocumentsArea)) {
      throw new Error("The documents area of this adapter is not Nuvion's.");
    }
    return area;
  }

  // Identity (opening, documents)
  checkIdentity(bvn: string) {
    return this.areas.opening.checkIdentity(bvn);
  }
  matchSelfie(input: ProviderSelfieInput) {
    return this.areas.documents.matchSelfie(input);
  }
  startLivenessSession(input: {
    customerId: string;
    returnUrl?: string | null;
  }) {
    return this.areas.documents.startLivenessSession(input);
  }
  getLivenessResult(sessionId: string) {
    return this.areas.documents.getLivenessResult(sessionId);
  }
  submitKyc(input: ProviderKycSubmission) {
    return this.areas.documents.submitKyc(input);
  }

  // Opening
  openWallet(input: ProviderOpenWalletInput) {
    return this.areas.opening.openWallet(input);
  }
  getWalletAccount(customerId: string) {
    return this.areas.accounts.getWalletAccount(customerId);
  }
  findCustomerByPhone(phone: string, digest: ProviderBvnDigest) {
    return this.areas.opening.findCustomerByPhone(phone, digest);
  }
  getCustomerMatch(customerId: string, digest: ProviderBvnDigest) {
    return this.areas.opening.getCustomerMatch(customerId, digest);
  }
  listCustomerSightings(query: Omit<ProviderPageQuery, 'order'>) {
    return this.areas.opening.listCustomerSightings(query);
  }

  // Balances
  getBalance(wallet: { walletId: string }) {
    return this.areas.accounts.getBalance(wallet);
  }
  getPlatformAccount() {
    return this.areas.book.getPlatformAccount();
  }

  // Banks
  listBanks() {
    return this.areas.payouts.listBanks();
  }
  checkAccountName(input: ProviderAccountNameInput) {
    return this.areas.payouts.checkAccountName(input);
  }

  // Moving money
  bankTransfer(input: ProviderBankTransferInput) {
    return this.areas.payouts.bankTransfer(input);
  }
  walletToWallet(input: ProviderWalletTransferInput) {
    return this.areas.book.walletToWallet(input);
  }

  // Transactions
  findTransactionByReference(reference: string) {
    return this.areas.reconcile.findTransactionByReference(reference);
  }
  findTransactionById(id: string) {
    return this.areas.reconcile.findTransactionById(id);
  }
  listTransactions(holder: ProviderHolder, query: ProviderPageQuery) {
    return this.areas.reconcile.listTransactions(holder, query);
  }
  reconcileSend(reference: string, holder: ProviderHolder, since?: Date) {
    return this.areas.reconcile.reconcileSend(reference, holder, since);
  }
  decideRetry(
    kind: ProviderSendKind,
    reconciliation: ProviderReconciliation,
    clock: { attemptedAt: Date; now: Date; resendAfterMs: number },
  ) {
    return this.areas.reconcile.decideRetry(kind, reconciliation, clock);
  }
  confirmMovement(input: {
    references: readonly string[];
    sender: ProviderHolder | null;
    amountKobo: number;
    around: Date;
    limits: ProviderConfirmLimits;
  }) {
    return this.areas.reconcile.confirmMovement(input);
  }
  secondaryReferenceOf(t: ProviderTransaction) {
    return this.areas.reconcile.secondaryReferenceOf(t);
  }
}
