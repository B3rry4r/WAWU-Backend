import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PushTokenService } from './push-token.service';
import { RegisterPushTokenDto, RemovePushTokenDto } from './dto/push-token.dto';
import type { PushTokenRegistered, PushTokenRemoved } from './push-view.type';

/**
 * A phone's push token (task INBOX-03). `push-tokens` is a first segment no
 * other controller declares, so it cannot shadow or be shadowed. Both routes
 * act only on the caller's own tokens, and neither returns or logs a token.
 */
@UseGuards(WawuAuthGuard)
@Controller('push-tokens')
export class PushTokenController {
  constructor(private readonly tokens: PushTokenService) {}

  /** Register this phone for the signed-in person. Idempotent: call it on every start. */
  @Post()
  @HttpCode(200)
  async register(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<PushTokenRegistered> {
    await this.tokens.register(user.sub, dto);
    return { registered: true };
  }

  /** Remove this phone (sign-out). Removing a token twice, or one that is not yours, is a 200 with `removed: false`. */
  @Delete()
  async remove(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: RemovePushTokenDto,
  ): Promise<PushTokenRemoved> {
    return { removed: await this.tokens.remove(user.sub, dto.expoPushToken) };
  }
}
