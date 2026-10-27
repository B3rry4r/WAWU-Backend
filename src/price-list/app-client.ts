import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * WHICH CLIENT SENT THE REQUEST (PRICE-LIST round 2, lead ruling, option A).
 *
 * The mobile app sends `X-Wawu-Client: app` on every Hub request. The website
 * sends nothing. Some routes the app uses are routes the website also calls
 * (`POST /content`, `PUT /events/{id}/tickets`, `POST /events`), and those must
 * keep their behaviour for the website (the protected registry). The price list
 * (R-101) is therefore applied on them only when this header says the request
 * is the app's.
 *
 * It is a product rule, not a security check: anyone can send the header, and
 * all it can do is hold their own prices to the list. Absent, or any value but
 * `app`, the request is the website's way, exactly as before.
 *
 * Read the way `X-Pay-Source-Currency` is: one middleware on every route
 * (registered by PriceListModule) keeps the answer for the request in an
 * AsyncLocalStorage. A service reads it once, early, in the request's own
 * chain (`PriceListService.forThisRequest()`), before any work is queued.
 */
export const APP_CLIENT_HEADER = 'x-wawu-client';

/** The value the app sends. */
export const APP_CLIENT_VALUE = 'app';

const store = new AsyncLocalStorage<boolean>();

/** True while handling a request that carried `X-Wawu-Client: app`. */
export function isAppRequest(): boolean {
  return store.getStore() === true;
}

@Injectable()
export class AppClientMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const raw = req.headers[APP_CLIENT_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const isApp =
      typeof value === 'string' &&
      value.trim().toLowerCase() === APP_CLIENT_VALUE;
    store.run(isApp, () => next());
  }
}
