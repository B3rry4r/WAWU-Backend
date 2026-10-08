import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { FeesSetGuard } from '../../fees/fees-set.guard';
import { WalletGateGuard } from '../../gate/wallet-gate';
import { DEBIT_GATE_ERRORS } from '../../money-contract';
import { MoneyContractModule } from '../../money-contract.module';
import { MoneyModule } from '../../money.module';
import { TransactionPinGuard } from '../../pin/transaction-pin.guard';
import { MoneyLimitsModule } from '../money-limits.module';

/**
 * NOTHING MOVES BEFORE THE FEES ARE SET (task NUV-07, R-42), held over
 * every route AppModule mounts, so a task that serves a money-moving route
 * later cannot forget it:
 *
 * - a route that moves money is one that documents `idempotency_key_required`
 *   (CONVENTIONS section 4: every request that moves money carries an
 *   Idempotency-Key);
 * - every mounted one runs FeesSetGuard FIRST among its own guards (before
 *   the wallet gate, the Idempotency-Key record and the PIN) and documents
 *   `fees_not_set` and `limit_reached`;
 * - every mounted route that runs FeesSetGuard documents `fees_not_set`, and
 *   one that documents it runs the guard;
 * - the fee quote runs it too; the read-only routes do not;
 * - every declared, not yet served money-moving route documents both, so
 *   the rules above catch it the day it is served.
 *
 * The limit check itself (`MoneyLimits.assertMayMove`) runs inside each
 * service, where the amount is known: money-limits.contract.spec.ts.
 */

/** Where @ApiResponse keeps a method's responses (@nestjs/swagger's DECORATORS.API_RESPONSE). */
const API_RESPONSE_METADATA = 'swagger/apiResponse';

type Route = {
  key: string;
  classGuards: unknown[];
  methodGuards: unknown[];
  documented: string[];
};

function reachable(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    let mod = stack.pop();
    if (mod && typeof mod === 'object' && 'forwardRef' in mod) {
      mod = (mod as { forwardRef: () => unknown }).forwardRef();
    }
    if (mod && typeof mod === 'object' && 'module' in mod) {
      stack.push(...((mod as { imports?: unknown[] }).imports ?? []));
      mod = mod.module;
    }
    if (!mod || seen.has(mod)) continue;
    seen.add(mod);
    stack.push(
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ??
        []) as unknown[]),
    );
  }
  return seen;
}

function controllersOf(mod: unknown): Array<{ prototype: object }> {
  return (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) ??
    []) as Array<{ prototype: object }>;
}

function routesOf(controllers: Array<{ prototype: object }>): Route[] {
  const routes: Route[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      if (path === undefined) continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const responses = (Reflect.getMetadata(API_RESPONSE_METADATA, handler) ??
        {}) as Record<string, { description?: string }>;
      routes.push({
        key: `${RequestMethod[method]} ${[base, String(path)]
          .flatMap((p) => p.split('/'))
          .filter(Boolean)
          .join('/')}`,
        classGuards: (Reflect.getMetadata(GUARDS_METADATA, controller) ??
          []) as unknown[],
        methodGuards: (Reflect.getMetadata(GUARDS_METADATA, handler) ??
          []) as unknown[],
        documented: Object.values(responses).flatMap((r) =>
          (r.description ?? '')
            .replace(/^reason\.code:\s*/, '')
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean),
        ),
      });
    }
  }
  return routes;
}

const movesMoney = (r: Route) =>
  r.documented.includes('idempotency_key_required');

describe('NUV-07: every route that quotes or moves money answers fees_not_set first', () => {
  const mounted = routesOf(
    [...reachable(AppModule)].flatMap((mod) => controllersOf(mod)),
  );
  const declared = routesOf(controllersOf(MoneyContractModule));

  it('finds the routes it checks (the walk itself works)', () => {
    expect(mounted.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        'GET money/fees/quote',
        'GET money/wallet/balance',
        'GET money/transactions',
        'GET money/wallet',
        'PUT money/pin',
      ]),
    );
    // MONEY-17 serves the payment and its quote (src/money/payments/): they
    // left the declared controller and are mounted, money-moving, here.
    expect(
      mounted
        .filter(movesMoney)
        .map((r) => r.key)
        .sort(),
    ).toEqual(['POST money/payments']);
    expect(mounted.map((r) => r.key)).toContain('GET money/payments/quote');
    expect(
      declared
        .filter(movesMoney)
        .map((r) => r.key)
        .sort(),
    ).toEqual(['POST money/transfers/bank', 'POST money/transfers/wawu']);
  });

  it('a debit can answer fees_not_set and limit_reached before any money moves (DEBIT_GATE_ERRORS)', () => {
    expect(DEBIT_GATE_ERRORS).toEqual(
      expect.arrayContaining(['fees_not_set', 'limit_reached']),
    );
  });

  it('every mounted money-moving route runs FeesSetGuard before any other guard of its own, and documents fees_not_set and limit_reached', () => {
    const wrong = mounted
      .filter(movesMoney)
      .filter(
        (r) =>
          r.methodGuards[0] !== FeesSetGuard ||
          !r.documented.includes('fees_not_set') ||
          !r.documented.includes('limit_reached'),
      )
      .map((r) => r.key);
    expect(wrong).toEqual([]);
  });

  it('a mounted route documents fees_not_set exactly when it runs FeesSetGuard, and then runs it first', () => {
    const wrong = mounted
      .filter(
        (r) =>
          r.documented.includes('fees_not_set') !==
            r.methodGuards.includes(FeesSetGuard) ||
          (r.methodGuards.includes(FeesSetGuard) &&
            r.methodGuards[0] !== FeesSetGuard),
      )
      .map((r) => r.key);
    expect(wrong).toEqual([]);
  });

  it('the fee quote runs it before the wallet gate; the read-only routes do not run it', () => {
    const quote = mounted.find((r) => r.key === 'GET money/fees/quote')!;
    expect(quote.methodGuards).toEqual([FeesSetGuard, WalletGateGuard]);
    for (const key of [
      'GET money/wallet/balance',
      'GET money/transactions',
      'GET money/transactions/summary',
      'GET money/wallet',
      'GET money/statements',
    ]) {
      const route = mounted.find((r) => r.key === key)!;
      expect({
        key,
        guarded: route.methodGuards.includes(FeesSetGuard),
      }).toEqual({
        key,
        guarded: false,
      });
      expect(route.documented).not.toContain('fees_not_set');
    }
  });

  it('a PIN is never checked before the fees: on every mounted route with both, FeesSetGuard comes before TransactionPinGuard', () => {
    for (const r of mounted.filter(
      (x) =>
        x.methodGuards.includes(FeesSetGuard) &&
        x.methodGuards.includes(TransactionPinGuard),
    )) {
      expect(r.methodGuards.indexOf(FeesSetGuard)).toBeLessThan(
        r.methodGuards.indexOf(TransactionPinGuard),
      );
    }
  });

  it('every declared money-moving route documents fees_not_set and limit_reached, so it is caught the day it is served', () => {
    const missing = declared
      .filter(movesMoney)
      .filter(
        (r) =>
          !r.documented.includes('fees_not_set') ||
          !r.documented.includes('limit_reached'),
      )
      .map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it('MoneyLimitsModule needs nothing from MoneyModule, so MoneyModule can import it', () => {
    expect(reachable(MoneyLimitsModule).has(MoneyModule)).toBe(false);
  });
});
