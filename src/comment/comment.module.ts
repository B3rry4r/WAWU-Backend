import { Module } from '@nestjs/common';
import { CommentController } from './comment.controller';
import { CommentService } from './comment.service';

/**
 * registry.json "Comment" resource module. PrismaService comes from the
 * globally-registered PrismaModule (conventions.md § ORM / database) — not
 * re-imported here.
 */
@Module({
  controllers: [CommentController],
  providers: [CommentService],
})
export class CommentModule {}
