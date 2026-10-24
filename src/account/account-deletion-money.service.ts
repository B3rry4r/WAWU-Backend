import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  DELETION_GRACE_MS,
  FREEZING_STALE_MS,
} from './account-deletion-config';
import { MoneyError } from '../money/money-error';
import { isRowOf } from '../wallet-provider/provider-rows';
import {
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../wallet-provider/wallet-provider-error';

/**
 * What stops an account from being deleted, in the words the app reads
 * (task SETTINGS-06, R-17):
 *
 *   wallet_balance       the wallet holds money (the provider's balance)
 *   open_hold            a paid DM, ticket or bill is held, for or against them (R-19)
 *   waiting_earnings     a sale's share, or a community host's share of spent
 *                        credits, has not reached their wallet yet (R-11)
 *   payment_in_progress  a payment of theirs has no final answer yet (a send
 *                        abroad included, NUV-11)
 *   cash_out_in_flight   points are held for a cash-out
 *   wallet_opening       their wallet is being opened right now
 *
 * And, because the wallet must be empty before an account is deleted (R-17)
 * and money in a foreign account or in Capital is as much theirs as the naira
 * wallet's (WALLET-21, NUV-12):
 *
 *   fx_balance             a foreign-currency account holds money (the provider's balance)
 *   fx_balance_unreadable  a foreign-currency account could not be read: never called empty
 *   fx_operation_pending   a swap or a send of theirs has no final answer yet
 *   capital_holding        a Capital holding is not closed (held, matured, or paying out)
 *   capital_order_pending  a Capital order is reserved, confirming or in review
 */
export const DELETION_BLOCKERS = [
  'wallet_balance',
  'open_hold',
  'waiting_earnings',
  'payment_in_progress',
  'cash_out_in_flight',
  'wallet_opening',
  'fx_balance',
  'fx_balance_unreadable',
  'fx_operation_pending',
  'capital_holding',
  'capital_order_pending',
] as const;
export type DeletionBlocker = (typeof DELETION_BLOCKERS)[number];

/** The reason an account still has money: counts and the provider's figure. */
export interface DeletionMoneyCheck {
  blockers: DeletionBlocker[];
  /** The provider's balance (the larger of available and booked); null: no wallet. */
  balanceKobo: number | null;
  openHolds: number;
  waitingEarnings: number;
  /** The wallet this server can act on; null: none, so nothing to freeze. */
  wallet: { walletId: string; provider: string } | null;
}

/** The sentences the app shows as they are (Z6). No em-dash. */
export const DELETION_BLOCKED_MESSAGES = {
  balance:
    'Empty your wallet first. Withdraw what is in it to your bank, then delete your account.',
  onItsWay:
    'Some of your money is still on its way. Delete your account once it has reached your wallet and you have withdrawn it.',
  opening: 'Your wallet is still being set up. Try again in a few minutes.',
  fxBalance:
    'Move the money out of your other currency accounts first. Swap it to naira and withdraw it, or send it out, then delete your account.',
  fxUnreadable:
    'We could not check your other currency accounts. Your money is safe. Try again in a moment.',
  inFlight:
    'A swap, a send or a Capital order of yours is still going through. Try again in a few minutes.',
  capitalHolding:
    'You still have money in Capital. Withdraw it, or wait for the holding to end, then delete your account.',
  unreachable:
    'We could not reach your account. Your money is safe. Try again in a moment.',
} as const;

/**
 * The one sentence for a set of blockers: the wallet's money leads, then the
 * foreign accounts', then Capital's; a set that is only "wait" gets the
 * sentence for waiting.
 */
function deletionBlockedMessage(blockers: readonly DeletionBlocker[]): string {
  const m = DELETION_BLOCKED_MESSAGES;
  if (blockers.includes('wallet_balance')) return m.balance;
  if (blockers.includes('fx_balance')) return m.fxBalance;
  if (blockers.includes('capital_holding')) return m.capitalHolding;
  if (blockers.every((b) => b === 'wallet_opening')) return m.opening;
  if (blockers.every((b) => b === 'fx_balance_unreadable'))
    return m.fxUnreadable;
  if (
    blockers.every(
      (b) => b === 'fx_operation_pending' || b === 'capital_order_pending',
    )
  ) {
    return m.inFlight;
  }
  return m.onItsWay;
}

/** The provider's holding states after which nothing more is owed to the person (Capital). */
const CAPITAL_CLOSED_LIFECYCLES = ['WITHDRAWN', 'CLOSED', 'REFUNDED'];

/** `409 account_deletion_blocked`: the money to settle first, in the one error shape. */
export class AccountDeletionBlockedError extends HttpException {
  constructor(check: DeletionMoneyCheck) {
    const blockers = check.blockers;
    const message = deletionBlockedMessage(blockers);
    super(
      {
        message,
        reason: {
          code: 'account_deletion_blocked',
          message,
          blockers,
          ...(check.balanceKobo === null
            ? {}
            : { balanceKobo: check.balanceKobo }),
          openHolds: check.openHolds,
          waitingEarnings: check.waitingEarnings,
        },
      },
      409,
    );
  }
}

/**
 * What `reconcileWallet` did. `want`: the state the deletion row asks of the
 * wallet (null: no wallet this server may act on, so nothing was asked).
 * `done`: the provider confirmed that state in this call. `failed`: the
 * provider (or the database) did not answer, or the row kept changing while
 * it was being matched (round 6); the row is as it was.
 */
export interface ReconcileOutcome {
  want: 'frozen' | 'unfrozen' | null;
  done: boolean;
  failed: boolean;
}

/** How many times one reconcile acts when the row changes under it (round 6). */
const RECONCILE_ROUNDS = 3;

/** What the deletion row asks of which wallets, at one moment. */
interface ReconcilePlan {
  /** null: nothing to ask of any wallet this server may act on. */
  want: 'frozen' | 'unfrozen' | null;
  wallets: { walletId: string; provider: string | null }[];
  /** The row's status; null: no row. */
  status: string | null;
  cancelledAt: Date | null;
  /** A wallet is known but another provider holds it: nothing was asked. */
  foreign: boolean;
}

/**
 * A cancelled row is settled when its cancel is older than a request is
 * allowed to run (FREEZING_STALE_MS: past that a request is presumed dead), so
 * none of its provider calls can still land.
 */
const isSettled = (plan: ReconcilePlan): boolean =>
  !plan.cancelledAt ||
  Date.now() - plan.cancelledAt.getTime() >= FREEZING_STALE_MS;

/** True when two plans ask the same of the same wallets (the row did not change in a way that matters). */
const sameWork = (a: ReconcilePlan, b: ReconcilePlan): boolean =>
  a.want === b.want &&
  a.wallets
    .map((w) => w.walletId)
    .sort()
    .join('|') ===
    b.wallets
      .map((w) => w.walletId)
      .sort()
      .join('|');

/** What a freeze or an unfreeze did. */
export interface FreezeOutcome {
  /** False: the provider cannot freeze, so nothing was done (and nothing is said to be). */
  done: boolean;
}

/**
 * The money half of deleting an account (task SETTINGS-06): is the person's
 * money settled, and freeze or unfreeze their wallet. Everything goes through
 * the wallet provider seam (R-39), never a provider's client.
 *
 * - The provider's balance is the only balance (R-1): this reads it, never a
 *   sum of our own rows. The counts below are counts of rows that say money
 *   is on its way, shown as counts.
 * - A person with no wallet (R-6) has no balance and nothing to freeze, but a
 *   hold or an earning can still be waiting for them (R-11), so those are
 *   checked whether or not they have a wallet.
 * - A wallet this server cannot ask about (another provider holds it, or the
 *   provider does not answer) is `503 provider_unreachable`, never a guess
 *   that it is empty.
 */
@Injectable()
export class AccountDeletionMoneyService {
  private readonly logger = new Logger(AccountDeletionMoneyService.name);

  constructor(
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly prisma: PrismaService,
  ) {}

  /** Every blocker the person has right now, with the figures the app shows. */
  async check(wawuUserId: string): Promise<DeletionMoneyCheck> {
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { walletId: true, provider: true },
    });
    const now = new Date();
    const [
      openHolds,
      owedSales,
      pendingPayments,
      cashOuts,
      opening,
      pendingFx,
      pendingCapital,
      capitalHoldings,
      foreignAccounts,
    ] = await Promise.all([
      this.prisma.walletHold.count({
        where: {
          status: 'held',
          OR: [
            { payerWawuUserId: wawuUserId },
            { payeeWawuUserId: wawuUserId },
          ],
        },
      }),
      // A completed sale whose share has not landed: no hold, or a hold
      // that was released as an earning (R-55) and whose move has not
      // landed (an open hold is counted above, a refunded one is the
      // payer's), and the payee's share is more than 0.
      this.prisma.walletPayment.count({
        where: {
          status: 'completed',
          payeeWawuUserId: wawuUserId,
          payeeShareKobo: { gt: 0 },
          payeeSettledAt: null,
          OR: [{ hold: { is: null } }, { hold: { status: 'released' } }],
        },
      }),
      this.prisma.walletPayment.count({
        where: {
          status: 'pending',
          OR: [
            { payerWawuUserId: wawuUserId },
            { payeeWawuUserId: wawuUserId },
          ],
        },
      }),
      this.prisma.pointHold.count({
        where: { wawuUserId, purpose: 'cash_out', state: 'held' },
      }),
      wallet
        ? Promise.resolve(null)
        : this.prisma.fintavaWalletOpening.findUnique({
            where: { wawuUserId },
            select: { state: true },
          }),
      // A swap or a send the provider has not given a final answer to.
      this.prisma.fxOperation.count({
        where: { wawuUserId, status: 'pending' },
      }),
      // A Capital order that moves no money yet (a reservation lasts 15
      // minutes; one past its time is expired, whatever the sweep has
      // marked), or whose money is in doubt: confirming, or held for review.
      this.prisma.capitalOrder.count({
        where: {
          wawuUserId,
          OR: [
            { state: { in: ['reserving', 'confirming', 'review'] } },
            {
              state: 'reserved',
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
          ],
        },
      }),
      // A Capital holding that is not closed: money is in it, or on its way
      // back. The holding's own state decides; `payoutStatus` is not used,
      // because nothing refreshes a row once its holding is closed and it
      // could stay "pending" for ever. What lands in the wallet is the
      // wallet's balance, checked above. A holding not yet read (null) is
      // open: `notIn` alone would drop it, since null is in no list.
      this.prisma.capitalOrder.count({
        where: {
          wawuUserId,
          state: 'confirmed',
          OR: [
            { lifecycle: null },
            { lifecycle: { notIn: CAPITAL_CLOSED_LIFECYCLES } },
          ],
        },
      }),
      this.prisma.fxAccount.findMany({
        where: { wawuUserId, providerAccountId: { not: null } },
        select: {
          provider: true,
          providerAccountId: true,
          providerCustomerId: true,
        },
      }),
    ]);

    // A community host's share of spent credits that has not landed
    // (WALLET-17): an earning with no sale behind it (a sale's earning is
    // counted above, through its payment), owed to the person.
    const owedHostShares = await this.prisma.earningSettlement.count({
      where: {
        payeeWawuUserId: wawuUserId,
        status: 'owed',
        creditSpendEarningId: { not: null },
      },
    });
    const waitingEarnings = owedSales + owedHostShares;
    // A send abroad (NUV-11) the provider has not finished, or whose WAWU fee the sweep is still taking or giving back: its row is
    // what the sweep finds the answer and the fee by, so it is not deleted from under it. The money already left the wallet, so the
    // balance below does not hold the deletion; it counts as a payment with no final answer. It stops counting once the sweep has
    // taken its last try (the fee is written off, or held for a person with a row in the admin audit, which a deletion keeps), so a
    // person is never held for ever (R1-4).
    const abroadUnfinished = await this.prisma.abroadSend.count({
      where: {
        wawuUserId,
        OR: [
          { status: { in: ['sending', 'pending', 'needs_review'] } },
          {
            status: 'completed',
            wawuFeeTaken: false,
            wawuFeeKobo: { gt: 0n },
            feeSettledAt: null,
            feeBackHeldAt: null,
          },
          {
            status: { in: ['failed', 'reversed'] },
            wawuFeeTaken: true,
            wawuFeeKobo: { gt: 0n },
            feeGivenBackAt: null,
            feeSettledAt: null,
            feeBackHeldAt: null,
          },
          {
            status: { in: ['failed', 'reversed'] },
            wawuFeeTaken: false,
            wawuFeeKobo: { gt: 0n },
            feeAttempts: { gt: 0 },
            feeSettledAt: null,
            feeBackHeldAt: null,
          },
        ],
      },
    });
    const blockers: DeletionBlocker[] = [];
    let balanceKobo: number | null = null;
    if (wallet) {
      if (!isRowOf(this.provider.name, wallet.provider)) {
        // Another provider holds this wallet (after a rollback): its balance
        // cannot be read from here, so "empty" cannot be said.
        this.logger.warn(
          `deletion: the wallet is held by another provider than ${this.provider.label}; not asked`,
        );
        throw this.unreachable();
      }
      balanceKobo = await this.balanceOf(wallet.walletId);
      if (balanceKobo > 0) blockers.push('wallet_balance');
    } else if (opening && ['opening', 'unknown'].includes(opening.state)) {
      blockers.push('wallet_opening');
    }
    if (openHolds > 0) blockers.push('open_hold');
    if (waitingEarnings > 0) blockers.push('waiting_earnings');
    if (pendingPayments + abroadUnfinished > 0) {
      blockers.push('payment_in_progress');
    }
    if (cashOuts > 0) blockers.push('cash_out_in_flight');
    blockers.push(...(await this.foreignBlockers(foreignAccounts, wallet)));
    if (pendingFx > 0) blockers.push('fx_operation_pending');
    if (capitalHoldings > 0) blockers.push('capital_holding');
    if (pendingCapital > 0) blockers.push('capital_order_pending');

    return {
      blockers,
      balanceKobo,
      openHolds,
      waitingEarnings,
      wallet: wallet
        ? { walletId: wallet.walletId, provider: this.provider.name }
        : null,
    };
  }

  /**
   * What the person's foreign-currency accounts say (R-17): `fx_balance` when
   * the provider reports money in one (available or booked), and
   * `fx_balance_unreadable` when one could not be read, which is never taken
   * for empty. Only the provider this server runs is asked, and only for an
   * account it has made; an account of another provider (after a rollback), or
   * a provider that holds none, cannot be read from here, so it is unreadable
   * too. A failure that is not the provider's is a bug and passes through.
   */
  private async foreignBlockers(
    rows: {
      provider: string;
      providerAccountId: string | null;
      providerCustomerId: string;
    }[],
    wallet: { walletId: string } | null,
  ): Promise<DeletionBlocker[]> {
    if (rows.length === 0) return [];
    const fx = this.provider.configured ? this.provider.fx : undefined;
    const states = await Promise.all(
      rows.map(async (row): Promise<'money' | 'empty' | 'unreadable'> => {
        if (!fx || !row.providerAccountId) return 'unreadable';
        if (!isRowOf(this.provider.name, row.provider)) {
          this.logger.warn(
            `deletion: a foreign account is held by another provider than ${this.provider.label}; not asked`,
          );
          return 'unreadable';
        }
        try {
          const a = await fx.readAccount(
            {
              customerId: row.providerCustomerId,
              walletId: wallet?.walletId ?? '',
            },
            row.providerAccountId,
          );
          return a.availableMinor > 0n || a.bookedMinor > 0n
            ? 'money'
            : 'empty';
        } catch (e) {
          if (e instanceof WalletProviderError) {
            this.logger.warn(
              `deletion: a foreign account could not be read (${e.kind})`,
            );
            return 'unreadable';
          }
          throw e;
        }
      }),
    );
    const blockers: DeletionBlocker[] = [];
    if (states.includes('money')) blockers.push('fx_balance');
    if (states.includes('unreadable')) blockers.push('fx_balance_unreadable');
    return blockers;
  }

  /** The provider's balance in kobo, the larger of available and booked. */
  async balanceOf(walletId: string): Promise<number> {
    try {
      const b = await this.provider.getBalance({ walletId });
      const bigger =
        b.availableKobo > b.bookedKobo ? b.availableKobo : b.bookedKobo;
      return safeKoboNumber(bigger);
    } catch (e) {
      if (e instanceof WalletProviderError) throw this.unreachable();
      throw e;
    }
  }

  /**
   * True when the provider this server runs holds a wallet that a stored row
   * names (its `provider` column; null is Fintava). A server acts only on rows
   * of its own provider (R-39): another's wallet id is never sent here.
   */
  holdsWalletOf(rowProviderName: string | null | undefined): boolean {
    return isRowOf(this.provider.name, rowProviderName);
  }

  /**
   * The one rule about a deletion and a wallet (SETTINGS-06 round 5; R-1,
   * wallet safety): a deletion in force always has a frozen wallet, and a
   * cancelled or absent deletion never does. This is the only function that
   * enforces it; every path that can change the deletion row or the wallet
   * ends by calling it, so a lost answer, a late provider call or a request
   * that stopped halfway is put right by the next call, not by a patch per
   * path.
   *
   * It reads the person's row and drives the provider to match it:
   *   freezing, scheduled, purging, purged   frozen
   *   cancelled                              unfrozen
   *   no row                                 unfrozen, but only the wallet
   *                                          the caller names (`named`): a
   *                                          caller that froze it and then
   *                                          dropped its own row. With no
   *                                          row and no name nothing is
   *                                          asked (a wallet WAWU did not
   *                                          freeze is not WAWU's to free).
   * The wallets are the row's (`walletId`), the one named, and the person's
   * CURRENT wallet, looked up now (round 6: one opened after the request is
   * frozen too), and only a wallet of the provider this server runs is asked
   * (R-39, `holdsWalletOf`).
   *
   * Nothing is held while the provider answers (round 6; lead's rule: never a
   * transaction, a pooled connection or a lock across a network call). It
   * reads the row (a short read), calls the provider, and reads the row
   * again. If the state it acted on changed meanwhile it acts again, at most
   * RECONCILE_ROUNDS times; a row that is still changing after that is left
   * for the hourly pass (`failed: true`, so nobody is told it is settled).
   * Freeze and unfreeze are idempotent, so calls for one person may overlap:
   * each call ends only after a read of the row that agrees with what it
   * last did, and a request that changes the row calls this after its change,
   * so the last call always sees the last change.
   *
   * It never throws. A provider that does not answer is `failed: true` and
   * the row stays as it is, so the hourly sweep (every row in force, and
   * every cancelled row until one reconcile was confirmed) or the next
   * request asks again. The one write besides the sync mark: with no row, a
   * wallet that could not be confirmed unfrozen gets a `freezing` row, so
   * there is something to find and retry.
   *
   * `done` is true only when the provider confirmed the wanted state in this
   * call (false: it could not freeze or unfreeze at all, or it failed). On a
   * cancelled row a confirmation sets `walletSyncedAt` (once the cancel is
   * older than FREEZING_STALE_MS), which keeps the hourly pass from asking the
   * provider about it again; anything that could not be confirmed clears it.
   */
  async reconcileWallet(
    wawuUserId: string,
    named?: { walletId: string; provider: string | null } | null,
  ): Promise<ReconcileOutcome> {
    let want: ReconcileOutcome['want'] = null;
    // The wallets this call has asked the provider about (round 7, verifier
    // R6-1): carried into every later round as if the caller had named them. A
    // freeze sent under a row can land after the row changed, so the round
    // that follows must still be able to undo it when no row is left to name
    // the wallet.
    const acted = new Map<
      string,
      { walletId: string; provider: string | null }
    >();
    const namedNow = () => [...(named ? [named] : []), ...acted.values()];
    try {
      for (let round = 1; round <= RECONCILE_ROUNDS; round++) {
        const plan = await this.planFor(wawuUserId, namedNow());
        want = plan.want;
        if (plan.wallets.length === 0) {
          // Nothing this server may act on. A cancelled row with no wallet to
          // free is as settled as it will ever be; one whose wallet belongs to
          // another provider is left for the server that runs it.
          if (plan.status === 'cancelled' && !plan.foreign) {
            await this.markSynced(wawuUserId, plan);
          }
          return { want, done: false, failed: false };
        }
        let done = true;
        let failure: Error | null = null;
        for (const wallet of plan.wallets) {
          acted.set(wallet.walletId, wallet);
          try {
            const o =
              plan.want === 'frozen'
                ? await this.freeze(wallet.walletId)
                : await this.unfreeze(wallet.walletId);
            if (!o.done) done = false;
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            done = false;
            break;
          }
        }
        const after = await this.planFor(wawuUserId, namedNow());
        if (!sameWork(plan, after)) continue; // the row changed meanwhile: act on it as it is now
        if (failure) {
          this.logger.error(
            `The wallet of ${wawuUserId} could not be ${plan.want === 'frozen' ? 'frozen' : 'unfrozen'} to match its deletion (${failure.message}); the hourly pass asks again`,
          );
          await this.keepOwed(wawuUserId, plan, namedNow()[0] ?? null);
          return { want, done: false, failed: true };
        }
        if (done && plan.status === 'cancelled') {
          // Marked only once the cancel is old enough that a call of the
          // deletion it cancelled cannot still be on its way (a freeze that
          // lands after this unfreeze would otherwise stay for good). A
          // younger cancel is confirmed again by the first hourly pass after
          // FREEZING_STALE_MS, which is one provider call more, once.
          if (isSettled(plan)) await this.markSynced(wawuUserId, plan);
        } else if (plan.status === 'cancelled') {
          await this.clearSynced(wawuUserId);
        }
        return { want, done, failed: false };
      }
      this.logger.warn(
        `The deletion of ${wawuUserId} kept changing while its wallet was being matched to it; the hourly pass asks again`,
      );
      await this.clearSynced(wawuUserId);
      return { want, done: false, failed: true };
    } catch (error) {
      this.logger.error(
        `Could not reconcile the wallet of ${wawuUserId} with its deletion: ${(error as Error).message}`,
      );
      return { want, done: false, failed: true };
    }
  }

  /**
   * What the person's deletion row asks of which wallets, read now (two short
   * reads, nothing held afterwards).
   */
  private async planFor(
    wawuUserId: string,
    named: { walletId: string; provider: string | null }[],
  ): Promise<ReconcilePlan> {
    const [row, current] = await Promise.all([
      this.prisma.accountDeletion.findUnique({
        where: { wawuUserId },
        select: {
          status: true,
          walletId: true,
          walletProvider: true,
          cancelledAt: true,
        },
      }),
      this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId },
        select: { walletId: true, provider: true },
      }),
    ]);
    const known = new Map<
      string,
      { walletId: string; provider: string | null }
    >();
    const add = (w: { walletId: string; provider: string | null } | null) => {
      if (w && !known.has(w.walletId)) known.set(w.walletId, w);
    };
    if (row) {
      if (row.walletId) {
        add({ walletId: row.walletId, provider: row.walletProvider });
      }
      for (const n of named) add(n);
      add(current);
    } else {
      // No row: only the wallets the caller froze (or this reconcile asked
      // about, round 7) are let go, never the person's own wallet that nobody
      // here froze.
      for (const n of named) add(n);
    }
    const all = [...known.values()];
    const wallets = all.filter((w) => this.holdsWalletOf(w.provider));
    const foreign = all.length > 0 && wallets.length === 0;
    if (foreign) {
      this.logger.warn(
        `deletion: the wallet of ${wawuUserId} is held by another provider than ${this.provider.label}; not asked`,
      );
    }
    let want: ReconcilePlan['want'] = null;
    if (wallets.length > 0) {
      if (row) want = row.status === 'cancelled' ? 'unfrozen' : 'frozen';
      else if (named.length > 0) want = 'unfrozen';
    }
    return {
      want,
      wallets: want ? wallets : [],
      status: row?.status ?? null,
      cancelledAt: row?.cancelledAt ?? null,
      foreign,
    };
  }

  /** A reconcile of this cancelled row was confirmed: the hourly pass leaves it alone. */
  private async markSynced(
    wawuUserId: string,
    plan: ReconcilePlan,
  ): Promise<void> {
    try {
      await this.prisma.accountDeletion.updateMany({
        where: {
          wawuUserId,
          status: 'cancelled',
          cancelledAt: plan.cancelledAt,
          walletSyncedAt: null,
        },
        data: { walletSyncedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `Could not mark the wallet of ${wawuUserId} as matched: ${(error as Error).message}`,
      );
    }
  }

  /** A reconcile of a cancelled row was not confirmed: the hourly pass looks at it again. */
  private async clearSynced(wawuUserId: string): Promise<void> {
    try {
      await this.prisma.accountDeletion.updateMany({
        where: {
          wawuUserId,
          status: 'cancelled',
          walletSyncedAt: { not: null },
        },
        data: { walletSyncedAt: null },
      });
    } catch (error) {
      this.logger.error(
        `Could not mark the wallet of ${wawuUserId} as owed a check: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The provider did not take the change, so something must find it again:
   * a cancelled row is marked as owing a check, and with no row at all a
   * wallet that may still be frozen gets a `freezing` row (frozen is what
   * that row asks of it, and the sweep lets it go once the row is stale).
   */
  private async keepOwed(
    wawuUserId: string,
    plan: ReconcilePlan,
    named: { walletId: string; provider: string | null } | null,
  ): Promise<void> {
    if (plan.status === 'cancelled') {
      await this.clearSynced(wawuUserId);
      return;
    }
    if (plan.status !== null || !named) return;
    try {
      await this.prisma.accountDeletion.createMany({
        data: {
          wawuUserId,
          status: 'freezing',
          scheduledAt: new Date(),
          purgeAfter: new Date(Date.now() + DELETION_GRACE_MS),
          walletId: named.walletId,
          walletProvider: named.provider,
        },
        skipDuplicates: true,
      });
    } catch (error) {
      this.logger.error(
        `Could not record the stranded wallet of ${wawuUserId}: ${(error as Error).message}`,
      );
    }
  }

  /** Freezes the wallet: it can neither send nor receive. Idempotent. */
  async freeze(walletId: string): Promise<FreezeOutcome> {
    if (!this.provider.freezeWallet) return { done: false };
    try {
      const state = await this.provider.freezeWallet(
        { walletId },
        'Account deletion scheduled',
      );
      if (!state.frozen) throw this.unreachable();
      return { done: true };
    } catch (e) {
      if (e instanceof WalletProviderError) throw this.unreachable();
      throw e;
    }
  }

  /** Lets the wallet send and receive again. Idempotent. */
  async unfreeze(walletId: string): Promise<FreezeOutcome> {
    if (!this.provider.unfreezeWallet) return { done: false };
    try {
      const state = await this.provider.unfreezeWallet({ walletId });
      if (state.frozen) throw this.unreachable();
      return { done: true };
    } catch (e) {
      if (e instanceof WalletProviderError) throw this.unreachable();
      throw e;
    }
  }

  private unreachable(): MoneyError {
    return new MoneyError(
      'provider_unreachable',
      DELETION_BLOCKED_MESSAGES.unreachable,
      {
        retryAfterSeconds: this.provider.timings.retryAfterSeconds,
      },
    );
  }
}
