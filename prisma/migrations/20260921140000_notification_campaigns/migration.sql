-- Rich notifications and the admin push/promotion channel (build brief C8).
--
-- WHY THIS IS SAFE ON A LIVE TABLE
--
-- "Notification" is written on every settled payment, refund sweep and
-- moderation decision, so it is never quiet. Every change to it here is
-- additive and nullable:
--
--   * the three new columns are NULLABLE with no default, so PostgreSQL
--     records them in the catalogue and rewrites no row. Existing rows read
--     back NULL, which is exactly what "this notification has no picture and
--     no admin-chosen destination" means, so there is nothing to backfill and
--     no deploy ordering to get right;
--   * nothing is dropped, renamed or retyped. The old reader keeps working
--     against the same columns it already selects;
--   * the two new indexes are created IF NOT EXISTS. They are NOT created
--     CONCURRENTLY, because Prisma Migrate runs each migration inside one
--     transaction and CREATE INDEX CONCURRENTLY cannot run in a transaction
--     block. On a table this size that is a short ACCESS SHARE-blocking lock;
--     if "Notification" has grown past a few million rows by the time this
--     ships, run the two CREATE INDEX statements by hand with CONCURRENTLY
--     first and this migration will then skip them.
--
-- The two new tables and four new enums are pure creations. Nothing reads them
-- until AdminNotificationsModule is deployed, so this migration can go out
-- ahead of the code, which is the expand half of expand/contract.

-- ── expand: Notification ────────────────────────────────────────────────────
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "actionHref" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;

-- "how many rows did this campaign actually write", asked once per dispatch
-- and once per dashboard read.
CREATE INDEX IF NOT EXISTS "Notification_campaignId_idx"
  ON "Notification" ("campaignId");

-- The verification-reminder sweep asks "when did THIS user last get THIS kind"
-- for every unverified account, on a schedule. Without this index that is a
-- sequential scan of the whole table per run.
CREATE INDEX IF NOT EXISTS "Notification_userWawuId_kind_createdAt_idx"
  ON "Notification" ("userWawuId", "kind", "createdAt");

-- ── new: campaign vocabulary ────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "NotificationAudience" AS ENUM (
    'everyone',
    'creators',
    'buyers',
    'unverified_creators',
    'professionals',
    'unverified_professionals'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "NotificationCampaignStatus" AS ENUM ('draft', 'sending', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AdminNotificationAction" AS ENUM (
    'campaign_created',
    'campaign_updated',
    'campaign_dispatched',
    'campaign_failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── new: NotificationCampaign ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "NotificationCampaign" (
  "id"                     TEXT NOT NULL,
  "title"                  TEXT NOT NULL,
  "body"                   TEXT NOT NULL,
  "imageUrl"               TEXT,
  "actionLabel"            TEXT,
  "actionHref"             TEXT,
  "tone"                   TEXT NOT NULL DEFAULT 'accent',
  "audience"               "NotificationAudience" NOT NULL,
  "status"                 "NotificationCampaignStatus" NOT NULL DEFAULT 'draft',
  "recipientCount"         INTEGER NOT NULL DEFAULT 0,
  "deliveredCount"         INTEGER NOT NULL DEFAULT 0,
  "failureReason"          TEXT,
  "createdByAdminId"       TEXT NOT NULL,
  "createdByAdminEmail"    TEXT NOT NULL,
  "createdByAdminRole"     "AdminRole" NOT NULL,
  "dispatchedByAdminId"    TEXT,
  "dispatchedByAdminEmail" TEXT,
  "dispatchedAt"           TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NotificationCampaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "NotificationCampaign_status_idx"           ON "NotificationCampaign" ("status");
CREATE INDEX IF NOT EXISTS "NotificationCampaign_createdAt_idx"        ON "NotificationCampaign" ("createdAt");
CREATE INDEX IF NOT EXISTS "NotificationCampaign_createdByAdminId_idx" ON "NotificationCampaign" ("createdByAdminId");

-- ── new: AdminNotificationAudit ─────────────────────────────────────────────
-- No FK to NotificationCampaign, deliberately, and for the same reason
-- AdminContentReview has none to ContentPiece: the trail has to outlive the
-- thing it is about. A campaign deleted from the dashboard must not take the
-- record of it having been sent to 40,000 people with it.
CREATE TABLE IF NOT EXISTS "AdminNotificationAudit" (
  "id"                TEXT NOT NULL,
  "campaignId"        TEXT NOT NULL,
  "action"            "AdminNotificationAction" NOT NULL,
  "audience"          "NotificationAudience" NOT NULL,
  "recipientCount"    INTEGER,
  "deliveredCount"    INTEGER,
  "reason"            TEXT,
  "actedByAdminId"    TEXT NOT NULL,
  "actedByAdminEmail" TEXT NOT NULL,
  "actedByAdminRole"  "AdminRole" NOT NULL,
  "actedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminNotificationAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdminNotificationAudit_campaignId_idx"     ON "AdminNotificationAudit" ("campaignId");
CREATE INDEX IF NOT EXISTS "AdminNotificationAudit_actedByAdminId_idx" ON "AdminNotificationAudit" ("actedByAdminId");
CREATE INDEX IF NOT EXISTS "AdminNotificationAudit_actedAt_idx"        ON "AdminNotificationAudit" ("actedAt");

-- ── NotificationSettings.promotions: default flipped, rows left alone ───────
-- "Offers and news" now gates admin-composed campaigns (kind `campaign`).
-- Nothing had ever read this column, and it defaulted to FALSE, so shipping
-- the campaign channel against that default would have delivered to nobody.
--
-- SET DEFAULT is a catalogue-only change: no table rewrite, no lock beyond a
-- brief ACCESS EXCLUSIVE to update the catalogue row, and NOT ONE EXISTING ROW
-- IS TOUCHED. That is deliberate, not an oversight - a stored `false` cannot
-- be told apart from a deliberate opt-out, and an UPDATE here would silently
-- re-consent every account that has one. Accounts with no row at all fall back
-- to the model default in NotificationService.SETTINGS_DEFAULTS, which is the
-- majority of production accounts (rows are created lazily on first
-- read/write of the settings screen).
ALTER TABLE "NotificationSettings" ALTER COLUMN "promotions" SET DEFAULT true;
