import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { WalletGateGuard } from '../gate/wallet-gate';
import { ApprovalHeaders, TransactionPinHeader } from '../money-contract';
import { MoneyError } from '../money-error';
import {
  ApprovalDeviceService,
  deviceApprovalRefused,
} from './approval-device.service';
import { TransactionPinService } from './transaction-pin.service';

/** The one place a transaction PIN may travel (CONVENTIONS.md section 5). Lower case, as Node keys headers. */
export const TRANSACTION_PIN_HEADER = 'x-transaction-pin';

/** Four digits, the contract's `^[0-9]{4}$`. */
const PIN_FORMAT = /^[0-9]{4}$/;

const REQUIRED_MESSAGE = 'Enter your 4-digit transaction PIN.';

/** Where a biometric approval travels (MONEY-14, CONVENTIONS.md section 5). Lower case, as Node keys headers. */
export const DEVICE_APPROVAL_HEADER = 'x-device-approval';

/** Set by `@RequireApproval()`: this route also takes a biometric approval. */
export const ALLOWS_DEVICE_APPROVAL = 'wawu:allows-device-approval';

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
 * Takes a biometric approval out of the request (MONEY-14), as
 * takeTransactionPin does the PIN: reads `X-Device-Approval`, then deletes it
 * from `headers` and `rawHeaders`. `absent` when it was not sent; `unusable`
 * when it was sent empty or more than once.
 */
export function takeDeviceApproval(
  req: Request,
): { kind: 'absent' } | { kind: 'unusable' } | { kind: 'sent'; value: string } {
  const present = DEVICE_APPROVAL_HEADER in req.headers;
  const value: unknown = req.headers[DEVICE_APPROVAL_HEADER];
  delete req.headers[DEVICE_APPROVAL_HEADER];
  let count = 0;
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) {
    for (let i = raw.length - 2; i >= 0; i -= 2) {
      if (raw[i].toLowerCase() === DEVICE_APPROVAL_HEADER) {
        raw.splice(i, 2);
        count += 1;
      }
    }
  }
  if (!present && count === 0) return { kind: 'absent' };
  if (typeof value !== 'string' || value === '' || count > 1) {
    return { kind: 'unusable' };
  }
  return { kind: 'sent', value };
}

/**
 * The exact bytes of the body, as the phone signed them: Express keeps them
 * as `rawBody` (HUB_APP_OPTIONS). Null when there is a body this server did
 * not keep byte for byte: such a request cannot be matched to a signature.
 */
function signedBody(req: Request & { rawBody?: unknown }): Buffer | null {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const length = Number(req.headers['content-length'] ?? 0);
  const chunked = req.headers['transfer-encoding'] !== undefined;
  return length > 0 || chunked ? null : Buffer.alloc(0);
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
  constructor(
    private readonly pins: TransactionPinService,
    // MONEY-14. Both are always there in the app (MoneyModule provides and
    // exports the service); without them no biometric approval passes.
    @Optional() private readonly reflector?: Reflector,
    @Optional() private readonly devices?: ApprovalDeviceService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims; rawBody?: unknown }>();
    const approval = takeDeviceApproval(req);
    const pin = takeTransactionPin(req);
    const wawuUserId = req.user?.sub;
    if (!wawuUserId) {
      throw new Error(
        'TransactionPinGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    const allowsDevice =
      this.reflector?.get<boolean>(
        ALLOWS_DEVICE_APPROVAL,
        context.getHandler(),
      ) === true;
    if (allowsDevice && approval.kind !== 'absent') {
      // A biometric approval (MONEY-14): only it is checked. A PIN sent
      // beside it was removed unread, so no try is used either way.
      const body = signedBody(req);
      if (approval.kind === 'unusable' || body === null || !this.devices) {
        throw deviceApprovalRefused();
      }
      await this.devices.approve(wawuUserId, approval.value, {
        method: req.method,
        url: req.originalUrl,
        body,
      });
      return true;
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

/**
 * The PIN, or a biometric approval from the registered phone in
 * `X-Device-Approval` (task MONEY-14; CONVENTIONS.md section 5). For every
 * route that moves money from MONEY-14 on (the debits WALLET-07, WALLET-09
 * and MONEY-17 serve) and `POST /money/approval/verify`. The same guard runs
 * the same PIN check; with `X-Device-Approval` only the approval is checked,
 * and a refused one is `403 device_approval_refused`, which never uses a PIN
 * try (R-26). Both headers are documented, each optional; neither is
 * `pin_required`. Routes that change the PIN or add a phone keep
 * `@RequireTransactionPin()`: only the PIN does those. The wallet gate
 * (MONEY-13) runs first, as with the PIN: no wallet, no approval checked.
 */
export function RequireApproval(): MethodDecorator {
  return applyDecorators(
    SetMetadata(ALLOWS_DEVICE_APPROVAL, true),
    UseGuards(WalletGateGuard, TransactionPinGuard),
    ApprovalHeaders(),
  );
}
