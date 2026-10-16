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
  UseGuards,
} from '@nestjs/common';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import type { ContentPieceResponse } from '../common/types/content-piece.type';
import { GatesPublishing } from '../plans/publishing-offers.interceptor';
import { CreatorAccountGuard } from '../common/guards/creator-account.guard';
import {
  CreateProductDraftDto,
  PublishProductDraftDto,
  UpdateProductDraftDto,
} from './dto/product-draft.dto';
import type { ProductDraftView } from './dto/product-draft.view';
import { ProductDraftService } from './product-draft.service';

/**
 * Draft products (TIER-02, VF2): "Anyone can sign up, build a profile and
 * draft products free." Creator accounts only, like publishing. A draft has
 * no file and holds no place against the tier's product count; publishing it
 * is the step that needs a tier. `product-drafts` is a first segment no other
 * controller declares, so `content/:id` cannot swallow it.
 */
@UseGuards(WawuAuthGuard, CreatorAccountGuard)
@Controller('product-drafts')
export class ProductDraftController {
  constructor(private readonly drafts: ProductDraftService) {}

  /** Save a draft. Free: no tier is asked and no file is taken. */
  @Post()
  create(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateProductDraftDto,
  ): Promise<ProductDraftView> {
    return this.drafts.create(user.sub, dto);
  }

  /** My drafts, newest first. */
  @Get()
  list(@CurrentUser() user: WawuJwtClaims): Promise<ProductDraftView[]> {
    return this.drafts.list(user.sub);
  }

  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<ProductDraftView> {
    return this.drafts.get(user.sub, id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateProductDraftDto,
  ): Promise<ProductDraftView> {
    return this.drafts.update(user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<void> {
    await this.drafts.remove(user.sub, id);
  }

  /**
   * Publish a draft with its two files. Needs a running tier or a tick that
   * has not ended, and a free place: otherwise 402 `tier_required` or
   * `product_limit_reached` with the offers. The piece is created waiting
   * for review, exactly as POST /content creates it, and the draft is gone.
   */
  @Post(':id/publish')
  @GatesPublishing()
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: PublishProductDraftDto,
  ): Promise<ContentPieceResponse> {
    return this.drafts.publish(user.sub, id, dto);
  }
}
