import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { ADD_MONEY_RAILS } from '../../wallet-provider/add-money';
import { AddMoneyService } from './add-money.service';

const SHAPE = 'rail, amountKobo and chargeKobo are needed, in whole kobo.';

/**
 * The checks of `POST /money/add-money` that come BEFORE the PIN (WALLET-25,
 * WALLET-26): the way is on and set up, WAWU's limits, and the total the
 * person was shown. A request that cannot succeed answers here, changes
 * nothing and uses up no PIN try (the Idempotency-Key it took is given back by
 * the route's filter). Guards run before pipes, so it reads the three plain
 * fields itself and refuses anything else with the validation pipe's 400.
 */
@Injectable()
export class AddMoneyPrecheckGuard implements CanActivate {
  constructor(private readonly addMoney: AddMoneyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>();
    if (!req.user?.sub) {
      throw new Error(
        'AddMoneyPrecheckGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    const body = (
      typeof req.body === 'object' && req.body !== null ? req.body : {}
    ) as { rail?: unknown; amountKobo?: unknown; chargeKobo?: unknown };
    const whole = (v: unknown): v is number =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
    if (
      typeof body.rail !== 'string' ||
      !(ADD_MONEY_RAILS as readonly string[]).includes(body.rail) ||
      !whole(body.amountKobo) ||
      !whole(body.chargeKobo)
    ) {
      throw new BadRequestException([SHAPE]);
    }
    if (body.rail === 'card') {
      const card = (body as { card?: { encrypted?: unknown } }).card;
      this.addMoney.assertCardCiphertext(card?.encrypted);
    }
    await this.addMoney.precheck(req.user.sub, {
      rail: body.rail as (typeof ADD_MONEY_RAILS)[number],
      amountKobo: body.amountKobo,
      chargeKobo: body.chargeKobo,
    });
    return true;
  }
}
