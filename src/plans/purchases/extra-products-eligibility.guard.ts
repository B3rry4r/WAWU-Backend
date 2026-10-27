import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { ExtraProductsService } from './extra-products.service';
import { EXTRA_PRODUCTS_KIND } from './plan-purchase-terms';

/**
 * Runs BEFORE the wallet gate on the quote and the purchase of the extra
 * products pack (PACK-CAP, R-100): a refusal because of who the person is
 * (`pack_not_allowed`) is answered first, so no wallet or payment gate leads a
 * person to something they cannot buy. Any other kind passes untouched.
 * Put directly above `@RequireFeesSet()`, so it runs right after FeesSetGuard (the house order: auth, fees_not_set, eligibility, then the wallet gate).
 */
@Injectable()
export class ExtraProductsEligibilityGuard implements CanActivate {
  constructor(private readonly extras: ExtraProductsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>();
    const source = req.method === 'GET' ? req.query : (req.body as unknown);
    const kind =
      source !== null && typeof source === 'object'
        ? (source as Record<string, unknown>).kind
        : undefined;
    if (kind !== EXTRA_PRODUCTS_KIND || !req.user) return true;
    await this.extras.assertEligible(req.user.sub);
    return true;
  }
}
