import { Module } from '@nestjs/common';
import { SearchResponseController } from './search-response.controller';
import { SearchResponseService } from './search-response.service';
import { SearchHistoryController } from './search-history.controller';
import { SearchHistoryService } from './search-history.service';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { SchoolsPublicModule } from '../schools/schools-public.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { OptionalWawuAuthGuard } from './guards/optional-wawu-auth.guard';

/**
 * registry.json "SearchResponse" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here, mirroring every other Phase 5 resource module.
 */
@Module({
  imports: [BlockedAccountModule, SchoolsPublicModule, PlanSettingsModule],
  controllers: [SearchResponseController, SearchHistoryController],
  providers: [
    SearchResponseService,
    SearchHistoryService,
    OptionalWawuAuthGuard,
  ],
})
export class SearchResponseModule {}
