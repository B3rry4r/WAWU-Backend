import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ListSavedItemsDto } from './dto/list-saved-items.dto';
import { SavedItemService } from './saved-item.service';

/**
 * registry.json "SavedItem": GET /users/me/saved — roles: ["any"], i.e. any
 * authenticated WAWU user. Creating/removing a save is owned by the
 * ContentPiece resource (POST/DELETE /content/:id/save) — out of scope
 * here (task brief § SCOPE, one resource per agent).
 */
@UseGuards(WawuAuthGuard)
@Controller('users/me/saved')
export class SavedItemController {
  constructor(private readonly savedItemService: SavedItemService) {}

  @Get()
  list(@CurrentUser() user: WawuJwtClaims, @Query() { kind, page, perPage }: ListSavedItemsDto) {
    return this.savedItemService.list(user.sub, kind, page, perPage);
  }
}
