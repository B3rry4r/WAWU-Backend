-- Notification switches the server honours (task SETTINGS-07).
--
-- Additive only: three nullable columns on NotificationSettings and nothing
-- else. NULL means the person never touched the switch and behaves as ON, so
-- every existing row reads, serialises and notifies exactly as before.
ALTER TABLE "NotificationSettings"
    ADD COLUMN "moneyIn" BOOLEAN,
    ADD COLUMN "contentReviews" BOOLEAN,
    ADD COLUMN "communityMessages" BOOLEAN;
