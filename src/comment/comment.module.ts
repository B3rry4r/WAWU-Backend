import { Module } from '@nestjs/common';
import { CommentController } from './comment.controller';
import { CommentService } from './comment.service';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';

/**
 * registry.json "Comment" resource module. PrismaService comes from the
 * globally-registered PrismaModule (conventions.md § ORM / database) — not
 * re-imported here. WawuAuthModule is imported for WawuIdClient, which
 * CommentService uses to resolve a commenter's real name (list() batches
 * this — see lookupAuthors).
 */
@Module({
  imports: [BlockedAccountModule, WawuAuthModule],
  controllers: [CommentController],
  providers: [CommentService],
})
export class CommentModule {}
