import { Module } from '@nestjs/common';
import { SavedItemController } from './saved-item.controller';
import { SavedItemService } from './saved-item.service';

/**
 * registry.json "SavedItem" resource module. PrismaService comes from the
 * globally-registered PrismaModule (conventions.md § ORM / database) — not
 * re-imported here. Register in AppModule per the SEAM comment there — the
 * dispatcher applies that centrally, this module does not self-register.
 */
@Module({
  controllers: [SavedItemController],
  providers: [SavedItemService],
})
export class SavedItemModule {}
