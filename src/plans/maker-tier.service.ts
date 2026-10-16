import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  PLANS_CONFIG,
  tierById,
  type PlanEventPass,
  type PlanTier,
  type PlansConfig,
} from './plans-config';
import type { MyTierState } from './plans-view.type';

/** A day, in milliseconds. */
const DAY_MS = 86_400_000;

/** The tier a person holds, read once, for the routes and the gate. */
export interface HeldTier {
  state: MyTierState;
  /** The stored tier id; null with no tier. */
  tierId: string | null;
  /** The tier as the config names it now; null with no tier, or when the config no longer has it. */
  tier: PlanTier | null;
  activeFrom: Date | null;
  activeUntil: Date | null;
  /** What the tier gave when it was bought. */
  productsIncluded: number;
  extraProducts: number;
  /** `productsIncluded` plus `extraProducts`. */
  productsAllowed: number;
  pointsIncluded: number;
  voiceIntroIncluded: boolean;
  /** The highest event pass the person holds, by the config's order. */
  eventPass: PlanEventPass | null;
}

/**
 * A tier's state at `now`: `ended` once `activeUntil` has passed, `ending`
 * when it ends within `endingDays` days, else `active`.
 */
export function tierStateAt(
  activeUntil: Date,
  now: Date,
  endingDays: number,
): Exclude<MyTierState, 'none'> {
  const left = activeUntil.getTime() - now.getTime();
  if (left <= 0) return 'ended';
  if (left <= endingDays * DAY_MS) return 'ending';
  return 'active';
}

/**
 * The one reader of a person's tier (TIER-01): GET /me/tier, the publishing
 * gate (TIER-02) and the purchases (TIER-03, TIER-04) all ask here, so they
 * cannot disagree about whether a tier is active or how many products it
 * allows. Reads WAWU's own tables only; never the provider.
 *
 * Only ever the person asked about: every query is keyed on their id.
 */
@Injectable()
export class MakerTierService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
  ) {}

  async tierOf(wawuUserId: string, now: Date = new Date()): Promise<HeldTier> {
    const [row, passes] = await Promise.all([
      this.prisma.makerTier.findUnique({ where: { wawuUserId } }),
      this.prisma.eventPass.findMany({
        where: { wawuUserId },
        select: { type: true, createdAt: true },
      }),
    ]);
    const eventPass = this.bestPass(passes);
    if (!row) {
      return {
        state: 'none',
        tierId: null,
        tier: null,
        activeFrom: null,
        activeUntil: null,
        productsIncluded: 0,
        extraProducts: 0,
        productsAllowed: 0,
        pointsIncluded: 0,
        voiceIntroIncluded: false,
        eventPass,
      };
    }
    return {
      state: tierStateAt(row.activeUntil, now, this.config.tierEndingDays),
      tierId: row.tierId,
      tier: tierById(this.config, row.tierId),
      activeFrom: row.activeFrom,
      activeUntil: row.activeUntil,
      productsIncluded: row.productsIncluded,
      extraProducts: row.extraProducts,
      productsAllowed: row.productsIncluded + row.extraProducts,
      pointsIncluded: row.pointsIncluded,
      voiceIntroIncluded: row.voiceIntroIncluded,
      eventPass,
    };
  }

  /** True while the person's tier lets them publish (`active` or `ending`). */
  async hasActiveTier(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const row = await this.prisma.makerTier.findUnique({
      where: { wawuUserId },
      select: { activeUntil: true },
    });
    return (
      row !== null &&
      tierStateAt(row.activeUntil, now, this.config.tierEndingDays) !== 'ended'
    );
  }

  /** The pass the config ranks highest; the newest of equals. A type the config no longer names is not shown. */
  private bestPass(
    passes: { type: string; createdAt: Date }[],
  ): PlanEventPass | null {
    const ranked = this.config.eventPasses;
    let best: { pass: PlanEventPass; rank: number; at: number } | null = null;
    for (const p of passes) {
      const rank = ranked.findIndex((e) => e.id === p.type);
      if (rank < 0) continue;
      const at = p.createdAt.getTime();
      if (!best || rank > best.rank || (rank === best.rank && at > best.at))
        best = { pass: ranked[rank], rank, at };
    }
    return best?.pass ?? null;
  }
}
