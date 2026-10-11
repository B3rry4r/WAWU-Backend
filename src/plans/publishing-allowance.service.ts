import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  FREE_STORAGE_BYTES,
  TICK_COLUMNS,
  TICK_STORAGE_BYTES,
  TICK_UPLOADS,
  holdsTick,
} from '../common/creator-allowance';
import { MakerTierService, type HeldTierRow } from './maker-tier.service';
import type { MyTierState } from './plans-view.type';

/**
 * What lets a person publish (TIER-02, R-43): a tier that is running, or, for
 * people who paid for a verification tick before tiers existed, that tick
 * until it ends (docs/PAYMENTS-PLAN.md, owner question 3, default built).
 */
export type PublishingBasis = 'tier' | 'tick' | 'none';

export interface PublishingAllowance {
  basis: PublishingBasis;
  /**
   * Products the person may have published at once. A running tier allows the
   * tier's own products plus any extra products bought; a held tick allows
   * the tick's old cap; with both, whichever is more (the tick is kept, not
   * traded in for fewer). 0 when basis is `none`.
   */
  productsAllowed: number;
  /** Products published now: CreatorState.slotsUsed, 0 with no row. */
  productsUsed: number;
  /** The stored tier's state; `none` with no tier row. */
  tierState: MyTierState;
  /** The tier id of a RUNNING tier (`active` or `ending`); null otherwise. */
  runningTierId: string | null;
  /** The running tier's own product count, extras left out; 0 with none. */
  runningTierProducts: number;
  /** The extra products bought on the running tier; 0 with none. */
  extraProducts: number;
  /** A verification tick (either kind) is held now. */
  tickHeld: boolean;
  /**
   * Bytes of creator content the person may store (R-7's numbers): the
   * with-a-tick figure for anyone who may publish, the free figure for the
   * rest (who can upload nothing anyway). Default (agent), owner may
   * override: a running tier gets the with-a-tick storage, because tiers
   * replace the tick (round 2 brief) and nothing in the plan sizes storage.
   */
  storageBytes: number;
}

/** What the allowance is computed from, per person. */
interface Inputs {
  tier: HeldTierRow | undefined;
  tickColumns: Parameters<typeof holdsTick>[0];
  productsUsed: number;
}

function allowanceFrom(inputs: Inputs, now: Date): PublishingAllowance {
  const { tier } = inputs;
  const running = tier !== undefined && tier.state !== 'ended';
  const tierProducts = running ? tier.productsIncluded : 0;
  const tierAllowed = running ? tier.productsIncluded + tier.extraProducts : 0;
  const tickHeld = holdsTick(inputs.tickColumns, now);
  const tickAllowed = tickHeld ? TICK_UPLOADS : 0;
  const productsAllowed = Math.max(tierAllowed, tickAllowed);
  const basis: PublishingBasis = running
    ? tierAllowed >= tickAllowed
      ? 'tier'
      : 'tick'
    : tickHeld
      ? 'tick'
      : 'none';
  return {
    basis,
    productsAllowed,
    productsUsed: inputs.productsUsed,
    tierState: tier?.state ?? 'none',
    runningTierId: running ? tier.tierId : null,
    runningTierProducts: tierProducts,
    extraProducts: running ? tier.extraProducts : 0,
    tickHeld,
    storageBytes: running || tickHeld ? TICK_STORAGE_BYTES : FREE_STORAGE_BYTES,
  };
}

/**
 * The one place that answers "what may this person publish, and how much have
 * they used" (TIER-02). The publishing gate, the presign for content files,
 * `GET /me/tier` (`productsUsed`), `GET /creator/state` (`slotsTotal`),
 * `GET /uploads/allowance` and the admin screens that show a creator's slots
 * all read it, so no two of them can disagree.
 *
 * Reads WAWU's own tables only (the tier through MakerTierService, the tick
 * through the one function that decides ticks, the count from
 * CreatorState.slotsUsed); never a provider. Keyed on the id it is given and
 * on nothing else.
 */
@Injectable()
export class PublishingAllowanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiers: MakerTierService,
  ) {}

  async of(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<PublishingAllowance> {
    const all = await this.ofMany([wawuUserId], now);
    return all.get(wawuUserId)!;
  }

  /** The same for many people in three queries (the admin lists). */
  async ofMany(
    wawuUserIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, PublishingAllowance>> {
    const ids = [...new Set(wawuUserIds)];
    const [held, profiles, states] = await Promise.all([
      this.tiers.heldRowsOf(ids, now),
      ids.length === 0
        ? Promise.resolve([])
        : this.prisma.userProfile.findMany({
            where: { wawuUserId: { in: ids } },
            select: { wawuUserId: true, ...TICK_COLUMNS },
          }),
      ids.length === 0
        ? Promise.resolve([])
        : this.prisma.creatorState.findMany({
            where: { wawuUserId: { in: ids } },
            select: { wawuUserId: true, slotsUsed: true },
          }),
    ]);
    const profileById = new Map(profiles.map((p) => [p.wawuUserId, p]));
    const usedById = new Map(states.map((s) => [s.wawuUserId, s.slotsUsed]));
    return new Map(
      ids.map((id) => [
        id,
        allowanceFrom(
          {
            tier: held.get(id),
            tickColumns: profileById.get(id) ?? null,
            productsUsed: usedById.get(id) ?? 0,
          },
          now,
        ),
      ]),
    );
  }
}
