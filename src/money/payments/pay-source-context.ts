import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type NestMiddleware } from '@nestjs/common';
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
