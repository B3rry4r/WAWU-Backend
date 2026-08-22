import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ApplyPartnerServiceDto } from './dto/apply-partner.dto';
import { ServiceApplicationService } from './service-application.service';

/**
 * Alias for the one path the shipped web app gets wrong.
 *
 * WAWU-Web posts pension and loan applications to
 * `/api/hub/service-applications/partner/apply`
 * (`src/lib/api/lifestyle.ts` → `applyForPartnerService`). The route is, and
 * always has been, `/api/hub/services/partner/apply` — every other call in
 * that app uses the `services/` prefix, so this one path is a typo that has
 * never resolved: pension registration 404s for every user.
 *
 * The app is shipped, so the fix goes here rather than in the client: the
 * backend accepts the path the client already sends. `services/partner/apply`
 * is untouched and remains canonical — this controller only forwards to the
 * same service method, so there is one implementation and one behaviour.
 *
 * FOLLOW-UP: when the web app is next released with the canonical path, this
 * file can be deleted.
 */
@UseGuards(WawuAuthGuard)
@Controller('service-applications')
export class ServiceApplicationAliasController {
  constructor(
    private readonly serviceApplicationService: ServiceApplicationService,
  ) {}

  @Post('partner/apply')
  @HttpCode(HttpStatus.CREATED)
  applyPartner(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ApplyPartnerServiceDto,
  ) {
    return this.serviceApplicationService.applyForPartnerService(user.sub, dto);
  }
}
