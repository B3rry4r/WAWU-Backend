import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
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
 *   waiting_earnings     a sale's share has not reached their wallet yet (R-11)
 *   payment_in_progress  a payment of theirs has no final answer yet
 *   cash_out_in_flight   points are held for a cash-out
 *   wallet_opening       their wallet is being opened right now
 */
export const DELETION_BLOCKERS = [
  'wallet_balance',
  'open_hold',
  'waiting_earnings',
  'payment_in_progress',
  'cash_out_in_flight',
  'wallet_opening',
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
  unreachable:
    'We could not reach your account. Your money is safe. Try again in a moment.',
} as const;

/** `409 account_deletion_blocked`: the money to settle first, in the one error shape. */
export class AccountDeletionBlockedError extends HttpException {
  constructor(check: DeletionMoneyCheck) {
    const blockers = check.blockers;
    const message = blockers.includes('wallet_balance')
      ? DELETION_BLOCKED_MESSAGES.balance
      : blockers.every((b) => b === 'wallet_opening')
        ? DELETION_BLOCKED_MESSAGES.opening
        : DELETION_BLOCKED_MESSAGES.onItsWay;
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
    const [openHolds, waitingEarnings, pendingPayments, cashOuts, opening] =
      await Promise.all([
        this.prisma.walletHold.count({
          where: {
            status: 'held',
            OR: [
              { payerWawuUserId: wawuUserId },
              { payeeWawuUserId: wawuUserId },
            ],
          },
        }),
        // A completed sale whose share has not landed: no hold (a held kind is
        // counted above), not refunded, and the payee's share is more than 0.
        this.prisma.walletPayment.count({
          where: {
            status: 'completed',
            payeeWawuUserId: wawuUserId,
            payeeShareKobo: { gt: 0 },
            payeeSettledAt: null,
            hold: { is: null },
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
      ]);

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
    if (pendingPayments > 0) blockers.push('payment_in_progress');
    if (cashOuts > 0) blockers.push('cash_out_in_flight');

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
   * After a wallet was let go (SETTINGS-06 round 4, verifier R3-2): look at
   * the person's deletion row once more. If a deletion is in force by now
   * (`scheduled`, `purging`), or another request is mid-way (`freezing`: it
   * wants the wallet frozen, and lets it go itself if it fails), the unfreeze
   * must not stand, so the wallet is frozen again. `includeFreezing` false:
   * a `freezing` row is the caller's own (kept because its unfreeze failed)
   * and says nothing. `ownRowUpdatedAt`: a row with this `updatedAt` is the
   * caller's own whatever its status. Freezing is idempotent. Never throws:
   * a freeze the provider does not answer is logged, and the repeat request,
   * the purge-time check and the hourly sweep are the net under it.
   * Returns true when it froze.
   */
  async holdIfDeleting(
    wawuUserId: string,
    walletId: string,
    o: { includeFreezing: boolean; ownRowUpdatedAt?: Date },
  ): Promise<boolean> {
    try {
      const row = await this.prisma.accountDeletion.findUnique({
        where: { wawuUserId },
        select: { status: true, updatedAt: true },
      });
      if (!row) return false;
      if (
        o.ownRowUpdatedAt &&
        row.updatedAt.getTime() === o.ownRowUpdatedAt.getTime()
      ) {
        return false;
      }
      const wants =
        row.status === 'scheduled' ||
        row.status === 'purging' ||
        (o.includeFreezing && row.status === 'freezing');
      if (!wants) return false;
      return (await this.freeze(walletId)).done;
    } catch (error) {
      this.logger.error(
        `The wallet of ${wawuUserId} may be unfrozen while its deletion is in force, and could not be frozen again: ${(error as Error).message}`,
      );
      return false;
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
