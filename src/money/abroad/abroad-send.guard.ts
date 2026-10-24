import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { dropTransactionPin } from '../gate/wallet-gate';
import { AbroadSendService } from './abroad-send.service';

/**
 * Runs after the Idempotency-Key and before the PIN (`@RequireIdempotentApproval`'s
 * `beforeApproval`): a send that cannot succeed (the product off, the person
 * frozen, no abroad side on this provider, a quote that is not theirs, used or
 * run out) answers before it uses up a PIN try, and gives the key back.
 */
@Injectable()
export class AbroadSendGuard implements CanActivate {
  constructor(private readonly sends: AbroadSendService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>();
    const userId = req.user?.sub;
    if (!userId) {
      throw new Error(
        'AbroadSendGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    const body = req.body as { quoteId?: unknown } | undefined;
    try {
      await this.sends.checkBeforePin(userId, body?.quoteId);
      return true;
    } catch (e) {
      dropTransactionPin(req);
      throw e;
    }
  }
}
