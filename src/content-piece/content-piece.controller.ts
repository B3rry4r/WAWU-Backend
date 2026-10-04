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
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ContentPieceService } from './content-piece.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { ListContentQueryDto } from './dto/list-content-query.dto';
import { CreateContentDto } from './dto/create-content.dto';
import { VerifyUnlockDto } from './dto/verify-unlock.dto';
import { RateContentDto } from './dto/rate-content.dto';
import { UpdateContentDto } from './dto/update-content.dto';
import { MyContentQueryDto } from './dto/my-content-query.dto';

/**
 * registry.json "ContentPiece". Route order deliberately puts literal
 * segments ('mine', 'purchases') before the ':id' catch-all so they are
 * never swallowed by it (Nest matches controller routes in declaration
 * order). Comment (`/content/:id/comments`) and SavedItem's own read
 * endpoint (`/users/me/saved`) are separate wave-0 resources/controllers —
 * no route collision, just adjacent path prefixes.
 */
@UseGuards(WawuAuthGuard)
@Controller('content')
export class ContentPieceController {
  constructor(private readonly contentPieceService: ContentPieceService) {}

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

  @Post()
  @UseGuards(CreatorAccountGuard)
  create(@CurrentUser() user: WawuJwtClaims, @Body() dto: CreateContentDto) {
    return this.contentPieceService.create(user.sub, dto);
  }

  /** Edit the details or the file of a piece that is pending or rejected. */
  @Patch(':id')
  @UseGuards(CreatorAccountGuard)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateContentDto,
  ) {
    return this.contentPieceService.updateMine(id, user.sub, dto);
  }

  /** Send a rejected piece for review again. */
  @Post(':id/resubmit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CreatorAccountGuard)
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
