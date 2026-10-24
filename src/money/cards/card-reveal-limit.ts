import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { MoneyError } from '../money-error';
import { PersonWindowLimiter } from '../person-window-limiter';

/** How many times one person may ask to see a card's details in a minute (round 1, L1). Default (lead), owner may override. */
export const CARD_REVEAL_PER_MINUTE = 5;
export const CARD_REVEAL_WINDOW_MS = 60_000;

export const CARD_REVEAL_LIMITED_MESSAGE =
  'You have asked to see your card details a lot. Try again in a minute.';

/**
 * Showing a card's number is the one thing a stolen phone with a guessed PIN
 * would do, so it has its own count apart from the app-wide one: 5 a minute
 * per signed-in person, keyed by the verified WAWU user id, `429
 * card_reveal_rate_limited` past that. A try is counted whether the PIN was
 * right or not (wrong PINs lock the PIN after 5 anyway).
 */
@Injectable()
export class CardRevealLimiter extends PersonWindowLimiter {
  constructor() {
    super(
      [
        {
          name: 'minute',
          limit: CARD_REVEAL_PER_MINUTE,
          windowMs: CARD_REVEAL_WINDOW_MS,
        },
      ],
      (retryAfterSeconds) =>
        new MoneyError(
          'card_reveal_rate_limited',
          CARD_REVEAL_LIMITED_MESSAGE,
          { retryAfterSeconds },
        ),
    );
  }
}

/**
 * Runs after the wallet gate and before the PIN on `POST /money/cards/{id}/reveal`
 * (the gate answers a person with no wallet first and takes no count).
 */
@Injectable()
export class CardRevealLimitGuard implements CanActivate {
  constructor(private readonly limiter: CardRevealLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>();
    const wawuUserId = req.user?.sub;
    if (!wawuUserId) {
      throw new Error(
        'CardRevealLimitGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    this.limiter.take(wawuUserId);
    return true;
  }
}
