import { AsyncLocalStorage } from 'node:async_hooks';
import {
  applyDecorators,
  Injectable,
  type NestMiddleware,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';

/**
 * Which account pays a wallet payment (PAY-FX, R-91), for every route that
 * pays from the wallet. The money routes of each feature (an unlock, a tip, a
 * ticket, a school or legal fee, a paid question, a chat request) wrap one
 * payment service, so the choice rides on a header they all read the same
 * way, not on a field each would repeat: `X-Pay-Source-Currency: USD`. Absent
 * (or `NGN`) is the naira wallet, exactly as before. A body's own
 * `sourceCurrency` (`POST /money/payments`) wins over it.
 *
 * The header only names which of the caller's OWN accounts pays; the payment
 * service checks the account belongs to them and that the quote is theirs.
 */
export const PAY_SOURCE_HEADER = 'x-pay-source-currency';

/**
 * Declares the header in the contract, on exactly the routes that read it (the
 * quote and the payment of each paying feature). The app sends it on these and
 * on no other request (PAY-FX round 3, F5).
 */
export function ApiPaySourceHeader() {
  return applyDecorators(
    ApiHeader({
      name: 'X-Pay-Source-Currency',
      required: false,
      description:
        "Optional. The currency of the caller's own account that pays (USD, GBP, EUR ...). Absent, or NGN, is the naira wallet. The price stays naira; the quote answers with the firm amount in that currency in `source`, and the payment must name the same account. The Idempotency-Key is bound to it.",
      schema: { type: 'string', pattern: '^[A-Z]{3,5}$', example: 'USD' },
    }),
  );
}

const store = new AsyncLocalStorage<string | null>();

/** The currency the request in progress asked to pay from, or undefined. */
export function currentPaySource(): string | undefined {
  return store.getStore() ?? undefined;
}

@Injectable()
export class PaySourceMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const raw = req.headers[PAY_SOURCE_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const code =
      typeof value === 'string' && /^[A-Z]{3,5}$/.test(value.trim())
        ? value.trim()
        : null;
    store.run(code, () => next());
  }
}
