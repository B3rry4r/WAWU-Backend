import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { SchoolLinkService } from './school-link.service';

/**
 * "Apply on their site" (SC9, SCHOOLS-10). The link is a public read, like
 * the course page it is opened from; the tap needs an account, because the
 * click is recorded against the person.
 */
@Controller('schools')
export class SchoolLinkController {
  constructor(private readonly service: SchoolLinkService) {}

  /** The link SC9 prints. Records nothing. */
  @Get('courses/:id/apply-link')
  link(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.link(id);
  }

  /** One tap on "Continue to their site": records one click, answers with the link to open. */
  // @HttpCode(200): the ResponseInterceptor stamps 200 into the body whatever
  // the status (hazard H-3), so the status says 200 too.
  @Post('courses/:id/apply-click')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WawuAuthGuard)
  click(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.service.click(id, user.sub);
  }
}
