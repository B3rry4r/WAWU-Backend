import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { CreateProfessionalReviewDto } from './dto/create-professional-review.dto';
import { ListProfessionalDirectoryQueryDto } from './dto/professional-directory.dto';
import { UpdateProfessionalLocationDto } from './dto/update-professional-location.dto';
import type {
  ProfessionalDirectoryPage,
  ProfessionalDirectoryProfile,
  ProfessionalLocationView,
} from './professional.service';
import type { ProfessionalFieldView } from './professional-fields';

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

  // ---- authenticated: where you work (PROS-02) -----------------------------

  @UseGuards(WawuAuthGuard)
  @Get('location')
  location(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<ProfessionalLocationView> {
    return this.service.location(user.sub);
  }

  /** The city on your card and in the directory. A creator account only. */
  @UseGuards(WawuAuthGuard)
  @Put('location')
  setLocation(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateProfessionalLocationDto,
  ): Promise<ProfessionalLocationView> {
    return this.service.setLocation(user.sub, dto.city);
  }

  @UseGuards(WawuAuthGuard)
  @Delete('location')
  clearLocation(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<ProfessionalLocationView> {
    return this.service.clearLocation(user.sub);
  }

  // ---- public: the mobile directory (PROS-02) ------------------------------
  //
  // New routes beside GET /professionals and GET /professionals/:id, which
  // the web reads and which keep their answers. Declared before `:id` for the
  // reason at the top of this file.

  /** The fields the app filters by (P1) and applies in (P5), in the canvas's order. */
  @Get('fields')
  fields(): ProfessionalFieldView[] {
    return this.service.fields();
  }

  /** The directory filtered by field, with city, usual reply time and price. */
  @UseGuards(OptionalWawuAuthGuard)
  @Get('directory')
  directory(
    @Query() query: ListProfessionalDirectoryQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ): Promise<ProfessionalDirectoryPage> {
    return this.service.directory(query, user?.sub);
  }

  /** One professional's profile, with city, usual reply time and price. */
  @UseGuards(OptionalWawuAuthGuard)
  @Get('directory/:id')
  directoryProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ): Promise<ProfessionalDirectoryProfile> {
    return this.service.directoryProfile(id, user?.sub);
  }

  // ---- public: the directory ----------------------------------------------

  @UseGuards(OptionalWawuAuthGuard)
  @Get()
  list(
    @Query() query: ListProfessionalsQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    return this.service.list(query, user?.sub);
  }

  @UseGuards(OptionalWawuAuthGuard)
  @Get(':id')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    return this.service.detail(id, user?.sub);
  }

  /**
   * Rate a professional you have actually dealt with, 1 to 5 stars.
   *
   * A real token, never optional auth: a rating has to be attributable, and
   * the service then checks this person paid to message that professional and
   * got a reply. Posting twice updates your own rating rather than adding a
   * second one.
   */
  @UseGuards(WawuAuthGuard)
  @Post(':id/reviews')
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateProfessionalReviewDto,
  ) {
    return this.service.review(id, user.sub, dto);
  }
}
