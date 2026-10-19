import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { AccountPurgeModule } from './account-purge.module';
import { IdDocsRetentionService } from './id-docs-retention.service';

/**
 * The daily sweep that deletes a deleted account's ID documents after the days
 * kept (SETTINGS-09, R-73). Not imported by AppModule (a fenced file):
 * AccountModule imports it, and AppModule mounts that. Nest builds a module
 * once, so there is one service and one cron job. The days kept are an admin
 * setting (PlanSettingsModule); the bucket is the purge's (StorageRemover).
 */
@Module({
  imports: [ConfigModule, PlanSettingsModule, AccountPurgeModule],
  providers: [IdDocsRetentionService],
  exports: [IdDocsRetentionService],
})
export class IdDocsRetentionModule {}
