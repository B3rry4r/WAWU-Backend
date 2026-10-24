import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { MoneyError } from '../money/money-error';
import { CapitalService } from './capital.service';

const ORDER_ID = /^[0-9a-f-]{36}$/i;

function target(context: ExecutionContext): { wawuUserId: string; id: string } {
  const req = context
    .switchToHttp()
    .getRequest<Request & { user?: WawuJwtClaims }>();
  const wawuUserId = req.user?.sub;
  if (!wawuUserId) {
    throw new Error(
      'A Capital guard ran without a signed-in caller: WawuAuthGuard must run first.',
    );
  }
  const id = req.params.id;
  if (typeof id !== 'string' || !ORDER_ID.test(id)) {
    throw new MoneyError('not_found', 'We could not find that order.');
  }
  return { wawuUserId, id };
}

/**
 * Before the PIN on `POST /capital/orders/:id/confirm`: the order is the
 * caller's and still open, the amount is within the limits, and the balance
 * covers it. A request that cannot succeed answers here and uses no PIN try.
 */
@Injectable()
export class CapitalConfirmGuard implements CanActivate {
  constructor(private readonly capital: CapitalService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { wawuUserId, id } = target(context);
    await this.capital.assertMayConfirm(wawuUserId, id);
    return true;
  }
}

/** Before the PIN on `POST /capital/orders/:id/withdrawal`: the holding can be withdrawn and is not on hold. */
@Injectable()
export class CapitalWithdrawGuard implements CanActivate {
  constructor(private readonly capital: CapitalService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { wawuUserId, id } = target(context);
    await this.capital.assertMayWithdraw(wawuUserId, id);
    return true;
  }
}
