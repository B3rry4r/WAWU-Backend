import { loadPlansConfig } from '../plans-config';
import { MakerTierService } from '../maker-tier.service';
import { PublishingAllowanceService } from '../publishing-allowance.service';
import { PublishingGate } from '../publishing-gate.service';

/**
 * The publishing gate over a hand-made world, for the unit specs of the
 * services that call it (TIER-02). It is the REAL allowance service and gate
 * (not stubs), reading three small fakes, so a spec about storage or about
 * the content service asks the same question the server asks.
 */
export interface PublishingWorld {
  /** A stored tier; absent means the person never had one. */
  tier?: {
    tierId?: string;
    /** Days from now the tier ends; negative for one that has ended. */
    endsInDays: number;
    productsIncluded: number;
    extraProducts?: number;
  };
  /**
   * `true`: a creator tick that does not end. `'lapsed'`: one that ended last
   * year, which holdsTick must not count.
   */
  tick?: boolean | 'lapsed';
  /**
   * CreatorState.slotsUsed; absent means no CreatorState row. A function is
   * read at each question, for a spec whose double counts as it goes.
   */
  slotsUsed?: number | (() => number | undefined);
}

const DAY = 86_400_000;

const NO_TICK = {
  creatorVerifiedAt: null,
  creatorVerifiedUntil: null,
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};
const LAPSED = {
  creatorVerifiedAt: new Date('2024-01-01T00:00:00Z'),
  creatorVerifiedUntil: new Date('2025-01-01T00:00:00Z'),
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};
const TICKED = {
  creatorVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  creatorVerifiedUntil: new Date('2099-01-01T00:00:00Z'),
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};

/** The three tables the allowance reads, as `findMany` fakes for `who`. */
export function publishingTables(world: PublishingWorld, who = 'creator-1') {
  return {
    makerTier: {
      findMany: () =>
        Promise.resolve(
          world.tier
            ? [
                {
                  wawuUserId: who,
                  tierId: world.tier.tierId ?? 'verify',
                  activeUntil: new Date(
                    Date.now() + world.tier.endsInDays * DAY,
                  ),
                  productsIncluded: world.tier.productsIncluded,
                  extraProducts: world.tier.extraProducts ?? 0,
                },
              ]
            : [],
        ),
    },
    userProfile: {
      findMany: () =>
        Promise.resolve([
          {
            wawuUserId: who,
            ...(world.tick === 'lapsed'
              ? LAPSED
              : world.tick
                ? TICKED
                : NO_TICK),
          },
        ]),
    },
    creatorState: {
      findMany: () => {
        const used =
          typeof world.slotsUsed === 'function'
            ? world.slotsUsed()
            : world.slotsUsed;
        return Promise.resolve(
          used === undefined ? [] : [{ wawuUserId: who, slotsUsed: used }],
        );
      },
    },
  };
}

/** The real allowance service and gate over `prisma` (which must carry the three tables above). */
export function publishingOver(prisma: unknown): {
  allowance: PublishingAllowanceService;
  gate: PublishingGate;
} {
  const tiers = new MakerTierService(prisma as never, loadPlansConfig());
  const allowance = new PublishingAllowanceService(prisma as never, tiers);
  return { allowance, gate: new PublishingGate(allowance) };
}
