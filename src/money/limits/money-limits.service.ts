import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { feesNotSet } from '../fees/fees-not-set';
import { unsetFeeSettings } from '../fees/provider-fee-schedule';
import { lagosDayStart, lagosMonthStart } from './lagos-window';
import { limitReached } from './limit-reached';
import { type MoneyLimitKind, MoneyLimitSettings } from './money-limit-config';
import { assertReadCommitted } from './read-committed';

/** One movement about to be sent to the provider. */
export interface MovementInput {
  /** Whose wallet the money leaves. */
  wawuUserId: string;
  kind: MoneyLimitKind;
  /** What moves, before fees, in kobo: what a limit counts. */
  amountKobo: number;
}

/** Where today's limit stands for a movement, for a quote to show. */
export interface DailyStanding {
  /** False when this movement would pass today's limit. */
  withinDailyLimit: boolean;
  /** What is left of today's limit before this movement; null when no daily limit is set. */
  remainingTodayKobo: number | null;
}

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Which ledger rows are movements of each kind, out of a person's wallet.
 * A send is a `transfer` to a WAWU user or to a bank account; a purchase is
 * a payment into WAWU's account (MONEY-17 writes `purchase`, a held one may
 * be `hold`) for anything but a bill; a bill is a `bill`, or a payment whose
 * link is a bill.
 */
const KIND_WHERE: Record<MoneyLimitKind, Prisma.FintavaLedgerEntryWhereInput> =
  {
    wawu_transfer: { category: 'transfer', counterpartyKind: 'wawu_user' },
    bank_transfer: { category: 'transfer', counterpartyKind: 'bank_account' },
    purchase: {
      category: { in: ['purchase', 'hold'] },
      OR: [{ linkKind: null }, { linkKind: { not: 'bill' } }],
    },
    bill: {
      OR: [
        { category: 'bill' },
        { category: { in: ['purchase', 'hold'] }, linkKind: 'bill' },
      ],
    },
  };

/**
 * WAWU's limits on moving money, and the one check every money-moving
 * service makes right before it sends anything to the provider (task NUV-07):
 *
 *   1. `503 fees_not_set` while any of the running provider's fee settings
 *      is unset (R-42: nothing moves before they are set);
 *   2. `403 limit_reached` with `limit: per_transaction` when the amount is
 *      above the per-transaction limit for its kind;
 *   3. `limit: daily` when what the person moved of that kind today, in
 *      Lagos, plus this amount is above the daily limit;
 *   4. `limit: monthly` the same over the Lagos calendar month.
 *
 * Unset limits are no limit. What counts toward a day or a month is the
 * person's own movements of that kind out of their wallet, pending or
 * completed (a failed or reversed one gave the money back), by amount before
 * fees, read from the ledger. That is a count of what was moved, never a
 * balance: the balance is the provider's.
 *
 * Concurrency: called with the transaction in which the caller writes the
 * movement's pending ledger row, it first takes a per-person lock for that
 * transaction, so two movements by one person are checked one after the
 * other and the second sees the first. That holds only at READ COMMITTED
 * (Prisma's default), so given a transaction it first reads that
 * transaction's isolation level and refuses any other with an
 * IsolationLevelError naming it (task FIX-21, `read-committed.ts`): a
 * programming error, before anything is locked, read or written. Called
 * without one it reads, and two movements at the same instant could each
 * pass.
 *
 * The provider's own limit refusals answer the same `limit_reached`
 * (`WalletProviderLimitError.toHttpException()`,
 * src/wallet-provider/wallet-provider-limit.ts).
 */
@Injectable()
export class MoneyLimits {
  /** The running provider's fee settings still unset, read once at boot. */
  private readonly unsetFees: readonly string[];

  constructor(
    private readonly settings: MoneyLimitSettings,
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) provider: Pick<WalletProvider, 'name'>,
    config: ConfigService,
  ) {
    this.unsetFees = unsetFeeSettings(provider.name, (key) =>
      config.get<string>(key),
    );
  }

  /**
   * Everything that must hold before a movement is sent to the provider:
   * the fees are set, and the movement is within every limit. Throws the
   * refusal; nothing is written and nothing is sent.
   */
  async assertMayMove(
    input: MovementInput,
    opts: { tx?: Prisma.TransactionClient; now?: Date } = {},
  ): Promise<void> {
    if (this.unsetFees.length > 0) throw feesNotSet();
    await this.assertWithinLimits(input, opts);
  }

  /**
   * The limits alone: per transaction, then today, then this month. Given
   * the caller's transaction, its isolation level is checked first, whatever
   * limits are set, so a caller at the wrong level fails in its own specs
   * and not only where a daily or monthly limit happens to be set.
   */
  async assertWithinLimits(
    input: MovementInput,
    opts: { tx?: Prisma.TransactionClient; now?: Date } = {},
  ): Promise<void> {
    if (opts.tx) await assertReadCommitted(opts.tx);
    const amount = this.amountOf(input);
    const { kind } = input;
    const perTransaction = this.settings.limitOf(kind, 'per_transaction');
    if (perTransaction !== null && amount > BigInt(perTransaction)) {
      throw limitReached('per_transaction');
    }
    const daily = this.settings.limitOf(kind, 'daily');
    const monthly = this.settings.limitOf(kind, 'monthly');
    if (daily === null && monthly === null) return;

    const now = opts.now ?? new Date();
    const db: Db = opts.tx ?? this.prisma;
    if (opts.tx) {
      await opts.tx
        .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`money-limits:${input.wawuUserId}`}, 0))`;
    }
    if (daily !== null) {
      const used = await this.movedSince(db, input, lagosDayStart(now));
      if (used + amount > BigInt(daily)) throw limitReached('daily');
    }
    if (monthly !== null) {
      const used = await this.movedSince(db, input, lagosMonthStart(now));
      if (used + amount > BigInt(monthly)) throw limitReached('monthly');
    }
  }

  /**
   * Today's limit for this movement, for a quote or a pay sheet to show
   * before the PIN (`withinDailyLimit`, `remainingTodayKobo`).
   */
  async dailyStanding(
    input: MovementInput,
    now: Date = new Date(),
  ): Promise<DailyStanding> {
    const amount = this.amountOf(input);
    const daily = this.settings.limitOf(input.kind, 'daily');
    if (daily === null) {
      return { withinDailyLimit: true, remainingTodayKobo: null };
    }
    const used = await this.movedSince(this.prisma, input, lagosDayStart(now));
    const left = BigInt(daily) - used;
    return {
      withinDailyLimit: used + amount <= BigInt(daily),
      remainingTodayKobo: left > 0n ? Number(left) : 0,
    };
  }

  /**
   * What this person moved of this kind out of their wallet since `since`,
   * pending or completed, before fees, in kobo.
   */
  async movedSince(
    db: Db,
    input: Pick<MovementInput, 'wawuUserId' | 'kind'>,
    since: Date,
  ): Promise<bigint> {
    const sum = await db.fintavaLedgerEntry.aggregate({
      _sum: { amountKobo: true },
      where: {
        AND: [
          {
            walletKind: 'user',
            wawuUserId: input.wawuUserId,
            direction: 'out',
            status: { in: ['pending', 'completed'] },
            occurredAt: { gte: since },
          },
          KIND_WHERE[input.kind],
        ],
      },
    });
    return sum._sum.amountKobo ?? 0n;
  }

  private amountOf(input: MovementInput): bigint {
    if (!Number.isSafeInteger(input.amountKobo) || input.amountKobo < 1) {
      throw new RangeError('A movement is a whole number of kobo, 1 or more.');
    }
    return BigInt(input.amountKobo);
  }
}
