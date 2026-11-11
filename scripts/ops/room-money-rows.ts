/**
 * OPS-CLEAR-ROOMS: the real-money rules for a community, in their own file so scripts/ops/real-money-rows.ts (the
 * account rules of OPS-DEL-TEST) is not touched. Reuses its RealMoneyRow shape.
 */
import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { isRowOf } from '../../src/wallet-provider/provider-rows';
import type { WalletProviderName } from '../../src/wallet-provider/wallet-provider.interface';
import type { RealMoneyRow } from './real-money-rows';

const FW = 'Flutterwave (live, R-1)';

/** The Hub's database handle, or the one inside a transaction. */
export type Db = PrismaService | Prisma.TransactionClient;

/**
 * OPS-CLEAR-ROOMS: every record in or around ONE community that is real money or money in motion. clear-communities.ts
 * lists them and KEEPS the room while any exists; there is no flag to override it.
 *
 * `sandboxProven` is the OPS-DEL-TEST proof (proveTestProvider): with the wallet provider not proven to be on test
 * keys, every pass and every wallet-bought credit is real money. Read-only; this is also run again inside the clearing
 * transaction, so a pass bought after the dry run keeps its room.
 *
 *  - a pass: real unless paid from a wallet of the provider this server runs, proven sandbox, or through a store in
 *    its sandbox; a pass whose payment cannot be found is real (unclear is live)
 *  - a payment for the room still pending, a store subscription not lapsed, a refund not yet `refunded`: in motion
 *  - credits spent: the host's earning names the lots that funded it. A lot bought through Flutterwave (no wallet
 *    payment, no store purchase) is real; wallet-bought needs the sandbox proof and the running provider; a store
 *    purchase must be a store sandbox one. A funded spend whose lot cannot be found is real. The host's earning
 *    settlement must have landed (in a landed move), on the running provider, or it is money in motion.
 *  - a spend with no earning row (before the ledger existed) carries no money record and is not real money.
 */
export async function findRoomMoneyRows(
  db: Db,
  communityId: string,
  running: WalletProviderName,
  sandboxProven: boolean,
): Promise<RealMoneyRow[]> {
  const out: RealMoneyRow[] = [];
  const add = (
    table: string,
    id: string,
    status: string,
    amount: bigint | number | null | undefined,
    klass: string,
    why: string,
  ) =>
    out.push({
      table,
      id,
      status,
      amountKobo:
        amount === null || amount === undefined ? '-' : String(amount),
      klass,
      why,
    });
  const walletOk = (provider: string | null | undefined) =>
    sandboxProven && isRowOf(running, provider);

  // Passes.
  const passes = await db.communityPass.findMany({
    where: { communityId },
    select: { id: true, walletPaymentId: true, priceKobo: true },
  });
  for (const p of passes) {
    if (p.walletPaymentId.startsWith('store:')) {
      const sp = await db.storePurchase.findUnique({
        where: { id: p.walletPaymentId.slice('store:'.length) },
        select: { environment: true },
      });
      if (!sp || sp.environment !== 'sandbox')
        add(
          'CommunityPass',
          p.id,
          sp?.environment ?? 'unknown',
          p.priceKobo,
          'live',
          'a pass bought through a store, not proven to be a store sandbox purchase',
        );
      continue;
    }
    const pay = await db.walletPayment.findUnique({
      where: { id: p.walletPaymentId },
      select: { provider: true },
    });
    if (!pay)
      add(
        'CommunityPass',
        p.id,
        'payment missing',
        p.priceKobo,
        'live',
        'its payment cannot be found (unclear is live)',
      );
    else if (!walletOk(pay.provider))
      add(
        'CommunityPass',
        p.id,
        pay.provider,
        p.priceKobo,
        'provider',
        sandboxProven
          ? `paid at ${pay.provider}, not ${running}`
          : 'the wallet provider is not proven to be on test credentials, so a pass is real money',
      );
  }
  // A payment for this room that has not finished.
  const pending = await db.walletPayment.findMany({
    where: { kind: 'community_pass', targetId: communityId, status: 'pending' },
    select: { id: true, priceKobo: true },
  });
  for (const w of pending)
    add(
      'WalletPayment',
      w.id,
      'pending',
      w.priceKobo,
      'provider',
      'a pass payment in flight',
    );
  // Store purchases and subscriptions.
  const sps = await db.storePurchase.findMany({
    where: { communityId, NOT: { environment: 'sandbox' } },
    select: { id: true, status: true, netKobo: true, environment: true },
  });
  for (const sp of sps)
    add(
      'StorePurchase',
      sp.id,
      `${sp.status}, ${sp.environment}`,
      sp.netKobo,
      'live',
      'a store purchase for this room that is not a store sandbox one',
    );
  const subs = await db.storeSubscription.findMany({
    where: { communityId, lapsedAt: null },
    select: { id: true },
  });
  for (const s of subs)
    add(
      'StoreSubscription',
      s.id,
      'active',
      null,
      'live',
      'a store subscription that has not ended would renew into a room that is gone',
    );
  // Refunds not yet settled.
  const refunds = await db.communityPassRefund.findMany({
    where: { communityId, NOT: { status: 'refunded' } },
    select: { id: true, status: true, amountKobo: true },
  });
  for (const r of refunds)
    add(
      'CommunityPassRefund',
      r.id,
      r.status,
      r.amountKobo,
      'provider',
      'a refund that is not settled is money in motion',
    );
  // Credits spent in the room.
  const earnings = await db.creditSpendEarning.findMany({
    where: { communityId },
    select: {
      id: true,
      creditsFunded: true,
      grossKobo: true,
      lotIds: true,
      settlement: {
        select: {
          id: true,
          status: true,
          provider: true,
          amountKobo: true,
          move: { select: { status: true } },
        },
      },
    },
  });
  const seen = new Set<string>();
  for (const e of earnings) {
    if (e.creditsFunded > 0 || e.grossKobo > 0 || e.lotIds.length > 0) {
      const lots = await db.creditLot.findMany({
        where: { id: { in: e.lotIds } },
        select: {
          id: true,
          creditPurchase: {
            select: { id: true, walletPaymentId: true, storePurchaseId: true },
          },
        },
      });
      if (lots.length === 0 || lots.length !== e.lotIds.length)
        add(
          'CreditSpendEarning',
          e.id,
          'lot missing',
          e.grossKobo,
          'live',
          'the lot that funded this spend cannot be found (unclear is live)',
        );
      for (const lot of lots) {
        const cp = lot.creditPurchase;
        if (seen.has(cp.id)) continue;
        seen.add(cp.id);
        if (cp.storePurchaseId) {
          const sp = await db.storePurchase.findUnique({
            where: { id: cp.storePurchaseId },
            select: { environment: true },
          });
          if (!sp || sp.environment !== 'sandbox')
            add(
              'CreditPurchase',
              cp.id,
              sp?.environment ?? 'unknown',
              null,
              'live',
              'credits bought through a store, not a store sandbox purchase',
            );
        } else if (cp.walletPaymentId) {
          const pay = await db.walletPayment.findUnique({
            where: { id: cp.walletPaymentId },
            select: { provider: true },
          });
          if (!pay || !walletOk(pay.provider))
            add(
              'CreditPurchase',
              cp.id,
              pay?.provider ?? 'payment missing',
              null,
              'provider',
              sandboxProven
                ? 'credits bought at another provider'
                : 'the wallet provider is not proven to be on test credentials',
            );
        } else {
          add(
            'CreditPurchase',
            cp.id,
            'flutterwave',
            null,
            'live',
            `${FW} credit purchase funded spends in this room`,
          );
        }
      }
    }
    const st = e.settlement;
    if (st) {
      if (st.status !== 'landed' || (st.move && st.move.status !== 'landed'))
        add(
          'EarningSettlement',
          st.id,
          st.status,
          st.amountKobo,
          'provider',
          "the host's earning is still on its way to their wallet",
        );
      else if (!walletOk(st.provider))
        add(
          'EarningSettlement',
          st.id,
          st.status,
          st.amountKobo,
          'provider',
          sandboxProven
            ? `landed at ${st.provider}, not ${running}`
            : 'the wallet provider is not proven to be on test credentials',
        );
    }
  }
  return out;
}
