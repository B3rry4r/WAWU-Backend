/**
 * OPS-DEL-TEST round 1 (B1): every table where an account can hold a row that touches a REAL-money provider.
 * delete-test-account.ts lists these rows in the dry run and REFUSES to apply while any exists, whatever its status
 * (pending or final). There is no flag to override it.
 *
 * Two classes:
 *  - `live`      Flutterwave (the website's rail, live, R-1), or a table whose provider cannot be told from the schema
 *                and the code. Unclear is live. Any row refuses.
 *  - `provider`  the wallet provider (Fintava or Nuvion): the table has a `provider` column. A row of the provider
 *                this server runs (proven sandbox) is test money and stays as the task allows; a row of any other
 *                provider, or with no provider, refuses.
 * The money check in AccountDeletionMoneyService still covers the wallet provider's balance, holds, earnings and
 * payments in flight; those tables (WalletHold, WalletPayment, EarningSettlement, FintavaWallet, ...) are sandbox-only
 * and are not listed here.
 */
import { isRowOf } from '../../src/wallet-provider/provider-rows';
import type { WalletProviderName } from '../../src/wallet-provider/wallet-provider.interface';
import type { PrismaService } from '../../src/common/prisma/prisma.service';

export interface MoneyTable {
  model: string;
  /** Columns that name the account; a row matches if any does. */
  columns: string[];
  klass: 'live' | 'provider';
  /** Why the table is in this class. */
  why: string;
  status?: string;
  /** The amount column and its unit: naira is whole naira (the legacy tables), kobo, or minor (currency unknown). */
  amount?: { field: string; unit: 'naira' | 'kobo' | 'minor' };
  /** Only rows matching this extra filter count (a balance of zero is not money). */
  only?: Record<string, unknown>;
}

const FW = 'Flutterwave (live, R-1)';

export const REAL_MONEY_TABLES: MoneyTable[] = [
  {
    model: 'CreatorWallet',
    columns: ['wawuUserId'],
    klass: 'live',
    why: `${FW} payout subaccount`,
    status: 'status',
  },
  {
    model: 'WalletLedgerEntry',
    columns: ['wawuUserId'],
    klass: 'live',
    why: `${FW} wallet ledger`,
    status: 'status',
    amount: { field: 'amount', unit: 'naira' },
  },
  {
    model: 'WalletWithdrawal',
    columns: ['wawuUserId'],
    klass: 'live',
    why: `${FW} payout withdrawal`,
    amount: { field: 'amount', unit: 'naira' },
  },
  {
    model: 'Purchase',
    columns: ['buyerWawuId', 'creatorWawuId'],
    klass: 'live',
    why: `${FW} card payment, buyer or seller`,
    status: 'status',
    amount: { field: 'amount', unit: 'naira' },
  },
  {
    model: 'VerificationPurchase',
    columns: ['wawuUserId'],
    klass: 'live',
    why: `${FW} tick payment`,
    status: 'status',
  },
  {
    model: 'DirectMessage',
    columns: ['senderWawuId', 'creatorWawuId'],
    klass: 'live',
    why: `${FW} paid DM, either side`,
    status: 'status',
    amount: { field: 'amount', unit: 'naira' },
  },
  {
    model: 'CreditPurchase',
    columns: ['userWawuId'],
    klass: 'live',
    why: `${FW} credits bought`,
    status: 'status',
    amount: { field: 'amount', unit: 'naira' },
  },
  {
    model: 'CreditLot',
    columns: ['userWawuId'],
    klass: 'live',
    why: 'credits bought with money',
    amount: { field: 'grossKobo', unit: 'kobo' },
  },
  {
    model: 'CreditSpend',
    columns: ['userWawuId', 'creatorWawuId'],
    klass: 'live',
    why: 'credits spent; the host is owed a share of money paid on Flutterwave',
  },
  {
    model: 'CreditsState',
    columns: ['userWawuId'],
    klass: 'live',
    why: 'a credit balance bought with money',
    only: { creditBalance: { gt: 0 } },
  },
  {
    model: 'PendingCharge',
    columns: ['wawuUserId'],
    klass: 'live',
    why: `${FW} charge waiting for its answer`,
  },
  {
    model: 'BillPayment',
    columns: ['buyerWawuId'],
    klass: 'live',
    why: `${FW} bill`,
    status: 'status',
    amount: { field: 'amount', unit: 'naira' },
  },
  {
    model: 'HealthSubscription',
    columns: ['wawuUserId'],
    klass: 'live',
    why: `${FW} health plan`,
    status: 'status',
    amount: { field: 'price', unit: 'naira' },
  },
  {
    model: 'EventOrder',
    columns: ['buyerWawuId'],
    klass: 'live',
    why: `${FW} event tickets`,
    status: 'status',
    amount: { field: 'amountNaira', unit: 'naira' },
  },
  {
    model: 'ShopOrder',
    columns: ['buyerWawuId'],
    klass: 'live',
    why: `${FW} shop order`,
    status: 'status',
    amount: { field: 'totalNaira', unit: 'naira' },
  },
  {
    model: 'MakerPurchase',
    columns: ['wawuUserId'],
    klass: 'live',
    why: 'payment by reference; provider not stated in the schema (unclear is live)',
    status: 'status',
    amount: { field: 'amountMinor', unit: 'minor' },
  },
  {
    model: 'MakerExtraProducts',
    columns: ['wawuUserId'],
    klass: 'live',
    why: 'payment by reference; provider not stated in the schema (unclear is live)',
    amount: { field: 'amountMinor', unit: 'minor' },
  },
  {
    model: 'PlanTransferOrder',
    columns: ['wawuUserId'],
    klass: 'live',
    why: 'no provider column (unclear is live)',
    status: 'status',
    amount: { field: 'totalKobo', unit: 'kobo' },
  },
  {
    model: 'MoneyPayoutAccount',
    columns: ['wawuUserId'],
    klass: 'live',
    why: 'a bank account for payouts (provider not stated; unclear is live)',
  },
  {
    model: 'StoreCredit',
    columns: ['wawuUserId'],
    klass: 'live',
    why: 'store credit (provider not stated; unclear is live)',
    status: 'status',
    amount: { field: 'amountKobo', unit: 'kobo' },
  },
  {
    model: 'CommunityPass',
    columns: ['userWawuId'],
    klass: 'live',
    why: 'a pass bought with money (provider not stated; unclear is live)',
    amount: { field: 'priceKobo', unit: 'kobo' },
  },
  {
    model: 'LegalRequest',
    columns: ['wawuUserId'],
    klass: 'live',
    why: `${FW} consultation or service fee (a request that carries a payment reference)`,
    status: 'status',
    amount: { field: 'consultationFee', unit: 'naira' },
    only: {
      OR: [
        { consultationTxRef: { not: null } },
        { serviceTxRef: { not: null } },
      ],
    },
  },
  {
    model: 'WaitlistRegistration',
    columns: ['claimedByWawuId'],
    klass: 'live',
    why: `${FW} payment made at /join and claimed by this account`,
    status: 'status',
    amount: { field: 'paidKobo', unit: 'kobo' },
  },
  {
    model: 'ServiceApplication',
    columns: ['applicantWawuId'],
    klass: 'live',
    why: `${FW} CAC fee (an application that carries a payment)`,
    status: 'status',
    amount: { field: 'amountPaid', unit: 'naira' },
    only: { amountPaid: { not: null } },
  },
  {
    model: 'StorePurchase',
    columns: ['wawuUserId', 'creatorWawuUserId'],
    klass: 'live',
    why: 'App Store or Play payment, buyer or the creator owed a share; only a purchase the store marked sandbox is test money',
    status: 'status',
    amount: { field: 'referenceKobo', unit: 'kobo' },
    only: { environment: { not: 'sandbox' } },
  },
  {
    model: 'StoreSubscription',
    columns: ['wawuUserId'],
    klass: 'live',
    why: 'App Store or Play subscription; the row does not say sandbox or production (unclear is live)',
  },
  {
    model: 'CreditSpendEarning',
    columns: ['creatorWawuId'],
    klass: 'live',
    why: `host share of credits bought on ${FW}`,
    amount: { field: 'hostShareKobo', unit: 'kobo' },
  },
  {
    model: 'FintavaLedgerEntry',
    columns: ['wawuUserId', 'counterpartyWawuUserId'],
    klass: 'provider',
    why: 'wallet provider ledger row, either side',
    status: 'status',
    amount: { field: 'amountKobo', unit: 'kobo' },
  },
  {
    model: 'CommunityPassRefund',
    columns: ['userWawuId', 'hostWawuId'],
    klass: 'provider',
    why: 'wallet provider refund, either side',
    status: 'status',
    amount: { field: 'amountKobo', unit: 'kobo' },
  },
  {
    model: 'WalletCard',
    columns: ['wawuUserId'],
    klass: 'provider',
    why: 'wallet provider card',
    status: 'state',
  },
  {
    model: 'StoreEarning',
    columns: ['payeeWawuUserId'],
    klass: 'provider',
    why: 'wallet provider earning',
    status: 'status',
    amount: { field: 'amountKobo', unit: 'kobo' },
  },
  {
    model: 'StoreEarningPayout',
    columns: ['payeeWawuUserId'],
    klass: 'provider',
    why: 'wallet provider payout',
    status: 'status',
    amount: { field: 'amountKobo', unit: 'kobo' },
  },
  {
    model: 'PointConversion',
    columns: ['wawuUserId'],
    klass: 'provider',
    why: 'wallet provider cash-out',
    status: 'status',
    amount: { field: 'cashKobo', unit: 'kobo' },
  },
  {
    model: 'WalletTransfer',
    columns: ['payerWawuUserId', 'recipientWawuUserId'],
    klass: 'provider',
    why: 'wallet provider transfer, either side',
    status: 'status',
    amount: { field: 'amountKobo', unit: 'kobo' },
  },
  {
    model: 'AddMoneySession',
    columns: ['wawuUserId'],
    klass: 'provider',
    why: 'wallet provider top-up',
    status: 'status',
    amount: { field: 'amountKobo', unit: 'kobo' },
  },
  {
    model: 'EarningMove',
    columns: ['payeeWawuUserId'],
    klass: 'provider',
    why: 'wallet provider earning move',
    status: 'status',
    amount: { field: 'amountKobo', unit: 'kobo' },
  },
];

const WP = 'wallet-provider money';

/**
 * Tables that hold wallet-provider money (WalletPayment and its family) and are NOT checked row by row here: the
 * wallet provider is proven sandbox first, and AccountDeletionMoneyService blocks on the balance, holds, waiting
 * earnings and payments in flight. They carry no Flutterwave field. Listed so the schema walk in the spec can tell
 * "looked at" from "forgotten".
 */
export const WALLET_PROVIDER_TABLES: Record<string, string> = {
  FintavaWallet: `${WP}: the wallet itself; its balance is the money service's check`,
  FintavaWalletOpening: `${WP}: a wallet opening, checked as wallet_opening`,
  WalletPayment: `${WP}: a payment through the wallet; in flight is checked as payment_in_progress`,
  WalletHold: `${WP}: held money; any open hold refuses as open_hold`,
  EarningSettlement: `${WP}: waiting earnings; checked as waiting_earnings`,
  EarningDeduction: `${WP}: an earning taken back; moves through the wallet provider`,
  EarningDeductionTake: `${WP}: the part of a deduction taken from one move`,
  MoneyRequest: `${WP}: a request to be paid; paid by a WalletTransfer`,
  NuvionBookTransfer: `${WP}: a Nuvion book transfer; only exists on a Nuvion server`,
  NuvionReconcileFinding: `${WP}: a reconciliation finding; the account is not named`,
  MoneyCheckRun: `${WP}: a check run's own log, not an account's money`,
  CapitalOrder: `${WP}: a wallet-provider capital order`,
  FxAccount: `${WP}: a foreign-currency account at the wallet provider`,
  FxQuote: `${WP}: a quote, no money moves`,
  FxOperation: `${WP}: a foreign-currency operation through the wallet provider`,
  FxMovement: `${WP}: a foreign-currency movement through the wallet provider`,
  AbroadRecipient: `${WP}: a saved recipient abroad, no funds`,
  AbroadQuote: `${WP}: a quote, no money moves`,
  AbroadSend: `${WP}: a send abroad through the wallet provider`,
  WalletPaymentFx: `${WP}: the currency side of a WalletPayment`,
  WalletBill: `${WP}: a bill paid through a WalletPayment and its hold; no Flutterwave field and no provider column`,
  SchoolEnrolment: `${WP}: a school fee paid through a WalletPayment and its hold; no Flutterwave field`,
  SchoolSettlement: `${WP}: the school's share moving through the wallet provider`,
  StoreProceedsEntry: `${WP}: WAWU's own store proceeds record for a StorePurchase; not the account's money`,
};

/** Tables with a money-looking field that hold no money of an account, each with the reason. */
export const NOT_MONEY_TABLES: Record<string, string> = {
  UserProfile: 'unpaidWarnedAt is a warning timestamp',
  ProductDraft: 'a draft price, nothing sold',
  CreatorState: 'the price the creator asks for a DM, a setting',
  ContentPiece: 'a piece and its list price; a sale is a Purchase',
  Community:
    'a room and its pass price; a sale is a CommunityPass or StorePurchase',
  CommunityPassPrice: 'a price list',
  Notification: 'text shown to a person; the amount is a copy',
  PartnerService: 'a partner catalogue price',
  PaymentWebhookReceipt:
    'a Flutterwave delivery log keyed by tx_ref, not by account; the payment itself is in the listed tables',
  LegalConsultationOption: 'a price list',
  LegalServicePrice: 'a price list',
  EventTicketType: 'a ticket price list; a sale is an EventOrder',
  EventOrderLine: 'a line of an EventOrder, which is listed',
  Product: 'a catalogue price; a sale is a ShopOrder',
  ShopOrderItem: 'a line of a ShopOrder, which is listed',
  PlatformSettings: 'platform prices, one row',
  SchoolCourse: 'a school catalogue price',
  SchoolPayee: 'where a school is paid, not an account',
  AccountDeletion: 'the audit record; walletProvider names the provider only',
  ReferralCode: 'a code and its price, a setting',
  ReferralReward:
    'points, never naira; paymentRef only points at a MakerPurchase, which is listed',
  EmailRecipient: "providerId is the email provider's id",
  AiToolJob: 'providerRef is an AI vendor job id',
  AiClonedVoice: 'providerVoiceId is an AI vendor id',
  ReceptionistAgent: 'providerAgentId is an AI vendor id',
  ReceptionistKnowledge: 'providerDocId is an AI vendor id',
  MoviePartnerMovie: 'provider is the movie catalogue source',
  MoviePartnerSync: 'provider is the movie catalogue source',
  MoviePartnerLink: 'provider is the movie catalogue source',
  MoviePartnerConsent: 'provider is the movie catalogue source',
  StoreProduct: 'the store product catalogue and its prices',
  StorePlatformSetting: "the stores' cut, a setting",
  StoreCut30Switch: 'the date the cut changed, a setting',
  PriceListMove: 'a log of an admin changing a price list',
  StorePurchaseIntent:
    'a price quote that expires: no money moves until a StorePurchase (listed) is made against it',
  MoneyBeneficiary:
    'a saved payee (a person or a bank account number): a destination, holds no funds and moves none',
  KycSubmission:
    'an identity review; the payout bank is a destination for review, no money moves or is held here',
};

export interface RealMoneyRow {
  table: string;
  id: string;
  status: string;
  amountKobo: string;
  klass: string;
  why: string;
}

/** Every real-money row the account has, in every table above. A table that cannot be read is reported as a row (never skipped). */
export async function findRealMoneyRows(
  prisma: PrismaService,
  id: string,
  running: WalletProviderName,
): Promise<RealMoneyRow[]> {
  const out: RealMoneyRow[] = [];
  for (const t of REAL_MONEY_TABLES) {
    const delegate = (
      prisma as unknown as Record<
        string,
        {
          findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
        }
      >
    )[t.model.charAt(0).toLowerCase() + t.model.slice(1)];
    let rows: Record<string, unknown>[];
    try {
      rows = await delegate.findMany({
        where: {
          AND: [
            { OR: t.columns.map((c) => ({ [c]: id })) },
            ...(t.only ? [t.only] : []),
          ],
        },
        take: 100,
      });
    } catch (e) {
      out.push({
        table: t.model,
        id: '?',
        status: 'unreadable',
        amountKobo: '?',
        klass: t.klass,
        why: `could not be read (${(e as Error).message.slice(0, 80)}); treated as live`,
      });
      continue;
    }
    for (const r of rows) {
      if (
        t.klass === 'provider' &&
        isRowOf(running, r.provider as string | null)
      )
        continue;
      let kobo = '-';
      if (t.amount) {
        const v = r[t.amount.field];
        if (v !== null && v !== undefined) {
          const n = BigInt(v as number | bigint);
          kobo =
            t.amount.unit === 'naira'
              ? String(n * 100n)
              : t.amount.unit === 'kobo'
                ? String(n)
                : `${n} (minor units)`;
        }
      }
      const key =
        r.id ?? r.txRef ?? r.reference ?? r.wawuUserId ?? r.userWawuId;
      out.push({
        table: t.model,
        id: String(key),
        status:
          t.status && r[t.status] !== undefined ? String(r[t.status]) : '-',
        amountKobo: kobo,
        klass: t.klass,
        why:
          t.klass === 'provider'
            ? `${t.why}; provider is not ${running}`
            : t.why,
      });
    }
  }
  return out;
}
