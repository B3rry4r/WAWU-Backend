import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { moderationWordList } from './content-filter';

/**
 * MOD-ROOMS (R-122). `GET /api/hub/admin/moderation/words`: the words and phrases the Hub refuses in anything a person
 * writes, by category and language, plus anything added through `MODERATION_EXTRA_WORDS`. Read only: the list is changed
 * in code or in the Hub's environment, not from the dashboard (nothing is drawn that is not built).
 *
 *   read   superadmin, reviewer, support (the roles that read the reports queue)
 *   finance refused
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/moderation')
export class AdminModerationWordsController {
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('words')
  words() {
    return moderationWordList();
  }
}
