import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { TgifService } from './tgif.service';
import { ReactTgifDto } from './dto/react-tgif.dto';
import { TgifCardPipe, TgifDatePipe } from './tgif.pipes';
import type { TgifCard } from './tgif.constants';
import { TgifContentService } from './content/tgif-content.service';
import type { TgifDayView } from './content/tgif-day.type';
import { ShareImageService } from './share/share-image.service';

/**
 * TGIF reactions, readers and shares (HOME-10), the text of each day and the
 * card that is shared (HOME-09). All new routes under `tgif`, a first segment
 * nothing else uses. `:date` is YYYY-MM-DD.
 */
@UseGuards(WawuAuthGuard)
@Controller('tgif')
export class TgifController {
  constructor(
    private readonly tgif: TgifService,
    private readonly content: TgifContentService,
    private readonly images: ShareImageService,
  ) {}

  /** The five cards of the day, addressed to the caller by first name. */
  @Get(':date')
  day(
    @Param('date', new TgifDatePipe('read')) date: string,
    @CurrentUser() user: WawuJwtClaims,
  ): TgifDayView {
    return this.content.day(date, user.firstName);
  }

  /** The verse of the day on the shared card, as a PNG (H35). */
  @Get(':date/share-image')
  @ApiOkResponse({
    description: "The day's verse on the TGIF card, as a PNG image.",
    content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
  })
  async shareImage(
    @Param('date', new TgifDatePipe('read')) date: string,
    @Res() res: Response,
  ): Promise<void> {
    // The card holds no name: the verse is the same for everyone.
    const day = this.content.day(date, null);
    const body = await this.images.png({
      date,
      verse: day.verse,
      reference: day.verseReference,
      link: day.shareLink,
    });
    res
      .status(200)
      .set({
        'Content-Type': 'image/png',
        'Content-Length': String(body.length),
        'Content-Disposition': `inline; filename="TGIF-${date}.png"`,
        'Cache-Control': 'private, max-age=3600',
      })
      .end(body);
  }

  @Get(':date/stats')
  stats(
    @Param('date', new TgifDatePipe('read')) date: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.tgif.stats(date, user.sub);
  }

  @Post(':date/react')
  @HttpCode(200)
  react(
    @Param('date', new TgifDatePipe('write')) date: string,
    @Body() dto: ReactTgifDto,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.tgif.react(date, user.sub, dto.card, dto.kind);
  }

  @Delete(':date/react/:card')
  @HttpCode(200)
  unreact(
    @Param('date', new TgifDatePipe('write')) date: string,
    @Param('card', new TgifCardPipe()) card: TgifCard,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.tgif.unreact(date, user.sub, card);
  }

  @Post(':date/read')
  @HttpCode(200)
  read(
    @Param('date', new TgifDatePipe('write')) date: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.tgif.read(date, user.sub);
  }

  @Post(':date/share')
  @HttpCode(200)
  share(
    @Param('date', new TgifDatePipe('write')) date: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.tgif.share(date, user.sub);
  }
}
