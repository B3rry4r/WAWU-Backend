import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminModerationWordsController } from './admin-moderation-words.controller';

/**
 * MOD-ROOMS (R-122). The word filter itself is a plain function (`content-filter.ts`) and needs no module; this one only
 * carries the moderators' read of the list. It is imported by UgcReportModule, the moderators' module, so app.module.ts
 * does not change.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [AdminModerationWordsController],
})
export class ModerationModule {}
