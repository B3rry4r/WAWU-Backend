import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { AdminCardsService } from './admin-cards.service';
import { AdminCardsQueryDto } from './card-request.dto';
import type { AdminCardPage, CardView } from './card-view.type';

/**
 * The WAWU card for support (task WALLET-31) -- `/api/hub/admin/money/cards/*`
 * once the global prefix is applied.
 *
 * ── ROLE MATRIX ───────────────────────────────────────────────────────────
 *   list, freeze, unfreeze, cancel   superadmin, finance
 *   reviewer, support                refused entirely
 *
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so each
 * handler names both roles. By account id only: nothing here reads or returns
 * a card number, expiry, CVV, name or phone. Every action is audited.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money/cards')
export class AdminCardsController {
  constructor(private readonly cards: AdminCardsService) {}

  /** Cards on the system, newest first, a cursor page; filter by state or by one person. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: AdminCardsQueryDto): Promise<AdminCardPage> {
    return this.cards.list(query);
  }

  /** Freezes a person's card; the person cannot unfreeze it. Safe to repeat. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/freeze')
  @HttpCode(HttpStatus.OK)
  freeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CardView> {
    return this.cards.freeze(admin, id);
  }

  /** Lets a card support froze work again. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/unfreeze')
  @HttpCode(HttpStatus.OK)
  unfreeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CardView> {
    return this.cards.unfreeze(admin, id);
  }

  /** Blocks a person's card for good (Nuvion deletes it). Safe to repeat. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CardView> {
    return this.cards.cancel(admin, id);
  }
}
