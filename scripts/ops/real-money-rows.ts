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
        where: { OR: t.columns.map((c) => ({ [c]: id })), ...(t.only ?? {}) },
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
