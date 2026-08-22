import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { BlockedAccountService } from './blocked-account.service';
import { CreateBlockedAccountDto } from './dto/create-blocked-account.dto';
import { ListBlockedAccountsDto } from './dto/list-blocked-accounts.dto';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { BlockedAccount } from '../common/types';

/**
 * registry.json "BlockedAccount": GET/DELETE /settings/privacy/blocked —
 * both roles: ["any"].
 *
 * POST on the same path is ADDITIVE and new. The registry never contracted a
 * create endpoint for this resource, which is precisely why blocking was
 * impossible: the privacy screen offered it, the table existed, and no code
 * anywhere wrote a row. Existing route paths and response shapes are
 * unchanged — this only adds a verb to a path that already exists.
 */
@UseGuards(WawuAuthGuard)
@Controller('settings/privacy/blocked')
export class BlockedAccountController {
  constructor(private readonly blockedAccountService: BlockedAccountService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateBlockedAccountDto,
  ): Promise<BlockedAccount> {
    return this.blockedAccountService.create(user.sub, dto);
  }

  @Get()
  list(
    @CurrentUser() user: WawuJwtClaims,
    @Query() { page, perPage }: ListBlockedAccountsDto,
  ): Promise<Paginated<BlockedAccount>> {
    return this.blockedAccountService.list(user.sub, page, perPage);
  }

  /** `:id` is the BlockedAccount row's own uuid PK, not the blocked user's wawuId — see the service. */
  @Delete(':id')
  remove(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.blockedAccountService.remove(user.sub, id);
  }
}
