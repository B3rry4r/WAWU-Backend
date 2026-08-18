-- The old platform published eight services; this build only knew three kinds
-- (cac, nepc, mentor-request), so the rest had nowhere to be recorded and were
-- shown as permanently "coming soon". These are the remaining published
-- services carried over, each of which is a short request that a partner then
-- reviews, exactly as before.
ALTER TYPE "ServiceApplicationKind" ADD VALUE IF NOT EXISTS 'easybuy';
ALTER TYPE "ServiceApplicationKind" ADD VALUE IF NOT EXISTS 'pension';
ALTER TYPE "ServiceApplicationKind" ADD VALUE IF NOT EXISTS 'banking';
ALTER TYPE "ServiceApplicationKind" ADD VALUE IF NOT EXISTS 'grants';
