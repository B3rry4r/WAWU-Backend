import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { rowsOf } from '../../wallet-provider/provider-rows';
import {
  type ProviderAccountLimits,
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { WalletLimitsView } from '../money-view.type';
import { lagosDayStart, lagosNextDayStart } from './lagos-window';
import { accountLimitReached } from './limit-reached';

type Db = PrismaService | Prisma.TransactionClient;

/** The account's daily limit as last read from the wallet provider. */
export interface StoredAccountLimit {
  /** The provider's own name for the account's level. Ops only; never sent to the app. */
  tier: string | null;
  /** Kobo; null when the provider named no limit. */
  dailyKobo: bigint | null;
  /** When the provider last said it. */
  readAt: Date | null;
}

/**
 * Every kind of movement out of a person's wallet. The provider's daily limit
 * is one limit for the wallet, whatever the money is for (a send, a purchase,
 * a held payment or a bill; docs/fintava/limits.md), so it counts all of
 * them together. WAWU's own limits are per kind (money-limits.service.ts).
 */
const COUNTED_CATEGORIES = ['transfer', 'purchase', 'hold', 'bill'] as const;

/**
 * The wallet provider's limit on the account (task WALLET-23).
 *
 * The provider says it with every balance read (`ProviderBalance.accountLimits`;
 * Fintava reports the wallet's tier there, and the tier has a daily limit
 * from a setting, src/fintava/fintava-account-limits.ts). This service:
 *
 *   - keeps what the last read said on the wallet row (`record`, called by
 *     every balance read, and a payment reads the balance right before its
 *     check), so a check or the W35 row never waits on the provider;
 *   - refuses a movement that would pass it, with the limit shown, before
 *     anything is sent (`assertWithin`, called by MoneyLimits);
 *   - answers W35's limits row (`view`) from the same copy.
 *
 * It is a copy for an early, friendly refusal. The provider enforces its own
 * limit whatever this says, and a provider that names none (Nuvion) leaves
 * every figure null, so nothing here is added for it. What counts toward the
 * day is what this person moved out of their wallet today in Lagos, pending
 * or completed, by amount before fees, read from the ledger: a count of what
 * was moved, never a balance (the balance is the provider's).
 */
@Injectable()
export class AccountLimits {
  private readonly logger = new Logger(AccountLimits.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  /**
   * Keeps what a balance read said about the limit. Nothing is written when
   * the provider's answer carried none (it names no limit). Never throws: a
   * balance must still be shown when this copy cannot be written.
   */
  async record(
    wawuUserId: string,
    limits: ProviderAccountLimits | undefined,
    now: Date = new Date(),
  ): Promise<void> {
    if (limits === undefined) return;
    try {
      await this.prisma.fintavaWallet.updateMany({
        where: { AND: [{ wawuUserId }, rowsOf(this.provider.name)] },
        data: {
          accountTier: limits.tier,
          dailyLimitKobo: limits.dailyKobo,
          limitsReadAt: now,
        },
      });
    } catch (e) {
      this.logger.warn(
        `account limit: could not keep the last read (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** The copy on the wallet row, or null for no wallet of the running provider. */
  async stored(
    wawuUserId: string,
    db: Db = this.prisma,
  ): Promise<StoredAccountLimit | null> {
    const row = await db.fintavaWallet.findFirst({
      where: { AND: [{ wawuUserId }, rowsOf(this.provider.name)] },
      select: {
        accountTier: true,
        dailyLimitKobo: true,
        limitsReadAt: true,
      },
    });
    return row
      ? {
          tier: row.accountTier,
          dailyKobo: row.dailyLimitKobo,
          readAt: row.limitsReadAt,
        }
      : null;
  }

  /**
   * What this person moved out of their wallet today (Lagos), of every kind,
   * pending or completed, before fees, in kobo.
   */
  async movedToday(
    db: Db,
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<bigint> {
    const sum = await db.fintavaLedgerEntry.aggregate({
      _sum: { amountKobo: true },
      where: {
        walletKind: 'user',
        wawuUserId,
        direction: 'out',
        status: { in: ['pending', 'completed'] },
        category: { in: [...COUNTED_CATEGORIES] },
        occurredAt: { gte: lagosDayStart(now) },
      },
    });
    return sum._sum.amountKobo ?? 0n;
  }

  /**
   * Refuses (`403 limit_reached`, `limit: daily`, with the limit and what is
   * left of it) a movement that would take the day past `limitKobo`, the
   * provider's limit on file. Call it where MoneyLimits holds the person's
   * lock, so two movements are counted one after the other.
   */
  async assertWithin(
    db: Db,
    wawuUserId: string,
    amountKobo: bigint,
    limitKobo: bigint,
    now: Date = new Date(),
  ): Promise<void> {
    const used = await this.movedToday(db, wawuUserId, now);
    if (used + amountKobo > limitKobo) {
      throw accountLimitReached(
        safeKoboNumber(limitKobo),
        safeKoboNumber(used >= limitKobo ? 0n : limitKobo - used),
      );
    }
  }

  /**
   * What is left of the provider's limit today, for a quote to show beside
   * WAWU's own; null when no limit is known.
   */
  async remainingToday(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<bigint | null> {
    const stored = await this.stored(wawuUserId);
    if (stored === null || stored.dailyKobo === null) return null;
    const used = await this.movedToday(this.prisma, wawuUserId, now);
    return used >= stored.dailyKobo ? 0n : stored.dailyKobo - used;
  }

  /**
   * W35's limits row: the limit, what was used today, what is left, and when
   * it starts again. Null (the row is hidden) when no limit is known. It
   * reads only what is on file and never calls the provider, so
   * `GET /money/wallet` answers when the provider does not. It names no
   * tier (BRIEF W35): `tier` is null.
   */
  async view(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<WalletLimitsView | null> {
    const stored = await this.stored(wawuUserId);
    if (stored === null || stored.dailyKobo === null) return null;
    const used = await this.movedToday(this.prisma, wawuUserId, now);
    const left = used >= stored.dailyKobo ? 0n : stored.dailyKobo - used;
    return {
      tier: null,
      dailyLimitKobo: safeKoboNumber(stored.dailyKobo),
      usedTodayKobo: safeKoboNumber(used),
      remainingTodayKobo: safeKoboNumber(left),
      resetsAt: lagosNextDayStart(now).toISOString(),
    };
  }
}
