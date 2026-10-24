import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ChangeHandleDto } from './dto/change-handle.dto';
import { CompleteIdentityDto } from './dto/complete-identity.dto';
import { HandleAvailabilityQueryDto } from './dto/handle-availability.dto';
import { SignupIdentityService } from './signup-identity.service';

/**
 * Is a username free? Signed out on purpose: the sign-up form asks while a person types, before there is an
 * account. It answers free or not with the server's sentence and nothing else (no one's id, no profile), and
 * every handle is already public on the profile link. Its own rate limit keeps a loop from walking the names.
 * Closes G-111.
 */
@Controller('users')
export class HandleAvailabilityController {
  constructor(private readonly identity: SignupIdentityService) {}

  @Get('handle-available')
  @Throttle({ medium: { limit: 60, ttl: 60_000 } })
  available(@Query() query: HandleAvailabilityQueryDto) {
    return this.identity.availability(query.handle);
  }
}

/**
 * Completing a profile's name and username (SIGNUP-NAMES, R-82), on a route of its own for the reason
 * `PUT /users/me/account-type` gives: `PATCH /users/me` opens a wallet for a creator, and nobody has one until
 * they open it (R-6). The owner is the token's.
 */
@UseGuards(WawuAuthGuard)
@Controller('users')
export class SignupIdentityController {
  constructor(private readonly identity: SignupIdentityService) {}

  @Put('me/identity')
  complete(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CompleteIdentityDto,
  ) {
    return this.identity.complete(user, dto);
  }

  /**
   * The app's Edit profile changing a username it already has (round 3, M2). The same rules and lock as the route
   * above; `PATCH /users/me` is untouched because the web calls it (BACKEND_GAPS G-SIGNUP-NAMES-1).
   */
  @Put('me/handle')
  changeHandle(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ChangeHandleDto,
  ) {
    return this.identity.changeHandle(user, dto);
  }
}
