import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { PlainObjectBodyPipe } from '../plain-object-body.pipe';
import { SchoolPayeeService } from './school-payee.service';
import { ListSettlementsDto, SetPayeeDto } from './school-settlement.dto';
import { SchoolSettlementService } from './school-settlement.service';
import type {
  CancelIntakeView,
  SchoolPayeeView,
  SchoolSettlementPage,
  SchoolSettlementView,
} from './school-settlement-view.type';

/**
 * Paying schools from the dashboard (task SCHOOLS-11). Admin tokens only: a
 * user token is 401 on every route here. The money ones are for the
 * superadmin and finance roles alone (the reviewer and support roles of the
 * schools routes are refused).
 */
@Controller('admin')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class SchoolSettlementAdminController {
  constructor(
    private readonly payees: SchoolPayeeService,
    private readonly settlements: SchoolSettlementService,
  ) {}

  /** The bank account the school is paid at; 404 when it has none yet. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('schools/:id/payee')
  payee(@Param('id', ParseUUIDPipe) id: string): Promise<SchoolPayeeView> {
    return this.payees.get(id);
  }

  /**
   * Saves the school's bank account after the bank confirms it (the holder's
   * name is what the bank gives). A miss saves nothing: 422.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Put('schools/:id/payee')
  setPayee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(PlainObjectBodyPipe) dto: SetPayeeDto,
    @CurrentAdmin() admin: AdminUserView,
  ): Promise<SchoolPayeeView> {
    return this.payees.set(id, dto, admin.id);
  }

  /** Settlements, newest first: what is owed to schools, what was paid, what went back. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('school-settlements')
  list(@Query() query: ListSettlementsDto): Promise<SchoolSettlementPage> {
    return this.settlements.list(query);
  }

  /**
   * Calls a class off: no more enrolments, unpaid places go back, and every
   * paid enrolment's fee goes back to the student's wallet. A fee already paid
   * to the school is counted in `alreadyPaidOut`, not refunded.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post('school-intakes/:id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<CancelIntakeView> {
    return this.settlements.cancelIntake(id);
  }

  /** Sends one paid enrolment's fee back to the student. 409 once it is on its way to the school. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post('school-enrolments/:id/refund')
  refund(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SchoolSettlementView> {
    return this.settlements.refundEnrolment(id);
  }
}
