import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { POINTS_LIMITS } from '../points-config';
import {
  QUOTE_TOKEN_MAX_LENGTH,
  QUOTE_TOKEN_MESSAGE,
} from './points-convert.dto';
import { PointsConvertService } from './points-convert.service';

const POINTS_MESSAGE = 'points must be a whole number of 1 or more.';

/**
 * The checks of `POST /points/convert` that come BEFORE the PIN (task
 * POINTS-04): a dollar-billed person, fewer points than the minimum, more
 * cash than one move may carry, more points than the person has. A request
 * that cannot succeed answers here, changes nothing and uses up no PIN try;
 * the Idempotency-Key row it took is given back by the route's filter (it
 * names no conversion yet).
 *
 * It sits between the Idempotency-Key guard and the PIN guard
 * (`RequireIdempotentApproval(route, ConvertPrecheckGuard)`): a repeat of a
 * finished request is answered from the stored result before this runs, so a
 * balance that has since changed never turns a replay into a refusal, and no
 * wallet is the wallet gate's, which runs before all of them. Guards run
 * before pipes, so it reads `points` from the body itself and refuses what
 * is not a whole number of points with the validation pipe's plain 400, and
 * the same for a body with no quote token. A quote token that is there but no
 * longer holds is `409 quote_changed`, also before the PIN.
 */
@Injectable()
export class ConvertPrecheckGuard implements CanActivate {
  constructor(private readonly convert: PointsConvertService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>();
    const user = req.user;
    if (!user?.sub) {
      throw new Error(
        'ConvertPrecheckGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    const body: unknown = req.body;
    const points =
      typeof body === 'object' && body !== null
        ? (body as { points?: unknown }).points
        : undefined;
    if (
      typeof points !== 'number' ||
      !Number.isSafeInteger(points) ||
      points < 1 ||
      points > POINTS_LIMITS.maxPoints
    ) {
      throw new BadRequestException([POINTS_MESSAGE]);
    }
    const quoteToken = (body as { quoteToken?: unknown }).quoteToken;
    if (
      typeof quoteToken !== 'string' ||
      quoteToken.length < 1 ||
      quoteToken.length > QUOTE_TOKEN_MAX_LENGTH
    ) {
      throw new BadRequestException([QUOTE_TOKEN_MESSAGE]);
    }
    await this.convert.assertMayConvert(
      user.sub,
      { phone: user.phone, country: user.country },
      points,
      quoteToken,
    );
    return true;
  }
}
