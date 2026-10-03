import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { WalletGateGuard } from '../gate/wallet-gate';
import { TransactionPinHeader } from '../money-contract';
import { MoneyError } from '../money-error';
import { TransactionPinService } from './transaction-pin.service';

/** The one place a transaction PIN may travel (CONVENTIONS.md section 5). Lower case, as Node keys headers. */
export const TRANSACTION_PIN_HEADER = 'x-transaction-pin';

/** Four digits, the contract's `^[0-9]{4}$`. */
const PIN_FORMAT = /^[0-9]{4}$/;

const REQUIRED_MESSAGE = 'Enter your 4-digit transaction PIN.';

/**
 * Takes the PIN out of the request: reads `X-Transaction-Pin`, then deletes
 * it from `headers` and `rawHeaders`, so nothing that runs later (a handler,
 * an exception filter, an error reporter, a request logger added one day)
 * can see it. Answers null when the header is missing, sent twice, or not
 * four digits: none of those is a PIN, so none of them uses up a try.
 */
export function takeTransactionPin(req: Request): string | null {
  const value: unknown = req.headers[TRANSACTION_PIN_HEADER];
  delete req.headers[TRANSACTION_PIN_HEADER];
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) {
    for (let i = raw.length - 2; i >= 0; i -= 2) {
      if (raw[i].toLowerCase() === TRANSACTION_PIN_HEADER) raw.splice(i, 2);
    }
  }
  return typeof value === 'string' && PIN_FORMAT.test(value) ? value : null;
}

/**
 * The X-Transaction-Pin check every debit route uses (task MONEY-09).
 *
 * It reads the PIN from that header only (never a body, a query or a path),
 * refuses a request without one with `403 pin_required`, and checks it with
 * TransactionPinService: `409 pin_not_set`, `403 pin_incorrect` with
 * `triesLeft`, `423 pin_locked` with `lockedUntil`. Never a 401: a 401 means
 * the WAWU ID token, and the app signs the person out on it.
 *
 * Use it through `@RequireTransactionPin()`, which also writes the header
 * into the contract. It must run after WawuAuthGuard (put `@UseGuards(
 * WawuAuthGuard)` on the controller: class guards run before method guards).
 *
 * Order, for the tasks that add debit routes: Nest runs guards before pipes,
 * so this check comes after the token and BEFORE body validation. An
 * idempotent replay must not check the PIN again (CONVENTIONS.md section 4,
 * rule 3), so whatever answers replays has to run before this guard.
 */
@Injectable()
export class TransactionPinGuard implements CanActivate {
  constructor(private readonly pins: TransactionPinService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>();
    const pin = takeTransactionPin(req);
    const wawuUserId = req.user?.sub;
    if (!wawuUserId) {
      throw new Error(
        'TransactionPinGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    if (pin === null) throw new MoneyError('pin_required', REQUIRED_MESSAGE);
    await this.pins.verify(wawuUserId, pin);
    return true;
  }
}

/**
 * Put on every route that moves money (and on PUT /money/pin and POST
 * /money/pin/verify): checks X-Transaction-Pin and documents the header in
 * the contract. The module that owns the route imports MoneyModule.
 *
 * A PIN is only ever checked for an open wallet (MONEY-13): the wallet gate
 * runs first, so a person with no wallet, or one still being opened, gets
 * `409 wallet_not_open` or `409 wallet_opening` and never uses up a try.
 */
export function RequireTransactionPin(): MethodDecorator {
  return applyDecorators(
    UseGuards(WalletGateGuard, TransactionPinGuard),
    TransactionPinHeader(),
  );
}
