import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { TgifService } from './tgif.service';
import { ReactTgifDto } from './dto/react-tgif.dto';
import { TgifCardPipe, TgifDatePipe } from './tgif.pipes';
import type { TgifCard } from './tgif.constants';

/**
 * TGIF reactions, readers and shares (HOME-10). All new routes under `tgif`,
 * a first segment nothing else uses. `:date` is YYYY-MM-DD.
 */
@UseGuards(WawuAuthGuard)
@Controller('tgif')
export class TgifController {
  constructor(private readonly tgif: TgifService) {}

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
