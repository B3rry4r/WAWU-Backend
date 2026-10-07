import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import {
  TGIF_CARDS,
  type TgifCard,
  type TgifReactionKind,
} from './tgif.constants';

export interface TgifCardStats {
  card: TgifCard;
  /** People who said Amen to this card that day. */
  amen: number;
  /** The caller said Amen to it. */
  amenByMe: boolean;
}

export interface TgifStats {
  /** The day asked for, YYYY-MM-DD. */
  date: string;
  /** All five cards, in reading order, zero where nobody has reacted. */
  cards: TgifCardStats[];
  /** Distinct people who opened TGIF that day. */
  readers: number;
  /** People who shared TGIF that day. */
  shares: number;
  readByMe: boolean;
  sharedByMe: boolean;
}

export interface TgifReactionState {
  card: TgifCard;
  amen: number;
  amenByMe: boolean;
}

export interface TgifReadState {
  readers: number;
  /** False when this open was not new: this person already read that day. */
  counted: boolean;
}

export interface TgifShareState {
  shares: number;
  /** False when this share was not new: this person already shared that day. */
  counted: boolean;
}

/** `YYYY-MM-DD` (already validated by TgifDatePipe) as the DATE column's value. */
const toDay = (date: string) => new Date(`${date}T00:00:00.000Z`);

/**
 * TGIF reactions, readers and shares (HOME-10).
 *
 * Every number is the count of rows for the day; there is no counter to drift.
 * Each write is one `INSERT ... ON CONFLICT DO NOTHING` on a unique key
 * (`createMany` with `skipDuplicates`), so any number of simultaneous taps by
 * one person leave one row.
 *
 * BLOCKS. A count other people feed is shown to the caller without the people
 * hidden from them (the ones they blocked and the ones who blocked them,
 * SETTINGS-04): their reactions, reads and shares are left out of every number
 * this service returns, writes included, so a block cannot be probed by
 * watching a count move. There is no per-person id on any route here, so there
 * is no 404 to differ between hidden and missing; the caller's own rows are
 * never hidden.
 */
@Injectable()
export class TgifService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  private notHidden(hidden: string[]) {
    return hidden.length > 0 ? { userWawuId: { notIn: hidden } } : {};
  }

  private async cardCounts(day: Date, me: string, hidden: string[]) {
    const [groups, mine] = await Promise.all([
      this.prisma.tgifReaction.groupBy({
        by: ['card'],
        where: { day, kind: 'amen', ...this.notHidden(hidden) },
        _count: { _all: true },
      }),
      this.prisma.tgifReaction.findMany({
        where: { day, userWawuId: me, kind: 'amen' },
        select: { card: true },
      }),
    ]);
    const counts = new Map(groups.map((g) => [g.card, g._count._all]));
    const mineSet = new Set(mine.map((m) => m.card));
    return { counts, mineSet };
  }

  async stats(date: string, me: string): Promise<TgifStats> {
    const day = toDay(date);
    const hidden = await this.blockedAccounts.hiddenFrom(me);
    const [{ counts, mineSet }, readers, shares, readByMe, sharedByMe] =
      await Promise.all([
        this.cardCounts(day, me, hidden),
        this.prisma.tgifRead.count({
          where: { day, ...this.notHidden(hidden) },
        }),
        this.prisma.tgifShare.count({
          where: { day, ...this.notHidden(hidden) },
        }),
        this.prisma.tgifRead.count({ where: { day, userWawuId: me } }),
        this.prisma.tgifShare.count({ where: { day, userWawuId: me } }),
      ]);
    return {
      date,
      cards: TGIF_CARDS.map((card) => ({
        card,
        amen: counts.get(card) ?? 0,
        amenByMe: mineSet.has(card),
      })),
      readers,
      shares,
      readByMe: readByMe > 0,
      sharedByMe: sharedByMe > 0,
    };
  }

  private async cardState(
    day: Date,
    card: TgifCard,
    me: string,
  ): Promise<TgifReactionState> {
    const hidden = await this.blockedAccounts.hiddenFrom(me);
    const [amen, mine] = await Promise.all([
      this.prisma.tgifReaction.count({
        where: { day, card, kind: 'amen', ...this.notHidden(hidden) },
      }),
      this.prisma.tgifReaction.count({
        where: { day, card, userWawuId: me, kind: 'amen' },
      }),
    ]);
    return { card, amen, amenByMe: mine > 0 };
  }

  /** POST /tgif/:date/react. Idempotent: reacting twice is one reaction. */
  async react(
    date: string,
    me: string,
    card: TgifCard,
    kind: TgifReactionKind = 'amen',
  ): Promise<TgifReactionState> {
    const day = toDay(date);
    await this.prisma.tgifReaction.createMany({
      data: [{ userWawuId: me, day, card, kind }],
      skipDuplicates: true,
    });
    return this.cardState(day, card, me);
  }

  /** DELETE /tgif/:date/react/:card. Idempotent: no reaction is not an error. */
  async unreact(
    date: string,
    me: string,
    card: TgifCard,
  ): Promise<TgifReactionState> {
    const day = toDay(date);
    await this.prisma.tgifReaction.deleteMany({
      where: { userWawuId: me, day, card },
    });
    return this.cardState(day, card, me);
  }

  /** POST /tgif/:date/read: one reader per person per day. */
  async read(date: string, me: string): Promise<TgifReadState> {
    const day = toDay(date);
    const { count } = await this.prisma.tgifRead.createMany({
      data: [{ userWawuId: me, day }],
      skipDuplicates: true,
    });
    const hidden = await this.blockedAccounts.hiddenFrom(me);
    const readers = await this.prisma.tgifRead.count({
      where: { day, ...this.notHidden(hidden) },
    });
    return { readers, counted: count > 0 };
  }

  /** POST /tgif/:date/share: one share per person per day. */
  async share(date: string, me: string): Promise<TgifShareState> {
    const day = toDay(date);
    const { count } = await this.prisma.tgifShare.createMany({
      data: [{ userWawuId: me, day }],
      skipDuplicates: true,
    });
    const hidden = await this.blockedAccounts.hiddenFrom(me);
    const shares = await this.prisma.tgifShare.count({
      where: { day, ...this.notHidden(hidden) },
    });
    return { shares, counted: count > 0 };
  }
}
