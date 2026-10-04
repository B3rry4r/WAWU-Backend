import { Prisma } from '../../generated/prisma/client';

/**
 * The inbox's one ranking, as SQL (task INBOX-07).
 *
 * Three sources, one row per conversation, each with the same four columns:
 *
 *   kind    'chat' | 'community' | 'paid_dm'
 *   key     'chat:<id>' | 'community:<id>' | 'paid_dm:<side>:<wawuId>', unique
 *   at      the time the row is ranked by
 *   unread  what that source calls unread
 *
 * The list sorts `(at DESC, key DESC)` and the cursor is the last row's
 * `(at, key)`, so the order is total and a page boundary is exact. The total
 * for the badge sums the very same `unread` column over the very same rows
 * the list ranks, so the two cannot disagree: there is one definition of each
 * row and of each count, and this is it.
 *
 * Each source's rule is copied from the route that already serves it, and the
 * contract spec checks the numbers against those routes:
 *
 *   chats       ChatService (GET /chats): messages from the other person
 *               after the caller's read mark, by (createdAt, id). A chat with
 *               no message yet is not listed.
 *   communities CommunityRoomsService.mine (GET /communities/mine): rooms the
 *               caller hosts or joined, never a pending request. Unread is
 *               messages from other people, leaving out accounts either side
 *               blocked, sent after the read marker, else after joining; a
 *               host who never opened the room counts all of them. Ranked by
 *               the newest message from someone not hidden, else the join
 *               time, else the epoch (a room of the host's own that is still
 *               empty ranks last, as it does there).
 *   paid DMs    PaidDmService (GET /paid-dm/threads): one row per other
 *               person and side. Ranked by the newest question or reply.
 *               Unread: on the creator side the questions still waiting for
 *               an answer inside their window; the fan side has none.
 *
 * Every value reaches the SQL as a parameter. Raw SQL because one statement
 * has to rank three tables together.
 */

/** Postgres timestamps here are UTC `timestamp(3)`; this pins a JS Date to that. */
export function utc(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

const EPOCH = Prisma.sql`TIMESTAMP '1970-01-01 00:00:00'`;

/** The three source CTEs plus `feed`, the union the list and the badge read. */
export function feedCtes(me: string, now: Date): Prisma.Sql {
  const nowTs = utc(now);

  const paidSide = (side: 'fan' | 'creator'): Prisma.Sql => {
    const meCol = Prisma.raw(
      side === 'fan' ? '"senderWawuId"' : '"creatorWawuId"',
    );
    const otherCol = Prisma.raw(
      side === 'fan' ? '"creatorWawuId"' : '"senderWawuId"',
    );
    const waiting = Prisma.sql`d."status" = 'awaiting_response' AND d."deadlineAt" > ${nowTs}`;
    return Prisma.sql`
      SELECT 'paid_dm'::text AS kind,
             ${'paid_dm:' + side + ':'}::text || t.other AS key,
             t.last_at AS at,
             ${side === 'creator' ? Prisma.sql`t.waiting` : Prisma.sql`0::bigint`} AS unread
      FROM (
        SELECT d.${otherCol} AS other,
               count(*) FILTER (WHERE ${waiting}) AS waiting,
               max(GREATEST(d."sentAt",
                 (SELECT max(r."createdAt") FROM "DmReply" r WHERE r."messageId" = d."id"))) AS last_at
        FROM "DirectMessage" d
        WHERE d.${meCol} = ${me}
        GROUP BY d.${otherCol}
      ) t`;
  };

  return Prisma.sql`
    hidden AS (
      SELECT "blockedWawuId" AS id FROM "BlockedAccount" WHERE "userWawuId" = ${me}
      UNION
      SELECT "userWawuId" AS id FROM "BlockedAccount" WHERE "blockedWawuId" = ${me}
    ),
    chats AS (
      SELECT 'chat'::text AS kind,
             'chat:' || c."id" AS key,
             c."lastActivityAt" AS at,
             (SELECT count(*) FROM "ChatMessage" m
               WHERE m."conversationId" = c."id"
                 AND m."senderWawuId" <> ${me}
                 AND (p."lastReadAt" IS NULL
                      OR m."createdAt" > p."lastReadAt"
                      OR (m."createdAt" = p."lastReadAt"
                          AND m."id" > COALESCE(p."lastReadMessageId", '')))) AS unread
      FROM "ChatParticipant" p
      JOIN "ChatConversation" c ON c."id" = p."conversationId"
      WHERE p."wawuUserId" = ${me}
        AND EXISTS (SELECT 1 FROM "ChatMessage" x WHERE x."conversationId" = c."id")
    ),
    rooms AS (
      SELECT c."id" AS id, NULL::timestamp AS joined_at
      FROM "Community" c WHERE c."hostWawuId" = ${me}
      UNION ALL
      SELECT c."id" AS id, ms."joinedAt" AS joined_at
      FROM "CommunityMembership" ms
      JOIN "Community" c ON c."id" = ms."communityId"
      WHERE ms."userWawuId" = ${me} AND ms."status" = 'joined'
        AND c."hostWawuId" <> ${me}
    ),
    communities AS (
      SELECT 'community'::text AS kind,
             'community:' || r.id AS key,
             COALESCE(last_msg.sent_at, r.joined_at, ${EPOCH}) AS at,
             (SELECT count(*) FROM "CommunityMessage" m
               WHERE m."communityId" = r.id
                 AND m."senderWawuId" <> ${me}
                 AND m."senderWawuId" NOT IN (SELECT id FROM hidden)
                 AND (COALESCE(rm."lastReadAt", r.joined_at) IS NULL
                      OR m."sentAt" > COALESCE(rm."lastReadAt", r.joined_at))) AS unread
      FROM rooms r
      LEFT JOIN "CommunityReadMarker" rm
        ON rm."communityId" = r.id AND rm."userWawuId" = ${me}
      LEFT JOIN LATERAL (
        SELECT m."sentAt" AS sent_at FROM "CommunityMessage" m
        WHERE m."communityId" = r.id
          AND m."senderWawuId" NOT IN (SELECT id FROM hidden)
        ORDER BY m."sentAt" DESC, m."id" DESC
        LIMIT 1
      ) last_msg ON true
    ),
    paid AS (
      ${paidSide('fan')}
      UNION ALL
      ${paidSide('creator')}
    ),
    feed AS (
      SELECT kind, key, at, unread FROM chats
      UNION ALL SELECT kind, key, at, unread FROM communities
      UNION ALL SELECT kind, key, at, unread FROM paid
    )`;
}
