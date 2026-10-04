import { createHash, randomUUID } from 'node:crypto';
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
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Request, Response } from 'express';
import type { Prisma } from '../../../generated/prisma/client';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletGateGuard } from '../gate/wallet-gate';
import { IdempotencyKeyHeader } from '../money-contract';
import { MoneyError } from '../money-error';
import { RequireApproval } from '../pin/transaction-pin.guard';
import { PaymentSettings } from './payment-config';

/**
 * Idempotency-Key on money-moving requests (task MONEY-17;
 * docs/contract/CONVENTIONS.md section 4). Fintava has no idempotency key:
 * ours is enforced here, and the reference Fintava gets is derived from our
 * own record's id, never from the app's key.
 *
 * 1. The key is scoped to (person, method, route, key). Its fingerprint is
 *    the SHA-256 of the request body as canonical JSON (keys sorted);
 *    headers are not part of it, so the PIN is not either.
 * 2. IdempotencyGuard runs after the wallet gate and BEFORE the PIN guard.
 *    It inserts the key row, `in_progress`; the primary key is the lock.
 *    A request whose insert loses finds the row: same body and finished,
 *    the stored status and body again (header `Idempotent-Replayed: true`)
 *    and the PIN is not checked, so no try is used; same body and still
 *    running, `409 idempotency_in_progress`; another body, `409
 *    idempotency_key_reused`. So taps at once reach the PIN, the quote and
 *    Fintava once, and one key moves money once.
 * 3. The service links the row to the payment it creates, in the same
 *    transaction (`attach`), before any money moves, and stores the answer
 *    when it has one (`finish`).
 * 4. A refusal before the payment exists (the PIN, the body, the quote, the
 *    funds) gives the key back: IdempotencyFilter deletes the row if it
 *    names no payment, then answers as AllExceptionsFilter does. The same key
 *    can be sent again once the cause is fixed (the right PIN, a top-up).
 */

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
const ROUTE_KEY = 'wawu:idempotent-route';
const SCOPE_KEY = 'wawuIdempotencyScope';

/** Seconds the app waits before asking again about a request still running. */
export const IN_PROGRESS_RETRY_SECONDS = 2;

export const KEY_REQUIRED_MESSAGE =
  'This payment needs an Idempotency-Key: 8 to 128 letters, digits, - or _.';
export const KEY_REUSED_MESSAGE =
  'This key was already used for a different payment. Start again to pay.';
export const IN_PROGRESS_MESSAGE =
  'This payment is still going through. Check again in a moment.';

/** Who sent which key to which route, and the fingerprint of what they sent. */
export interface IdempotencyScope {
  wawuUserId: string;
  method: string;
  route: string;
  key: string;
  fingerprint: string;
  /** Set once this request holds the key: its own claim, never a later one's. */
  claimId?: string;
}

/** JSON with every object's keys sorted, so the same body is the same text. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** SHA-256 hex of the body as canonical JSON. */
export function bodyFingerprint(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/**
 * Thrown to answer a repeat with the stored answer. IdempotencyFilter (on
 * the route) writes it exactly as it was first sent.
 */
export class IdempotentReplay extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super('idempotent replay');
    this.name = 'IdempotentReplay';
  }
}

type KeyRow = Prisma.MoneyIdempotencyKeyGetPayload<object>;

/**
 * Answers a request whose key row is still `in_progress` long after it was
 * written and names a payment (the request that wrote it died after making
 * the payment: a restart, a crash). It returns the answer the route would
 * give now from that record, or null to keep answering "in progress".
 * Registered per route by the service that owns it.
 */
export type StaleKeyResolver = (
  row: KeyRow,
) => Promise<{ status: number; body: string } | null>;

const isUniqueViolation = (e: unknown) =>
  (e as { code?: unknown } | null)?.code === 'P2002';

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly stale = new Map<
    string,
    { afterMs: number; resolve: StaleKeyResolver }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PaymentSettings,
  ) {}

  /** For a route's owner: how long a request may run, and how to answer one that died. */
  onStale(route: string, afterMs: number, resolve: StaleKeyResolver): void {
    this.stale.set(route, { afterMs, resolve });
  }

  private match(scope: IdempotencyScope) {
    return {
      wawuUserId: scope.wawuUserId,
      method: scope.method,
      route: scope.route,
      key: scope.key,
    };
  }

  /**
   * Takes the key for this request, or throws the answer a repeat gets
   * (the replay, `idempotency_key_reused`, `idempotency_in_progress`).
   */
  async claim(scope: IdempotencyScope, now = new Date()): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claimId = randomUUID();
      try {
        await this.prisma.moneyIdempotencyKey.create({
          data: {
            ...this.match(scope),
            fingerprint: scope.fingerprint,
            state: 'in_progress',
            claimId,
          },
        });
        return claimId;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
      await this.answerExisting(scope, now);
    }
    throw this.inProgress();
  }

  /**
   * What a repeat gets from the row already there. Returns (so the caller
   * may claim again) only when that row was a dead claim: never linked to a
   * payment, and older than the route's longest request.
   */
  private async answerExisting(
    scope: IdempotencyScope,
    now: Date,
  ): Promise<void> {
    const row = await this.prisma.moneyIdempotencyKey.findUnique({
      where: { wawuUserId_method_route_key: this.match(scope) },
    });
    if (!row) return;
    if (row.fingerprint !== scope.fingerprint) {
      throw new MoneyError('idempotency_key_reused', KEY_REUSED_MESSAGE);
    }
    if (
      row.state === 'done' &&
      row.responseStatus !== null &&
      row.responseBody !== null
    ) {
      throw new IdempotentReplay(row.responseStatus, row.responseBody);
    }
    const stale = this.stale.get(row.route);
    const old =
      stale !== undefined &&
      now.getTime() - row.updatedAt.getTime() >= stale.afterMs;
    if (old && row.resourceId === null) {
      // The request that took it died before making anything: nothing
      // moved, so the key is free again.
      await this.prisma.moneyIdempotencyKey.deleteMany({
        where: { ...this.match(scope), resourceId: null, state: 'in_progress' },
      });
      return;
    }
    if (old && stale) {
      const answer = await stale.resolve(row);
      if (answer) {
        await this.finish(scope, answer.status, answer.body);
        throw new IdempotentReplay(answer.status, answer.body);
      }
    }
    throw this.inProgress();
  }

  private inProgress(): MoneyError {
    return new MoneyError('idempotency_in_progress', IN_PROGRESS_MESSAGE, {
      retryAfterSeconds: IN_PROGRESS_RETRY_SECONDS,
    });
  }

  /**
   * Links the key to the record about to move money, inside the
   * transaction that creates that record. From here on a refusal no longer
   * gives the key back by itself: the payment exists.
   */
  async attach(
    tx: Prisma.TransactionClient,
    scope: IdempotencyScope,
    resourceId: string,
  ): Promise<void> {
    const { count } = await tx.moneyIdempotencyKey.updateMany({
      where: {
        ...this.match(scope),
        fingerprint: scope.fingerprint,
        state: 'in_progress',
        resourceId: null,
        ...(scope.claimId ? { claimId: scope.claimId } : {}),
      },
      data: { resourceId },
    });
    if (count !== 1) throw this.inProgress();
  }

  /** Stores the answer every repeat gets. */
  async finish(
    scope: IdempotencyScope,
    status: number,
    body: string,
  ): Promise<void> {
    await this.prisma.moneyIdempotencyKey.updateMany({
      where: { ...this.match(scope), fingerprint: scope.fingerprint },
      data: { state: 'done', responseStatus: status, responseBody: body },
    });
  }

  /**
   * Gives the key back. `unattachedOnly`: only while it names no payment
   * (a refusal before money could move); otherwise also when the service
   * knows nothing moved (Fintava said there was not enough, or the wallet is
   * frozen), so the same key may be sent again once that is fixed.
   */
  async release(scope: IdempotencyScope, unattachedOnly = false) {
    await this.prisma.moneyIdempotencyKey.deleteMany({
      where: {
        ...this.match(scope),
        fingerprint: scope.fingerprint,
        state: 'in_progress',
        ...(unattachedOnly ? { resourceId: null } : {}),
        // Only this request's own claim: a key freed as dead and taken by a
        // retry is the retry's (verifier finding 12).
        ...(scope.claimId ? { claimId: scope.claimId } : {}),
      },
    });
  }

  /** Keys older than IDEMPOTENCY_KEY_HOURS go; never sooner than a day. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'money-idempotency-purge' })
  async purge(now = new Date()): Promise<number> {
    const before = new Date(
      now.getTime() - this.settings.idempotencyKeyHours * 3_600_000,
    );
    try {
      const { count } = await this.prisma.moneyIdempotencyKey.deleteMany({
        where: { updatedAt: { lt: before } },
      });
      return count;
    } catch (e) {
      this.logger.error(
        `idempotency purge failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      return 0;
    }
  }
}

type KeyedRequest = Request & {
  user?: WawuJwtClaims;
  [SCOPE_KEY]?: IdempotencyScope;
};

/**
 * Reads `Idempotency-Key`, refuses a request without a usable one (`400
 * idempotency_key_required`), takes the key, and answers a repeat before
 * the PIN is checked. Use it through `@RequireIdempotentApproval(route)`.
 */
@Injectable()
export class IdempotencyGuard implements CanActivate {
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
        'IdempotencyGuard needs @RequireIdempotentApproval(route) and a signed-in caller.',
      );
    }
    const raw = req.headers[IDEMPOTENCY_KEY_HEADER];
    if (typeof raw !== 'string' || !KEY_FORMAT.test(raw)) {
      throw new MoneyError('idempotency_key_required', KEY_REQUIRED_MESSAGE);
    }
    const scope: IdempotencyScope = {
      wawuUserId,
      method: req.method.toUpperCase(),
      route,
      key: raw,
      fingerprint: bodyFingerprint(req.body as unknown),
    };
    scope.claimId = await this.keys.claim(scope);
    req[SCOPE_KEY] = scope;
    return true;
  }
}

/**
 * On a route with `@RequireIdempotentApproval()`: writes a replay exactly as
 * first sent, with `Idempotent-Replayed: true`; for any other exception,
 * gives back a key this request took that names no payment yet (the PIN,
 * the body, the quote or the funds refused it; nothing moved), then answers
 * exactly as the app's AllExceptionsFilter does.
 */
@Injectable()
@Catch()
export class IdempotencyFilter implements ExceptionFilter {
  private readonly logger = new Logger(IdempotencyFilter.name);
  private readonly fallback = new AllExceptionsFilter();

  constructor(private readonly keys: IdempotencyService) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    if (exception instanceof IdempotentReplay) {
      res
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
      } catch (e) {
        this.logger.error(
          `idempotency: a refused request's key was not given back (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
    this.fallback.catch(exception, host);
  }
}

/** The scope IdempotencyGuard took for this request. */
export const CurrentIdempotencyScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IdempotencyScope => {
    const scope = ctx.switchToHttp().getRequest<KeyedRequest>()[SCOPE_KEY];
    if (!scope) {
      throw new Error(
        '@CurrentIdempotencyScope() on a route without @RequireIdempotentApproval().',
      );
    }
    return scope;
  },
);

/**
 * Put on every route that moves money (MONEY-17's payments, then WALLET-07
 * and WALLET-09's sends). Guards in this order, after WawuAuthGuard on the
 * class: the wallet gate (MONEY-13: no wallet answers first, whatever was
 * sent, and takes no key), the Idempotency-Key (a repeat is answered here,
 * so its PIN is never checked again), then the PIN or a biometric approval
 * (`@RequireApproval()`, MONEY-14; the gate it brings again passes on the
 * wallet already found). Documents `Idempotency-Key` as required, and both
 * approval headers.
 */
export function RequireIdempotentApproval(route: string): MethodDecorator {
  return applyDecorators(
    SetMetadata(ROUTE_KEY, route),
    UseGuards(WalletGateGuard, IdempotencyGuard),
    RequireApproval(),
    UseFilters(IdempotencyFilter),
    IdempotencyKeyHeader(),
  );
}
