import { Module } from '@nestjs/common';
import { SearchResponseController } from './search-response.controller';
import { SearchResponseService } from './search-response.service';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { OptionalWawuAuthGuard } from './guards/optional-wawu-auth.guard';

/**
 * registry.json "SearchResponse" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here, mirroring every other Phase 5 resource module.
 */
@Module({
  imports: [BlockedAccountModule],
  controllers: [SearchResponseController],
  providers: [SearchResponseService, OptionalWawuAuthGuard],
})
export class SearchResponseModule {}
