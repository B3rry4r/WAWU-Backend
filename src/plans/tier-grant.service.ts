import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PointsService } from '../points/points.service';
import { PLANS_CONFIG, tierById, type PlansConfig } from './plans-config';
import { ensureBadgeNumber } from './tier-badge/badge-number';

type Tx = Prisma.TransactionClient;

/** A day, in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Thrown when a grant no longer fits what the person holds: an upgrade from
 * a tier they no longer have, or to a tier that is not bigger. Nothing is
 * written. Its own class (and `name`) so the payment sweep's log says what it
 * was; it is never shown to a person.
 */
export class TierGrantRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TierGrantRefusal';
  }
}

/**
 * Takes the one lock that serialises a person's tier: held until the caller's
 * transaction ends, and re-entrant, so a purchase may take it first, read
 * what the person holds, and then call `grant` or `upgrade`, which take it
 * again.
 */
export async function lockPersonTier(
  tx: Tx,
  wawuUserId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tier:${wawuUserId}`}, 0))`;
}

export interface TierGrantInput {
  wawuUserId: string;
  /** A tier in `plans.config.json`. */
  tierId: string;
  /**
   * The granting task's own reference for this grant: a purchase's payment
   * reference (TIER-03) or `join:<registration id>` (JOIN-03). It is the
   * event pass's `purchaseRef` and the bonus lot's `sourceRef`, both unique,
   * so the same reference grants once however often it is asked.
   */
  sourceRef: string;
  /** How many days to give. Omitted means the tier's own days. */
  days?: number;
  /** The moment to act as of (tests). */
  now?: Date;
}

export interface TierUpgradeInput {
  wawuUserId: string;
  /** The tier the person must hold, still running, for the upgrade to apply. */
  fromTierId: string;
  /** The bigger tier they move to. */
  tierId: string;
  /** The purchase's payment reference, as for `grant`. */
  sourceRef: string;
  /** The moment to act as of (tests). */
  now?: Date;
}

export interface TierGrantOutcome {
  /** False when this reference had already granted: nothing was written. */
  granted: boolean;
  /** The tier the person holds after the grant. */
  tierId: string;
  /** True when the person held a tier that had not ended and its end moved. */
  extended: boolean;
  activeFrom: Date;
  activeUntil: Date;
  /** The days this grant gave. */
  daysAdded: number;
  /** Bonus points added as one lot; 0 when the tier has none or the grant was a repeat. */
  pointsGranted: number;
  /** When the bonus lot ends; null when no lot was added. */
  pointsExpireAt: Date | null;
}

/**
 * THE one place a tier is granted to a person (TIER-01's tables, written
 * once here): the tier and its dates on `MakerTier`, the event pass on
 * `EventPass`, the bonus points as one lot through POINTS-01's own `grant`,
 * and the first Voice Intro flag. TIER-03's purchase and JOIN-03's claim both
 * call it, inside their own transaction, so there is no second way to grant a
 * plan and the two cannot disagree about what a tier gives.
 *
 * What a tier gives is read from the checked config and COPIED onto the row
 * (`productsIncluded`, `pointsIncluded`), so a later change to the config
 * never takes away what was granted.
 *
 * Rules (Default (agent), owner may override; TIER-03's purchase rules for
 * renewing, upgrading and refusing a downgrade sit on top of these):
 *  - A person with no tier, or whose tier ended, gets this tier from `now`
 *    for `days` days: the period always starts at the moment of
 *    the grant, never at a date after it.
 *  - A person whose tier has not ended keeps it, whichever tier it is: the
 *    days are added to its current end. Nothing here upgrades or downgrades;
 *    that is a purchase's decision.
 *  - The points are added last, as POINTS-01 asks of every caller, and the
 *    caller's transaction must be READ COMMITTED (Prisma's default).
 *
 * One person's tier is written one grant at a time: a transaction advisory
 * lock on `tier:<wawuUserId>`, released when the caller's transaction ends.
 */
@Injectable()
export class TierGrantService {
  constructor(
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly points: PointsService,
  ) {}

  async grant(tx: Tx, input: TierGrantInput): Promise<TierGrantOutcome> {
    const now = input.now ?? new Date();
    const tier = tierById(this.config, input.tierId);
    if (tier === null)
      throw new Error(`The plans file names no tier "${input.tierId}".`);
    const days = input.days ?? tier.days;
    if (!Number.isSafeInteger(days) || days < 1)
      throw new Error('A grant gives a whole number of days, at least one.');

    await lockPersonTier(tx, input.wawuUserId);

    // The pass is the anchor: its reference is unique, so a grant asked for
    // twice finds its own pass the second time and writes nothing more.
    const { count } = await tx.eventPass.createMany({
      data: [
        {
          wawuUserId: input.wawuUserId,
          type: tier.eventPass,
          purchaseRef: input.sourceRef,
        },
      ],
      skipDuplicates: true,
    });
    const held = await tx.makerTier.findUnique({
      where: { wawuUserId: input.wawuUserId },
    });
    if (count === 0) {
      if (held === null)
        throw new Error(
          'This reference granted a pass but the person has no tier.',
        );
      return {
        granted: false,
        tierId: held.tierId,
        extended: false,
        activeFrom: held.activeFrom,
        activeUntil: held.activeUntil,
        daysAdded: 0,
        pointsGranted: 0,
        pointsExpireAt: null,
      };
    }

    const runs = held !== null && held.activeUntil.getTime() > now.getTime();
    let outcome: Pick<
      TierGrantOutcome,
      'tierId' | 'extended' | 'activeFrom' | 'activeUntil'
    >;
    if (held !== null && runs) {
      const activeUntil = new Date(held.activeUntil.getTime() + days * DAY_MS);
      assertDate(activeUntil);
      await tx.makerTier.update({
        where: { wawuUserId: input.wawuUserId },
        data: { activeUntil },
      });
      outcome = {
        tierId: held.tierId,
        extended: true,
        activeFrom: held.activeFrom,
        activeUntil,
      };
    } else {
      const activeUntil = new Date(now.getTime() + days * DAY_MS);
      assertDate(activeUntil);
      const data = {
        tierId: tier.id,
        activeFrom: now,
        activeUntil,
        productsIncluded: tier.products,
        pointsIncluded: tier.bonusPoints,
        voiceIntroIncluded: tier.firstVoiceIntro,
      };
      if (held === null)
        await tx.makerTier.create({
          data: { wawuUserId: input.wawuUserId, ...data },
        });
      else
        await tx.makerTier.update({
          where: { wawuUserId: input.wawuUserId },
          data,
        });
      outcome = {
        tierId: tier.id,
        extended: false,
        activeFrom: now,
        activeUntil,
      };
    }

    let pointsGranted = 0;
    let pointsExpireAt: Date | null = null;
    if (tier.bonusPoints > 0) {
      const lot = await this.points.grant(
        {
          wawuUserId: input.wawuUserId,
          source: 'tier_bonus',
          sourceRef: input.sourceRef,
          points: tier.bonusPoints,
          expiresAt: new Date(now.getTime() + tier.bonusExpiryDays * DAY_MS),
        },
        { tx, now },
      );
      if (lot.granted) {
        pointsGranted = lot.points;
        pointsExpireAt = lot.expiresAt;
      }
    }
    // A numbered badge's number is taken after the points (TIER-07): the
    // points lock is this person's alone, the counter's row is every buyer's,
    // so it is the one to hold for the shortest time. A renewal of a numbered
    // tier whose holder has none yet (held before numbers existed) gets one
    // here too.
    if (tierById(this.config, outcome.tierId)?.badge.numbered === true)
      await ensureBadgeNumber(tx, input.wawuUserId);
    return {
      granted: true,
      ...outcome,
      daysAdded: days,
      pointsGranted,
      pointsExpireAt,
    };
  }

  /**
   * An upgrade (TIER-03): the person's running tier becomes a bigger one,
   * starting now (never at a later date) for the new tier's own days. Unused
   * points stay where they are. What the new tier gives is copied onto the
   * row, and the points it adds are the DIFFERENCE between the two tiers'
   * bonuses (the person already holds the smaller one's lot), as one lot with
   * the new tier's expiry. The event pass is the new tier's. The extra
   * products bought on top are kept.
   *
   * Same rules as `grant`: inside the caller's transaction (READ COMMITTED),
   * one person at a time, a reference grants once, points last. It applies
   * only to a person who still holds `fromTierId` and whose tier has not
   * ended; otherwise it throws `TierGrantRefusal` and writes nothing. Whether
   * the new tier is the bigger one is the purchase's rule (its price), not
   * this method's: it adds nothing when the new bonus is not larger.
   */
  async upgrade(tx: Tx, input: TierUpgradeInput): Promise<TierGrantOutcome> {
    const now = input.now ?? new Date();
    const tier = tierById(this.config, input.tierId);
    if (tier === null)
      throw new Error(`The plans file names no tier "${input.tierId}".`);

    await lockPersonTier(tx, input.wawuUserId);

    const { count } = await tx.eventPass.createMany({
      data: [
        {
          wawuUserId: input.wawuUserId,
          type: tier.eventPass,
          purchaseRef: input.sourceRef,
        },
      ],
      skipDuplicates: true,
    });
    const held = await tx.makerTier.findUnique({
      where: { wawuUserId: input.wawuUserId },
    });
    if (count === 0) {
      if (held === null)
        throw new Error(
          'This reference granted a pass but the person has no tier.',
        );
      return {
        granted: false,
        tierId: held.tierId,
        extended: false,
        activeFrom: held.activeFrom,
        activeUntil: held.activeUntil,
        daysAdded: 0,
        pointsGranted: 0,
        pointsExpireAt: null,
      };
    }
    if (
      held === null ||
      held.tierId !== input.fromTierId ||
      held.activeUntil.getTime() <= now.getTime()
    )
      throw new TierGrantRefusal(
        'The person no longer holds the tier this upgrade was bought from.',
      );
    if (held.tierId === tier.id)
      throw new TierGrantRefusal('An upgrade moves to a different tier.');

    const activeUntil = new Date(now.getTime() + tier.days * DAY_MS);
    assertDate(activeUntil);
    await tx.makerTier.update({
      where: { wawuUserId: input.wawuUserId },
      data: {
        tierId: tier.id,
        activeFrom: now,
        activeUntil,
        productsIncluded: tier.products,
        pointsIncluded: tier.bonusPoints,
        voiceIntroIncluded: held.voiceIntroIncluded || tier.firstVoiceIntro,
      },
    });

    const extra = Math.max(0, tier.bonusPoints - held.pointsIncluded);
    let pointsGranted = 0;
    let pointsExpireAt: Date | null = null;
    if (extra > 0) {
      const lot = await this.points.grant(
        {
          wawuUserId: input.wawuUserId,
          source: 'tier_bonus',
          sourceRef: input.sourceRef,
          points: extra,
          expiresAt: new Date(now.getTime() + tier.bonusExpiryDays * DAY_MS),
        },
        { tx, now },
      );
      if (lot.granted) {
        pointsGranted = lot.points;
        pointsExpireAt = lot.expiresAt;
      }
    }
    if (tier.badge.numbered) await ensureBadgeNumber(tx, input.wawuUserId);
    return {
      granted: true,
      tierId: tier.id,
      extended: false,
      activeFrom: now,
      activeUntil,
      daysAdded: tier.days,
      pointsGranted,
      pointsExpireAt,
    };
  }
}

/** A date JavaScript cannot read back is never written. */
function assertDate(d: Date): void {
  if (Number.isNaN(d.getTime()))
    throw new Error(
      'That grant would end after the last date the app can store.',
    );
}
