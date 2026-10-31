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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ContentPieceService } from './content-piece.service';
import { ContentSaleTermsService } from './content-sale-terms.service';
import { ContentSaleTermsQueryDto } from './dto/content-sale-terms-query.dto';
import type { ContentSaleTerms } from './content-sale-terms.type';
import { CreatorAccountGuard } from '../common/guards/creator-account.guard';
import { ListContentQueryDto } from './dto/list-content-query.dto';
import { CreateContentDto } from './dto/create-content.dto';
import { VerifyUnlockDto } from './dto/verify-unlock.dto';
import { RateContentDto } from './dto/rate-content.dto';
import { UpdateContentDto } from './dto/update-content.dto';
import { MyContentQueryDto } from './dto/my-content-query.dto';
import { GatesPublishing } from '../plans/publishing-offers.interceptor';
import { StorageBusyInterceptor } from '../storage/storage-busy.interceptor';
import { PreviewCutService } from './preview-cut.service';
import { assertContentAllowed } from '../moderation/content-filter';

/**
 * registry.json "ContentPiece". Route order deliberately puts literal
 * segments ('mine', 'purchases') before the ':id' catch-all so they are
 * never swallowed by it (Nest matches controller routes in declaration
 * order). Comment (`/content/:id/comments`) and SavedItem's own read
 * endpoint (`/users/me/saved`) are separate wave-0 resources/controllers —
 * no route collision, just adjacent path prefixes.
 */
@UseGuards(WawuAuthGuard)
@UseInterceptors(StorageBusyInterceptor)
@Controller('content')
export class ContentPieceController {
  constructor(
    private readonly contentPieceService: ContentPieceService,
    private readonly saleTerms: ContentSaleTermsService,
    private readonly previews: PreviewCutService,
  ) {}

  /**
   * What a creator keeps of a sale, the listing fee, the quick prices and how
   * long a review usually takes (M24, M25, FIX-110). Read only. Before `:id`
   * so the literal is never taken for an id.
   */
  @Get('sale-terms')
  @UseGuards(CreatorAccountGuard)
  saleTermsAt(@Query() query: ContentSaleTermsQueryDto): ContentSaleTerms {
    return this.saleTerms.terms(query.priceKobo);
  }

  @Get()
  list(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: ListContentQueryDto,
  ) {
    return this.contentPieceService.list(
      user.sub,
      query.scope,
      query.category,
      query.page,
      query.perPage,
      query.sort,
    );
  }

  @Get('mine')
  @UseGuards(CreatorAccountGuard)
  mine(@CurrentUser() user: WawuJwtClaims, @Query() query: PaginationQueryDto) {
    return this.contentPieceService.listMine(
      user.sub,
      query.page,
      query.perPage,
    );
  }

  /** M28: my pieces with sales and the reviewer's reason. Literal paths stay above ':id'. */
  @Get('mine/library')
  @UseGuards(CreatorAccountGuard)
  myLibrary(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: MyContentQueryDto,
  ) {
    return this.contentPieceService.listMyLibrary(
      user.sub,
      query.status,
      query.page,
      query.perPage,
      query.contentType,
    );
  }

  /** The numbers on the M28 filter tabs. */
  @Get('mine/library/counts')
  @UseGuards(CreatorAccountGuard)
  myLibraryCounts(@CurrentUser() user: WawuJwtClaims) {
    return this.contentPieceService.myLibraryCounts(user.sub);
  }

  /** M26: one of my pieces, with its latest rejection reason. */
  @Get('mine/library/:id')
  @UseGuards(CreatorAccountGuard)
  myPiece(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.contentPieceService.getMyPiece(id, user.sub);
  }

  @Get('purchases')
  purchases(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaginationQueryDto,
  ) {
    return this.contentPieceService.listPurchases(
      user.sub,
      query.page,
      query.perPage,
    );
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.contentPieceService.findOne(id, user.sub);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<void> {
    await this.contentPieceService.delete(id, user.sub);
  }

  /**
   * Publishes a piece. Needs a running tier or a tick that has not ended, and
   * a free place for one more product: otherwise 402 `tier_required` or
   * `product_limit_reached` with the offers (TIER-02).
   */
  @Post()
  @UseGuards(CreatorAccountGuard)
  @GatesPublishing()
  async create(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateContentDto,
  ) {
    // MOD-ROOMS (R-122). The words are read first, so a refused title or description never reaches the work below (settling an
    // upload, cutting a preview). The service reads them again, for the callers that do not come through here.
    assertContentAllowed(dto.title, dto.description);
    // A file whose upload outlasted the Hub's wait is counted first, outside
    // any lock (SWEEP-APP-5, ME-04 R4-5).
    await this.contentPieceService.settleSlowUploads(user.sub, dto);
    // PREVIEW-AUTO: the preview a piece goes out with. A clip sent is used as it is; a free piece with none is its own file; a
    // paid audio or video piece asking for it has its preview cut from the full file, after that file is stored.
    const preview = await this.previews.resolve(user.sub, dto);
    const piece = { ...dto, previewAsset: preview.previewAsset };
    try {
      // The files it names must still be the person's: checked inside the
      // create transaction, under the storage lock (ME-04 round 4).
      return await this.contentPieceService.create(
        user.sub,
        piece,
        this.contentPieceService.filesUsableIn(user.sub, piece),
      );
    } catch (err) {
      // A cut made for a publish that did not go through is given back, so it never counts.
      await this.previews.giveBack(user.sub, preview.made);
      throw err;
    }
  }

  /**
   * Edit the details or the file of a piece that is pending or rejected.
   * Sending a file needs a way to publish (402 `tier_required`, TIER-02).
   */
  @Patch(':id')
  @UseGuards(CreatorAccountGuard)
  @GatesPublishing()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateContentDto,
  ) {
    return this.contentPieceService.updateMine(id, user.sub, dto);
  }

  /**
   * Send a rejected piece for review again. It takes a place like a new
   * publish, so it answers the same 402s (TIER-02).
   */
  @Post(':id/resubmit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CreatorAccountGuard)
  @GatesPublishing()
  resubmit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.contentPieceService.resubmit(id, user.sub);
  }

  @Post(':id/unlock')
  unlock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.contentPieceService.unlock(id, user.sub);
  }

  @Post(':id/unlock/verify')
  verifyUnlock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: VerifyUnlockDto,
  ) {
    return this.contentPieceService.verifyUnlock(id, user.sub, dto);
  }

  @Post(':id/save')
  save(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.contentPieceService.save(id, user.sub);
  }

  @Delete(':id/save')
  unsave(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.contentPieceService.unsave(id, user.sub);
  }

  @Post(':id/rate')
  rate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: RateContentDto,
  ) {
    return this.contentPieceService.rate(id, user.sub, dto);
  }
}
