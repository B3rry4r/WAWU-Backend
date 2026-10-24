import { Prisma } from '../../generated/prisma/client';

/**
 * The inbox's one ranking, as SQL (task INBOX-07).
 *
 * Four sources, one row each, with the same four columns (a fifth, the
 * sends of FIX-114, joins them only when a call asks for it):
 *
 *   kind    'chat' | 'community' | 'paid_dm' | 'money_request' | 'money_move'
 *   key     'chat:<id>' | 'community:<id>' | 'paid_dm:<side>:<wawuId>' |
 *           'money_request:<id>' | 'money_move:<id>', unique
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
 *   money       MoneyRequest (INBOX-15): one row per request the caller made
 *               or was asked for, in any status. Ranked by when its status
 *               last changed, else when it was made. Unread is always 0:
 *               the request is also a message in its chat, which counts it,
 *               so the badge counts a request once.
 *
 *   sends       WalletTransfer (FIX-114, G-INBOX-15-1): one row per send of
 *               kind `wawu_user` the caller made or received, joined to the
 *               one chat of the two people (a send with no chat has nothing
 *               to open and is not a row). A failed send is not a row. A send
 *               still pending is its sender's only: the receiver has nothing
 *               yet. A send that paid a money request is the request's row,
 *               not a second one. Ranked by when the send was made. Unread is
 *               always 0. These rows are in the feed only when `withMoves` is
 *               set (`GET /inbox?kind=money`), so the unfiltered list, the
 *               other filters and the badge read exactly as they did.
 *
 * Every value reaches the SQL as a parameter. Raw SQL because one statement
 * has to rank three tables together.
 */

/** Postgres timestamps here are UTC `timestamp(3)`; this pins a JS Date to that. */
export function utc(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

const EPOCH = Prisma.sql`TIMESTAMP '1970-01-01 00:00:00'`;

/**
 * The source CTEs plus `feed`, the union the list and the badge read.
 * `withMoves` adds the sends (FIX-114) to `feed`; nothing else changes.
 */
export function feedCtes(me: string, now: Date, withMoves = false): Prisma.Sql {
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
        -- INBOX-24 (R-63): a room that sells a pass is listed only while the
        -- person's pass runs; its preview and unread count are reading.
        AND (NOT EXISTS (SELECT 1 FROM "CommunityPassPrice" pp
                          WHERE pp."communityId" = c."id")
             OR EXISTS (SELECT 1 FROM "CommunityPass" cp
                         WHERE cp."communityId" = c."id"
                           AND cp."userWawuId" = ${me}
                           AND cp."endsAt" > ${nowTs}))
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
    money AS (
      SELECT 'money_request'::text AS kind,
             'money_request:' || r."id" AS key,
             COALESCE(r."changedAt", r."createdAt") AS at,
             0::bigint AS unread
      FROM "MoneyRequest" r
      WHERE r."requesterWawuId" = ${me} OR r."payerWawuId" = ${me}
    ),
    moves AS (
      SELECT 'money_move'::text AS kind,
             'money_move:' || t."id" AS key,
             t."createdAt" AS at,
             0::bigint AS unread
      FROM "WalletTransfer" t
      WHERE t."kind" = 'wawu_user'
        AND t."status" IN ('pending', 'completed', 'reversed')
        AND (t."payerWawuUserId" = ${me}
             OR (t."recipientWawuUserId" = ${me} AND t."status" <> 'pending'))
        AND EXISTS (
          SELECT 1 FROM "ChatConversation" c
          WHERE (c."userAWawuId" = t."payerWawuUserId" AND c."userBWawuId" = t."recipientWawuUserId")
             OR (c."userAWawuId" = t."recipientWawuUserId" AND c."userBWawuId" = t."payerWawuUserId"))
        AND NOT EXISTS (SELECT 1 FROM "MoneyRequest" q WHERE q."transferId" = t."id")
    ),
    feed AS (
      SELECT kind, key, at, unread FROM chats
      UNION ALL SELECT kind, key, at, unread FROM communities
      UNION ALL SELECT kind, key, at, unread FROM paid
      UNION ALL SELECT kind, key, at, unread FROM money${
        withMoves
          ? Prisma.sql`
      UNION ALL SELECT kind, key, at, unread FROM moves`
          : Prisma.empty
      }
    )`;
}
