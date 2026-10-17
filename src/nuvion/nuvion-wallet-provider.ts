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
import { type NuvionBookStore } from './areas/book-store';
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
import { BANK_SEND_REFERENCE_PREFIX } from '../wallet-provider/wallet-provider.interface';
import type { NuvionClient } from './nuvion-client';
import { reconcileBankSend } from './handlers/outflows-bank';

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

/**
 * The areas over one client. `deps.bookStore` is the record of book
 * transfers and of which Nuvion account a number is (NUV-05,
 * `PrismaNuvionBookStore`): the factory gives it the database. Without it
 * the book area sends nothing (`not_configured`).
 */
export function nuvionAreas(
  client: NuvionClient,
  deps: { bookStore?: NuvionBookStore } = {},
): NuvionAreas {
  return {
    opening: new NuvionOpeningArea(client),
    documents: new NuvionDocumentsArea(client),
    accounts: new NuvionAccountsArea(client),
    book: new NuvionBookArea(client, client.settings, deps.bookStore),
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
 * | book.ts | NUV-05 | getPlatformAccount, walletToWallet, isSameAccount, and for book transfers findTransactionByReference, findTransactionById, reconcileSend, decideRetry, confirmMovement, secondaryReferenceOf |
 * | payouts.ts | NUV-06 | listBanks, checkAccountName, bankTransfer |
 * | reconcile.ts | NUV-08 | deliveries, listTransactions (the statement); NUV-08 widens the lookups above to every rail |
 *
 * A method whose area has no Nuvion call yet answers `not_supported`:
 * nothing is sent and nothing moves.
 */
export class NuvionWalletProvider implements WalletProvider {
  readonly name = 'nuvion' as const;
  readonly label = 'Nuvion';
  /** Built only with every Nuvion setting present (nuvion-config.ts). */
  readonly configured = true;
  /**
   * Nuvion's transfer has no field for a fee of ours, so WAWU's fee on a send
   * is its own book transfer to the operational account (FIX-52).
   */
  readonly wawuFeeLeg = true;
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

  /** The book transfer area (NUV-05): the handler reads transfers through it. */
  get book(): NuvionBookArea {
    const area = this.areas.book;
    if (!(area instanceof NuvionBookArea)) {
      throw new Error("The book area of this adapter is not Nuvion's.");
    }
    return area;
  }

  /** The documents area (NUV-03): the upload, the submission and the hosted selfie. */
  get documents(): NuvionDocumentsArea {
    const area = this.areas.documents;
    if (!(area instanceof NuvionDocumentsArea)) {
      throw new Error("The documents area of this adapter is not Nuvion's.");
    }
    return area;
  }

  /** The payouts area (NUV-06): the bank list, the name check, NIP sends and the transfers read back. */
  get payouts(): NuvionPayoutsArea {
    const area = this.areas.payouts;
    if (!(area instanceof NuvionPayoutsArea)) {
      throw new Error("The payouts area of this adapter is not Nuvion's.");
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
    return this.areas.book.findTransactionByReference(reference);
  }
  findTransactionById(id: string) {
    return this.areas.book.findTransactionById(id);
  }
  listTransactions(holder: ProviderHolder, query: ProviderPageQuery) {
    return this.areas.reconcile.listTransactions(holder, query);
  }
  /**
   * What Nuvion knows of one of our sends. A book transfer is found through
   * the book log (NUV-05). A reference the log never held is another rail's;
   * one of ours that names a bank send (`BANK_SEND_REFERENCE_PREFIX`, NUV-06)
   * is then asked of the payouts area by the sender's transfers
   * (`reconcileBankSend`, WALLET-09), which never makes a transfer and never
   * reads silence as "no money moved". Any other reference is not asked.
   */
  async reconcileSend(
    reference: string,
    holder: ProviderHolder,
    since?: Date,
  ): Promise<ProviderReconciliation> {
    const book = await this.areas.book.reconcileSend(reference, holder, since);
    if (
      book.state === 'unknown' &&
      book.why === 'unrecognised' &&
      reference.startsWith(BANK_SEND_REFERENCE_PREFIX) &&
      this.areas.payouts instanceof NuvionPayoutsArea
    ) {
      return reconcileBankSend(this.areas.payouts, reference, holder, since);
    }
    return book;
  }
  decideRetry(
    kind: ProviderSendKind,
    reconciliation: ProviderReconciliation,
    clock: { attemptedAt: Date; now: Date; resendAfterMs: number },
  ) {
    return this.areas.book.decideRetry(kind, reconciliation, clock);
  }
  confirmMovement(input: {
    references: readonly string[];
    sender: ProviderHolder | null;
    amountKobo: number;
    around: Date;
    limits: ProviderConfirmLimits;
  }) {
    return this.areas.book.confirmMovement(input);
  }
  secondaryReferenceOf(t: ProviderTransaction) {
    return this.areas.book.secondaryReferenceOf(t);
  }
  /** Whether two names are one account at Nuvion (NUV-05, MONEY-17 R5-1). */
  isSameAccount(a: string, b: string) {
    return this.areas.book.isSameAccount(a, b);
  }
}
