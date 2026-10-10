import {
  applyDecorators,
  type ArgumentsHost,
  type CanActivate,
  Catch,
  createParamDecorator,
  type ExceptionFilter,
  type ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { WalletGateGuard } from '../gate/wallet-gate';
import {
  OptionalIdempotencyKeyHeader,
  TransactionPinHeader,
} from '../money-contract';
import { MoneyError } from '../money-error';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IdempotencyService,
  IdempotentReplay,
  type IdempotencyScope,
} from '../payments/idempotency';
import {
  KEY_UNUSABLE_MESSAGE,
  pinRequestFingerprint,
} from './pin-request-keys.service';
import {
  takeDeviceApproval,
  takeTransactionPin,
  TransactionPinGuard,
} from './transaction-pin.guard';

/**
 * The guard, the filter and the two route decorators of the optional
 * Idempotency-Key on the PIN routes. The rules and the way the answer is kept
 * are in pin-request-keys.service.ts; the store is the payments' own
 * (`IdempotencyService`, MONEY-17).
 */
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
const ROUTE_KEY = 'wawu:pin-request-key-route';
const SCOPE_KEY = 'wawuPinRequestKeyScope';

type KeyedRequest = Request & {
  user?: WawuJwtClaims;
  [SCOPE_KEY]?: IdempotencyScope;
};

/**
 * Reads `Idempotency-Key` when it is sent, takes the key, and answers a
 * repeat before the PIN is checked. Use it through the two decorators below.
 * Without the header it does nothing.
 */
@Injectable()
export class PinRequestKeyGuard implements CanActivate {
  constructor(
    private readonly keys: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<KeyedRequest>();
    const route = this.reflector.get<string>(ROUTE_KEY, context.getHandler());
    const wawuUserId = req.user?.sub;
    if (!route || !wawuUserId) {
      throw new Error(
        'PinRequestKeyGuard needs a route decorator of pin-request-key.ts and a signed-in caller.',
      );
    }
    const raw = req.headers[IDEMPOTENCY_KEY_HEADER];
    if (raw === undefined) return true;
    try {
      if (typeof raw !== 'string' || !KEY_FORMAT.test(raw)) {
        throw new MoneyError('idempotency_key_required', KEY_UNUSABLE_MESSAGE);
      }
      const id = {
        wawuUserId,
        method: req.method.toUpperCase(),
        route,
        key: raw,
      };
      const scope: IdempotencyScope = {
        ...id,
        fingerprint: await pinRequestFingerprint(id, req.body),
      };
      scope.claimId = await this.keys.claim(scope);
      req[SCOPE_KEY] = scope;
      return true;
    } catch (err) {
      // Answered here, so the PIN guard never reads these: they go unread,
      // as the wallet gate drops them when it refuses.
      takeTransactionPin(req);
      takeDeviceApproval(req);
      throw err;
    }
  }
}

/**
 * On a route with a key decorator: writes a replay exactly as first sent,
 * with `Idempotent-Replayed: true`; for any other exception, gives back the
 * key this request took while it names no PIN yet (the PIN, the body or the
 * code refused it, so nothing changed), then answers as AllExceptionsFilter
 * does.
 */
@Injectable()
@Catch()
export class PinRequestKeyFilter implements ExceptionFilter {
  private readonly logger = new Logger(PinRequestKeyFilter.name);
  private readonly fallback = new AllExceptionsFilter();

  constructor(private readonly keys: IdempotencyService) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    if (exception instanceof IdempotentReplay) {
      http
        .getResponse<Response>()
        .status(exception.status)
        .set(IDEMPOTENT_REPLAYED_HEADER, 'true')
        .type('application/json; charset=utf-8')
        .send(exception.body);
      return;
    }
    const scope = http.getRequest<KeyedRequest>()[SCOPE_KEY];
    if (scope) {
      try {
        await this.keys.release(scope, true);
      } catch (err) {
        this.logger.error(
          `pin request key: a refused request's key was not given back (${err instanceof Error ? err.name : 'error'})`,
        );
      }
    }
    this.fallback.catch(exception, host);
  }
}

/** The key this request holds, or undefined when it sent none. */
export const CurrentPinRequestKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IdempotencyScope | undefined =>
    ctx.switchToHttp().getRequest<KeyedRequest>()[SCOPE_KEY],
);

/**
 * `PUT /money/pin`: the wallet gate, then the key, then the current PIN (the
 * order matters: a repeat is answered before the PIN is looked at, because
 * the PIN it was sent under stopped being the PIN when the first request
 * landed). Takes the place of `@RequireTransactionPin()` on that route.
 */
export function RequireTransactionPinWithKey(route: string): MethodDecorator {
  return applyDecorators(
    SetMetadata(ROUTE_KEY, route),
    UseGuards(WalletGateGuard, PinRequestKeyGuard, TransactionPinGuard),
    UseFilters(PinRequestKeyFilter),
    TransactionPinHeader(),
    OptionalIdempotencyKeyHeader(),
  );
}

/**
 * `POST /money/pin/reset/confirm`: the wallet gate, then the key. Takes the
 * place of `@RequireOpenWallet()` on that route.
 */
export function RequireOpenWalletWithKey(route: string): MethodDecorator {
  return applyDecorators(
    SetMetadata(ROUTE_KEY, route),
    UseGuards(WalletGateGuard, PinRequestKeyGuard),
    UseFilters(PinRequestKeyFilter),
    OptionalIdempotencyKeyHeader(),
  );
}
