import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { PoliciesService } from '../../about/policies.service';
import type { PolicyView } from '../../about/about-view.type';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { PutPolicyDto } from './put-policy.dto';

/**
 * `/api/hub/admin/policies/:slug`: how the owner puts the Terms and the
 * Privacy policy text in (SETTINGS-02). Superadmin only: it is legal wording
 * every user is held to. Replaces the whole document each time.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/policies')
export class AdminLegalDocumentsController {
  constructor(private readonly policies: PoliciesService) {}

  @AdminRoles(AdminRole.superadmin)
  @Put(':slug')
  @HttpCode(HttpStatus.OK)
  put(
    @Param('slug') slug: string,
    @Body() dto: PutPolicyDto,
  ): Promise<PolicyView> {
    return this.policies.put(slug, dto);
  }
}
