import { Prisma, type PrismaClient } from '../../../generated/prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  EXPIRED_BY_SUPPORT,
  EXPIRED_IDLE,
  EXPIRED_STATE,
  HOLD_ENTITY_SELECT,
  type HoldEntity,
  holdFactsOf,
  isReleasedBvnHash,
  releasedBvnHash,
} from './bvn-claim';
import { NOT_PASSED, numbersFailed, reviewStageOf } from './review-stage';

/**
 * How long an unfinished opening may hold a BVN, and the ways it lets go
 * (NUV-02 round 3, N3; lead ruling "an unfinished opening's hold expires").
 *
 * An opening that sits at "documents needed", or was refused only for its
 * documents or details, with no progress from the person for
 * IDENTITY_HOLD_DAYS (default 14) is marked `expired`: the opening's state
 * becomes `expired`, its BVN claim is let go (`released:<user>:<hash>`), and
 * `NuvionEntity.holdExpiredAt` says when. The person is told once (the
 * `identity_review` notification, outcome `expired`) and starts again with
 * `POST /money/wallet/open`, which corrects the same entity at the provider
 * (nothing is deleted there). The same marking is what support's release of
 * one person's hold does, at once.
 *
 * Progress is the latest of the opening's last claim (first send, a
 * correction, a start again), the last submission, `progressAt` (anything
 * else the person did: NUV-03 calls `recordOpeningProgress` for each
 * document uploaded and for the submit call) and, for a refusal, the day the
 * person was told.
 */

/** One day. */
const DAY_MS = 24 * 60 * 60_000;

/** The advisory lock key of the expiry pass: one pass at a time across servers. */
export const HOLD_SWEEP_LOCK = 'nuvion-identity-hold-expiry';

/** The opening rows the sweep reads at a time. */
export const HOLD_SWEEP_BATCH = 100;

/** The most opening rows one pass looks at (the rest wait for the next pass). */
export const HOLD_SWEEP_MAX_EXAMINED = 500;

/** What the sweep reads of an opening. */
export interface IdleOpening {
  state: string;
  attemptStartedAt: Date;
}

/**
 * Since when an opening has been idle, or null when it cannot expire: it is
 * not at "documents needed" or refused only about documents or details, it
 * has an account (or a wallet), or it has no entity at the provider. Pure.
 */
export function idleSince(
  opening: IdleOpening,
  entity: HoldEntity | null,
  hasWallet: boolean,
): Date | null {
  if (opening.state !== 'review' || entity === null || !entity.entityId) {
    return null;
  }
  const facts = holdFactsOf(opening.state, entity, hasWallet);
  if (facts.hasAccount) return null;
  const stage = reviewStageOf(entity);
  const expirable =
    stage === 'needs_documents' ||
    (stage === 'rejected' && !numbersFailed(entity));
  if (!expirable) return null;
  const times = [
    opening.attemptStartedAt,
    entity.correctedAt,
    entity.submittedAt,
    entity.progressAt,
    // A refusal: the person had nothing to act on before they were told.
    stage === 'rejected' ? entity.decidedAt : null,
  ].filter((t): t is Date => t !== null);
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

/** The client a pass runs on: a transaction of the service. */
export type HoldClient = Pick<
  PrismaClient,
  'fintavaWalletOpening' | 'nuvionEntity' | 'fintavaWallet' | '$queryRaw'
>;

/**
 * Marks one opening expired if it is still as it was read (a conditional
 * update on its attempt and its claim), letting go of its BVN. True when
 * this call did it, so exactly one caller tells the person.
 *
 * Run inside a transaction: the opening's row is locked first (a send or a
 * correction by the person waits for it and then finds the opening expired),
 * and what the person did is read again under the lock. With an
 * `idleCutoff` the opening is expired only if it is still idle since before
 * that time, so a person who moved after the sweep read them is left alone.
 */
export async function expireOpening(
  db: HoldClient,
  wawuUserId: string,
  cause: typeof EXPIRED_IDLE | typeof EXPIRED_BY_SUPPORT,
  now: Date,
  allowedStates: readonly string[] = ['review'],
  idleCutoff: Date | null = null,
): Promise<boolean> {
  await db.$queryRaw`SELECT 1 FROM "FintavaWalletOpening" WHERE "wawuUserId" = ${wawuUserId} FOR UPDATE`;
  const row = await db.fintavaWalletOpening.findUnique({
    where: { wawuUserId },
    select: {
      bvnHash: true,
      provider: true,
      state: true,
      attempts: true,
      attemptStartedAt: true,
    },
  });
  if (!row || row.provider !== 'nuvion' || !allowedStates.includes(row.state)) {
    return false;
  }
  if (idleCutoff !== null) {
    const entity = await db.nuvionEntity.findUnique({
      where: { wawuUserId },
      select: HOLD_ENTITY_SELECT,
    });
    const wallet = await db.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    const since = idleSince(row, entity, wallet !== null);
    if (since === null || since >= idleCutoff) return false;
  }
  const moved = await db.fintavaWalletOpening.updateMany({
    where: {
      wawuUserId,
      provider: 'nuvion',
      state: row.state,
      attempts: row.attempts,
      bvnHash: row.bvnHash,
    },
    data: {
      state: EXPIRED_STATE,
      failure: cause,
      bvnHash: isReleasedBvnHash(row.bvnHash)
        ? row.bvnHash
        : releasedBvnHash(wawuUserId, row.bvnHash),
    },
  });
  if (moved.count !== 1) return false;
  await db.nuvionEntity.updateMany({
    where: { wawuUserId },
    data: { holdExpiredAt: now },
  });
  return true;
}

/** One opening the sweep may expire, as the candidate query reads it. */
interface IdleCandidate {
  wawuUserId: string;
  state: string;
  attemptStartedAt: Date;
}

/**
 * The openings that could have run out, oldest first, after a place in that
 * order: at documents needed or refused (not with the provider reviewing,
 * not with an account or a wallet, not refused on the BVN or the NIN, which
 * hold nothing and would otherwise fill every page for ever), with nothing
 * from the person since before the cutoff. A superset of the openings
 * `idleSince` accepts: it never leaves one out, and `idleSince` decides.
 */
async function idleCandidates(
  db: HoldClient,
  cutoff: Date,
  after: { at: Date; id: string } | null,
): Promise<IdleCandidate[]> {
  const notPassed = Prisma.join([...NOT_PASSED]);
  return db.$queryRaw<IdleCandidate[]>(Prisma.sql`
    SELECT o."wawuUserId", o."state", o."attemptStartedAt"
      FROM "FintavaWalletOpening" o
      JOIN "NuvionEntity" e ON e."wawuUserId" = o."wawuUserId"
     WHERE o."provider" = 'nuvion'
       AND o."state" = 'review'
       AND e."entityId" IS NOT NULL
       AND e."accountId" IS NULL
       AND e."accountRequestedAt" IS NULL
       AND lower(btrim(e."status")) IN ('incomplete', 'rejected')
       AND COALESCE(lower(btrim(e."bvnStatus")), '') NOT IN (${notPassed})
       AND COALESCE(lower(btrim(e."ninStatus")), '') NOT IN (${notPassed})
       AND NOT EXISTS (
         SELECT 1 FROM "FintavaWallet" w WHERE w."wawuUserId" = o."wawuUserId"
       )
       AND GREATEST(
             o."attemptStartedAt", e."correctedAt", e."submittedAt", e."progressAt"
           ) < ${cutoff}
       ${
         after === null
           ? Prisma.empty
           : Prisma.sql`AND (o."attemptStartedAt", o."wawuUserId") > (${after.at}, ${after.id})`
       }
     ORDER BY o."attemptStartedAt" ASC, o."wawuUserId" ASC
     LIMIT ${HOLD_SWEEP_BATCH}
  `);
}

/**
 * The openings whose hold has run out, expired in one pass. Run inside a
 * transaction that holds the pass's advisory lock, so one sweep runs at a
 * time across servers; every opening is still marked by a conditional
 * update, so a second pass finds it done. The people to tell, in order.
 * Pages through the candidates (at most `HOLD_SWEEP_MAX_EXAMINED` a pass), so
 * a page of openings that cannot expire never hides the ones behind it.
 */
export async function expireIdleOpenings(
  db: HoldClient,
  holdDays: number,
  now: Date,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - holdDays * DAY_MS);
  const told: string[] = [];
  let after: { at: Date; id: string } | null = null;
  let examined = 0;
  while (examined < HOLD_SWEEP_MAX_EXAMINED) {
    const page = await idleCandidates(db, cutoff, after);
    for (const c of page) {
      const [entity, wallet] = await Promise.all([
        db.nuvionEntity.findUnique({
          where: { wawuUserId: c.wawuUserId },
          select: HOLD_ENTITY_SELECT,
        }),
        db.fintavaWallet.findUnique({
          where: { wawuUserId: c.wawuUserId },
          select: { wawuUserId: true },
        }),
      ]);
      const since = idleSince(c, entity, wallet !== null);
      if (since === null || since >= cutoff) continue;
      // Read again under the opening's lock: a person who sent, corrected or
      // uploaded since the read above is not expired.
      if (
        await expireOpening(
          db,
          c.wawuUserId,
          EXPIRED_IDLE,
          now,
          ['review'],
          cutoff,
        )
      ) {
        told.push(c.wawuUserId);
      }
    }
    examined += page.length;
    if (page.length < HOLD_SWEEP_BATCH) break;
    const last = page[page.length - 1];
    after = { at: last.attemptStartedAt, id: last.wawuUserId };
  }
  return told;
}

/**
 * NUV-03 calls this for each thing the person does that moves their opening
 * along: a document uploaded (`submitted` false) and the submit call
 * (`submitted` true, which is also a submission for review, so a refusal
 * read after it can be a new decision). It only writes a time on the
 * person's own row, and does nothing when there is none.
 */
export async function recordOpeningProgress(
  prisma: Pick<PrismaService, 'nuvionEntity'>,
  wawuUserId: string,
  opts: { submitted?: boolean; now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  await prisma.nuvionEntity.updateMany({
    where: { wawuUserId },
    data: {
      progressAt: now,
      ...(opts.submitted ? { submittedAt: now } : {}),
    },
  });
}
