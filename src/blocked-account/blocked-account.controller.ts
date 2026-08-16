import { Controller, Delete, Get, Param, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { BlockedAccountService } from './blocked-account.service';
import { ListBlockedAccountsDto } from './dto/list-blocked-accounts.dto';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { BlockedAccount } from '../common/types';

/**
 * registry.json "BlockedAccount": GET/DELETE /settings/privacy/blocked —
 * both roles: ["any"]. See blocked-account.service.ts doc comment: no
 * create endpoint exists in the contract for this resource.
 */
@UseGuards(WawuAuthGuard)
@Controller('settings/privacy/blocked')
export class BlockedAccountController {
  constructor(private readonly blockedAccountService: BlockedAccountService) {}

  @Get()
  list(
    @CurrentUser() user: WawuJwtClaims,
    @Query() { page, perPage }: ListBlockedAccountsDto,
  ): Promise<Paginated<BlockedAccount>> {
    return this.blockedAccountService.list(user.sub, page, perPage);
  }

  @Delete(':id')
  remove(@CurrentUser() user: WawuJwtClaims, @Param('id') id: string): Promise<void> {
    return this.blockedAccountService.remove(user.sub, id);
  }
}
