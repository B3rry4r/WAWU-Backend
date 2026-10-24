import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { WalletCardService } from './wallet-card.service';

/**
 * Runs after the Idempotency-Key and before the PIN on `POST /money/cards`
 * (the `beforeApproval` slot of `@RequireIdempotentApproval`): cards switched
 * off, not built for this provider, or a person already at a limit, are
 * answered before a PIN try is used. A refusal here gives the key back.
 */
@Injectable()
export class CardCreatableGuard implements CanActivate {
  constructor(private readonly cards: WalletCardService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>();
    const wawuUserId = req.user?.sub;
    if (!wawuUserId) {
      throw new Error(
        'CardCreatableGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    this.cards.assertCreatable();
    await this.cards.assertWithinLimits(wawuUserId);
    return true;
  }
}
