import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ContentDetailService } from './content-detail.service';
import { RateContentDto } from './dto/rate-content.dto';
import { SetPreviewDto } from './dto/set-preview.dto';

/**
 * What the content detail screen shows beyond the piece itself (HOME-06): the
 * free preview, the viewer's purchase date, real counts and fair ratings. All
 * new routes at a different depth from `GET /content/:id`, so none can be
 * swallowed by it, and nothing the web calls changes.
 */
@UseGuards(WawuAuthGuard)
@Controller('content/:id')
export class ContentDetailController {
  constructor(private readonly detail: ContentDetailService) {}

  @Get('detail')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.detail.detail(id, user.sub);
  }

  /** Rate, or change your rating. Always one rating per person. */
  @Put('rating')
  @HttpCode(200)
  rate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: RateContentDto,
  ) {
    return this.detail.rate(id, user.sub, dto.rating);
  }

  /** The creator sets how much of their own piece is free to preview. */
  @Put('preview')
  @HttpCode(200)
  setPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: SetPreviewDto,
  ) {
    return this.detail.setPreview(id, user.sub, dto);
  }
}
