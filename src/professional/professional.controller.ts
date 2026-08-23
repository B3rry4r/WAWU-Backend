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
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { OptionalWawuAuthGuard } from '../search-response/guards/optional-wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ProfessionalService } from './professional.service';
import { ApplyProfessionalDto } from './dto/apply-professional.dto';
import { ListProfessionalsQueryDto } from './dto/list-professionals-query.dto';
import { UpdateListingDto } from './dto/update-listing.dto';

/**
 * The professional directory — `/api/hub/professionals/*`.
 *
 * ── ROUTE ORDER ────────────────────────────────────────────────────────────
 * Nest matches a controller's routes in declaration order, so the literal
 * `applications` segments are declared BEFORE `:id`. Without that, GET
 * /professionals/applications/mine would be swallowed by the detail route and
 * 400 on the UUID pipe — the same catch-all shape that has bitten this
 * codebase before with `@Controller('services')`.
 *
 * ── AUTH ───────────────────────────────────────────────────────────────────
 * Browsing is public (optional auth, like search and creator discovery) —
 * someone looking for a lawyer should not have to sign up to see that WAWU
 * has any. Applying and managing your own listing require a real token.
 */
@Controller('professionals')
export class ProfessionalController {
  constructor(private readonly service: ProfessionalService) {}

  // ---- authenticated: your own applications -------------------------------

  @UseGuards(WawuAuthGuard)
  @Post('applications')
  apply(@CurrentUser() user: WawuJwtClaims, @Body() dto: ApplyProfessionalDto) {
    return this.service.apply(user.sub, dto);
  }

  @UseGuards(WawuAuthGuard)
  @Get('applications/mine')
  mine(@CurrentUser() user: WawuJwtClaims) {
    return this.service.listMine(user.sub);
  }

  @UseGuards(WawuAuthGuard)
  @Patch('applications/:id/listing')
  setListed(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.service.setListed(user.sub, id, dto.listed);
  }

  // ---- public: the directory ----------------------------------------------

  @UseGuards(OptionalWawuAuthGuard)
  @Get()
  list(@Query() query: ListProfessionalsQueryDto) {
    return this.service.list(query);
  }

  @UseGuards(OptionalWawuAuthGuard)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
}
