import {
  applyDecorators,
  type CanActivate,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { FeeQuoteService } from './fee-quote.service';

/**
 * Refuses a request with `503 fees_not_set` while any of the running
 * provider's fee settings is unset (Nuvion's NUVION_FEE_*; Fintava's always
 * have their ruled figures). Guards run before pipes and the handler, so
 * nothing is sent to the provider. Read-only routes (the balance, the
 * history, the account number) do not carry it.
 */
@Injectable()
export class FeesSetGuard implements CanActivate {
  constructor(private readonly quotes: FeeQuoteService) {}

  canActivate(): boolean {
    this.quotes.assertFeesSet();
    return true;
  }
}

/**
 * Put on every route that quotes a fee or moves money, as the LAST decorator
 * (directly above the handler). Nest applies a method's decorators bottom
 * first and runs its guards in that order, so this one runs before every
 * other guard on the method: before the wallet gate, the Idempotency-Key
 * record and the PIN (`@RequireTransactionPin()` and `@RequireApproval()`
 * bring the gate and the PIN check together). While fees are not set no PIN
 * try is used and nothing is stored. Class guards run before every method
 * guard, so the wallet gate and the PIN guard never go on the controller:
 * only `WawuAuthGuard` does. src/money/limits/tests/
 * money-moving-coverage.spec.ts holds every mounted route to it, class
 * guards included (task FIX-21).
 */
export function RequireFeesSet(): MethodDecorator {
  return applyDecorators(UseGuards(FeesSetGuard));
}
