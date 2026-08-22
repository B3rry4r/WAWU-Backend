import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { StorageModule } from '../../storage/storage.module';
import { AdminContentReviewController } from './admin-content-review.controller';
import { AdminContentReviewService } from './admin-content-review.service';

/**
 * Admin content review — the moderation queue that turns a paid upload into
 * something a buyer can actually see.
 *
 * Imports exactly two things, both read-only in the sense that matters:
 *  - AdminAuthModule, for the guards and nothing else. It already exports
 *    AdminAuthGuard and AdminRolesGuard precisely so resource modules built
 *    after it do not re-implement or hoist them.
 *  - StorageModule, for StorageService.signedReadUrl. Its own controller is
 *    registered by app.module.ts, not by this import — Nest registers a
 *    controller once per module, and StorageModule is already in the graph.
 *
 * PrismaService arrives from the global PrismaModule, same as every resource
 * module. No app module, service, DTO or route is imported for WRITING and
 * none is modified.
 */
@Module({
  imports: [AdminAuthModule, StorageModule],
  controllers: [AdminContentReviewController],
  providers: [AdminContentReviewService],
})
export class AdminContentReviewModule {}
