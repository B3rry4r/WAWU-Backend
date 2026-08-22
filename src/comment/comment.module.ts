import { Module } from '@nestjs/common';
import { CommentController } from './comment.controller';
import { CommentService } from './comment.service';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';

/**
 * registry.json "Comment" resource module. PrismaService comes from the
 * globally-registered PrismaModule (conventions.md § ORM / database) — not
 * re-imported here.
 */
@Module({
  imports: [BlockedAccountModule],
  controllers: [CommentController],
  providers: [CommentService],
})
export class CommentModule {}
