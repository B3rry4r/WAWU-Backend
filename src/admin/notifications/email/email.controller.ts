import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../auth/guards/admin-roles.guard';
import { AdminRoles } from '../../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../../auth/admin-user-view.type';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { MAX_CSV_BYTES } from './email-config';
import { EmailCampaignService } from './email-campaign.service';
import {
  CreateCsvCampaignDto,
  CreateRegistrantCampaignDto,
  EmailPreviewDto,
  EmailRecipientQueryDto,
  EmailTemplateDto,
  EmailTestSendDto,
  RegistrantAudienceQueryDto,
} from './dto/email.dto';

/**
 * The email campaign tool (EMAIL-01): `/api/hub/admin/notifications/email/*`.
 *
 * ROLES. Writing templates, building a campaign and reading results:
 * superadmin and reviewer. SENDING (start, and a test send, which also sends
 * real mail) is superadmin only, the same line the push composer draws for its
 * dispatch. Support and finance have no access: the recipient lists are
 * people's addresses.
 *
 * Literal segments are declared before anything with an `:id`.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/notifications/email')
export class AdminEmailController {
  constructor(private readonly service: EmailCampaignService) {}

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Get('templates')
  templates() {
    return this.service.listTemplates();
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Get('templates/:id')
  template(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getTemplate(id);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('templates')
  @HttpCode(HttpStatus.OK)
  createTemplate(
    @Body() dto: EmailTemplateDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.createTemplate(dto, admin);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Patch('templates/:id')
  @HttpCode(HttpStatus.OK)
  updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EmailTemplateDto,
  ) {
    return this.service.updateTemplate(id, dto);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  deleteTemplate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteTemplate(id);
  }

  /** The final HTML and text for a draft, exactly as a recipient gets them. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body() dto: EmailPreviewDto) {
    return this.service.preview(dto);
  }

  /** One real email to one address. Superadmin only. */
  @AdminRoles(AdminRole.superadmin)
  @Post('test-send')
  @HttpCode(HttpStatus.OK)
  testSend(@Body() dto: EmailTestSendDto) {
    return this.service.testSend(dto);
  }

  /** How many /join registrants a filter and a limit would email. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Get('audiences/registrants')
  registrantCount(@Query() query: RegistrantAudienceQueryDto) {
    return this.service.registrantCount(query.filter, query.limit);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Get('campaigns')
  list(@Query() query: PaginationQueryDto) {
    return this.service.list(query.page, query.perPage);
  }

  /** Build a campaign from the /join registrants. Sends nothing. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('campaigns/registrants')
  @HttpCode(HttpStatus.OK)
  fromRegistrants(
    @Body() dto: CreateRegistrantCampaignDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.createFromRegistrants(
      dto.templateId,
      dto.filter,
      dto.limit,
      admin,
    );
  }

  /** Build a campaign from an uploaded CSV (multipart: file, templateId, limit). Sends nothing. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('campaigns/csv')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }),
  )
  fromCsv(
    @Body() dto: CreateCsvCampaignDto,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    if (!file)
      throw new BadRequestException('Attach the CSV file as the field "file".');
    return this.service.createFromCsv(
      dto.templateId,
      file.buffer.toString('utf8'),
      file.originalname,
      dto.limit,
      admin,
    );
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Get('campaigns/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Get('campaigns/:id/recipients')
  recipients(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: EmailRecipientQueryDto,
  ) {
    return this.service.recipients(id, query);
  }

  /** Start sending in the background. Superadmin only; answers 409 when the server has no email sender set up (neither WAWU ID's mail relay nor its own RESEND_API_KEY), or, in production, no HUB_PUBLIC_URL. */
  @AdminRoles(AdminRole.superadmin)
  @Post('campaigns/:id/start')
  @HttpCode(HttpStatus.OK)
  start(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.start(id);
  }
}
