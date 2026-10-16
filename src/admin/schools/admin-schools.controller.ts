import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import {
  CreateCourseDto,
  CreateIntakeDto,
  CreateSchoolDto,
  ListSchoolsDto,
  UpdateCourseDto,
  UpdateIntakeDto,
  UpdateSchoolDto,
} from '../../schools/school-admin.dto';
import { PlainObjectBodyPipe } from '../../schools/plain-object-body.pipe';
import { SchoolAdminService } from '../../schools/school-admin.service';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';

/**
 * Schools, courses and intakes from the dashboard (SCHOOLS-02). Admin tokens
 * only: a user token is 401 on every route here, because AdminAuthGuard
 * accepts nothing else.
 *
 * ROLE MATRIX (the shop's, `admin/shop`): read by superadmin, reviewer and
 * support; create, edit and hide by superadmin and reviewer; finance is
 * refused. Nothing deletes: `hidden: true` takes a school, course or intake
 * out of the app and `hidden: false` brings it back.
 */
@Controller('admin')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminSchoolsController {
  constructor(private readonly service: SchoolAdminService) {}

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('schools')
  list(@Query() query: ListSchoolsDto) {
    return this.service.listSchools(query);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('schools/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getSchool(id);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('schools')
  create(@Body(PlainObjectBodyPipe) dto: CreateSchoolDto) {
    return this.service.createSchool(dto);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Patch('schools/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(PlainObjectBodyPipe) dto: UpdateSchoolDto,
  ) {
    return this.service.updateSchool(id, dto);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('schools/:id/courses')
  createCourse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(PlainObjectBodyPipe) dto: CreateCourseDto,
  ) {
    return this.service.createCourse(id, dto);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('school-courses/:id')
  getCourse(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getCourse(id);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Patch('school-courses/:id')
  updateCourse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(PlainObjectBodyPipe) dto: UpdateCourseDto,
  ) {
    return this.service.updateCourse(id, dto);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('school-courses/:id/intakes')
  createIntake(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(PlainObjectBodyPipe) dto: CreateIntakeDto,
  ) {
    return this.service.createIntake(id, dto);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('school-intakes/:id')
  getIntake(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getIntake(id);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Patch('school-intakes/:id')
  updateIntake(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(PlainObjectBodyPipe) dto: UpdateIntakeDto,
  ) {
    return this.service.updateIntake(id, dto);
  }
}
