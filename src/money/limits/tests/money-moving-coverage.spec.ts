import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  Controller,
  type INestApplication,
  Post,
  RequestMethod,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../../app.module';
import { WawuAuthGuard } from '../../../common/guards/wawu-auth.guard';
import type { MoneyErrorCode } from '../../dto/money-enums';
import { feesNotSet } from '../../fees/fees-not-set';
import { FeesSetGuard, RequireFeesSet } from '../../fees/fees-set.guard';
import { RequireOpenWallet, WalletGateGuard } from '../../gate/wallet-gate';
import {
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../../money-contract';
import { MoneyContractModule } from '../../money-contract.module';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import {
  RequireTransactionPin,
  TransactionPinGuard,
} from '../../pin/transaction-pin.guard';
import { MoneyLimitsModule } from '../money-limits.module';

/**
 * NOTHING MOVES BEFORE THE FEES ARE SET (task NUV-07, R-42), held over
 * every route AppModule mounts, so a task that serves a money-moving route
 * later cannot forget it. Read the way Nest runs a route (task FIX-21, NUV-07
 * verifier finding 3): the controller's guards, then the method's, with the
 * handlers a controller inherits.
 *
 * - A route MOVES MONEY when it carries a debit gate, whatever else it
 *   documents: the PIN guard (on the class or the method; `@RequireTransactionPin()`
 *   and `@RequireApproval()` bring it), or a refusal only a debit or a PIN
 *   check answers (the rest of `DEBIT_GATE_ERRORS` once the wallet gate, a
 *   provider read, a quote and a PIN reset are left out). The few routes
 *   that check a PIN and move no money are named in MOVES_NO_MONEY.
 * - Every mounted one runs FeesSetGuard with nothing but WawuAuthGuard before
 *   it (so before the wallet gate, the Idempotency-Key record and the PIN),
 *   and documents `fees_not_set` and `limit_reached`.
 * - Every other mounted route documents `fees_not_set` exactly when it runs
 *   FeesSetGuard, and then runs it as early.
 * - The fee quote runs it too; the read-only routes do not.
 * - Every declared, not yet served money-moving route documents both, so
 *   the rules above catch it the day it is served.
 *
 * The verifier's two routes are rebuilt below as fixtures, with their
 * properly guarded versions: each fails these rules, and passes once
 * guarded. The order this spec reads is checked against the order Nest
 * runs, over HTTP.
 *
 * The limit check itself (`MoneyLimits.assertMayMove`) runs inside each
 * service, where the amount is known: money-limits.contract.spec.ts and
 * read-committed.contract.spec.ts.
 */

/** Where @ApiResponse keeps a method's responses (@nestjs/swagger's DECORATORS.API_RESPONSE). */
const API_RESPONSE_METADATA = 'swagger/apiResponse';

type Route = {
  key: string;
  /** The handler's method name. */
  handler: string;
  classGuards: unknown[];
  methodGuards: unknown[];
  /** The route's own guards in the order Nest runs them: the class's, then the method's. */
  guards: unknown[];
  documented: string[];
};

/** Guards that may run before FeesSetGuard: knowing who asks uses no PIN try, opens no wallet and stores nothing. */
const MAY_RUN_BEFORE_FEES: readonly unknown[] = [WawuAuthGuard];

/**
 * The codes of DEBIT_GATE_ERRORS a route answers without moving money: the
 * wallet gate (every wallet route), `provider_unreachable` (a read from the
 * provider, the balance), `amount_out_of_range` and `fees_not_set` (a quote)
 * and `pin_not_set` (a PIN reset).
 */
const ANSWERED_WITHOUT_MOVING: readonly string[] = [
  ...WALLET_GATE_ERRORS,
  'provider_unreachable',
  'amount_out_of_range',
  'fees_not_set',
  'pin_not_set',
];

/** What only a PIN check answers. */
const PIN_CHECK_CODES: readonly MoneyErrorCode[] = [
  'pin_required',
  'pin_incorrect',
  'pin_locked',
];

/**
 * What only a request that moves money answers: every other code of
 * DEBIT_GATE_ERRORS (the Idempotency-Key, the funds, a changed quote, a
 * limit). A code added to that list later counts here unless it is named
 * above.
 */
const MOVEMENT_ONLY_CODES: readonly string[] = DEBIT_GATE_ERRORS.filter(
  (c) => !ANSWERED_WITHOUT_MOVING.includes(c) && !PIN_CHECK_CODES.includes(c),
);

/**
 * The routes that check a PIN or an approval and move no money, each with
 * what it does instead. A route is added here only when that is true; one
 * that answers a code only a movement answers cannot stay here.
 */
const MOVES_NO_MONEY: Readonly<Record<string, string>> = {
  'PUT money/pin': 'changes the PIN; the current PIN is its approval',
  'POST money/pin/verify':
    'checks the PIN for a screen that confirms the person first',
  'PUT money/device':
    'turns on approving from this phone; the PIN is its approval',
  'POST money/approval/verify':
    'checks an approval (the PIN, or the phone) for a screen that confirms the person first',
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

/** Every method name Nest scans on a controller: its own and the ones it inherits (Nest's MetadataScanner). */
function handlerNames(prototype: object): string[] {
  const names: string[] = [];
  for (
    let proto: object | null = prototype;
    proto && proto !== Object.prototype;
    proto = Reflect.getPrototypeOf(proto)
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (
        names.includes(name) ||
        name === 'constructor' ||
        !d ||
        d.get ||
        d.set ||
        typeof d.value !== 'function'
      ) {
        continue;
      }
      names.push(name);
    }
  }
  return names;
}

function routesOf(controllers: Array<{ prototype: object }>): Route[] {
  const routes: Route[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const proto = controller.prototype as Record<string, unknown>;
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ??
      []) as unknown[];
    for (const name of handlerNames(proto)) {
      const handler = proto[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      if (path === undefined) continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const responses = (Reflect.getMetadata(API_RESPONSE_METADATA, handler) ??
        {}) as Record<string, { description?: string }>;
      const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
        []) as unknown[];
      routes.push({
        handler: name,
        key: `${RequestMethod[method]} ${[base, String(path)]
          .flatMap((p) => p.split('/'))
          .filter(Boolean)
          .join('/')}`,
        classGuards,
        methodGuards,
        guards: [...classGuards, ...methodGuards],
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

/** A guard given as its class or as an instance of it. */
function isGuard(guard: unknown, type: unknown): boolean {
  return (
    guard === type ||
    (typeof type === 'function' &&
      typeof guard === 'object' &&
      guard !== null &&
      guard instanceof type)
  );
}

function guardName(guard: unknown): string {
  if (typeof guard === 'function') return guard.name;
  if (guard && typeof guard === 'object') return guard.constructor.name;
  return String(guard);
}

const runs = (r: Route, type: unknown) =>
  r.guards.some((g) => isGuard(g, type));

/** Why a route counts as moving money: the debit gates it carries. Empty when it carries none. */
function debitGates(r: Route): string[] {
  return [
    ...(runs(r, TransactionPinGuard) ? ['the PIN guard'] : []),
    ...r.documented.filter(
      (c) =>
        (PIN_CHECK_CODES as readonly string[]).includes(c) ||
        MOVEMENT_ONLY_CODES.includes(c),
    ),
  ];
}

const movesMoney = (r: Route) =>
  debitGates(r).length > 0 && !(r.key in MOVES_NO_MONEY);

/** Every way these routes break the rules above, one line each; empty when they keep them. */
function coverageFailures(routes: Route[]): string[] {
  const out: string[] = [];
  for (const r of routes) {
    const say = (problem: string) => out.push(`${r.key}: ${problem}`);
    const moving = movesMoney(r);
    const fees = r.guards.findIndex((g) => isGuard(g, FeesSetGuard));
    if (moving && fees === -1) {
      say(
        `moves money (${debitGates(r).join(', ')}) and does not run FeesSetGuard`,
      );
    }
    for (const g of new Set(r.guards.slice(0, Math.max(fees, 0)))) {
      if (!MAY_RUN_BEFORE_FEES.some((t) => isGuard(g, t))) {
        say(`runs ${guardName(g)} before FeesSetGuard`);
      }
    }
    if (moving) {
      for (const code of ['fees_not_set', 'limit_reached']) {
        if (!r.documented.includes(code)) {
          say(`moves money and does not document ${code}`);
        }
      }
    } else if (r.documented.includes('fees_not_set') !== fees >= 0) {
      say(
        fees >= 0
          ? 'runs FeesSetGuard and does not document fees_not_set'
          : 'documents fees_not_set and does not run FeesSetGuard',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The verifier's two routes (NUV-07 finding 3), rebuilt, each beside its
// properly guarded version. Never mounted in the app.
// ---------------------------------------------------------------------------

/** Finding 3, first route: the wallet gate and the PIN guard on the class, `@RequireFeesSet()` last on the method. */
@UseGuards(WawuAuthGuard, WalletGateGuard, TransactionPinGuard)
@Controller('money/fix21/class-guarded')
class ClassGuardedDebit {
  @Post()
  @MoneyErrors(...DEBIT_GATE_ERRORS)
  @RequireFeesSet()
  pay() {
    return { moved: true };
  }
}

/** The same, guarded properly: only the sign-in on the class, the gate and the PIN on the method. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix21/class-guarded-fixed')
class ClassGuardedDebitFixed {
  @Post()
  @RequireTransactionPin()
  @MoneyErrors(...DEBIT_GATE_ERRORS)
  @RequireFeesSet()
  pay() {
    return { moved: true };
  }
}

/** Finding 3, second route: a debit that documents only the wallet gate and `pin_incorrect`. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix21/undocumented')
class UndocumentedDebit {
  @Post()
  @RequireTransactionPin()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_incorrect')
  pay() {
    return { moved: true };
  }
}

/** The same, with its PIN checked in the service, so no PIN guard at all: only what it documents shows it. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix21/service-pin')
class ServicePinDebit {
  @Post()
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_incorrect')
  pay() {
    return { moved: true };
  }
}

/** The second route, guarded properly. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix21/undocumented-fixed')
class UndocumentedDebitFixed {
  @Post()
  @RequireTransactionPin()
  @MoneyErrors(...DEBIT_GATE_ERRORS)
  @RequireFeesSet()
  pay() {
    return { moved: true };
  }
}

/** The second route again, its handler inherited from a base class (Nest serves inherited handlers). */
class DebitBase {
  @Post()
  @RequireTransactionPin()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_incorrect')
  pay() {
    return { moved: true };
  }
}
@UseGuards(WawuAuthGuard)
@Controller('money/fix21/inherited')
class InheritedDebit extends DebitBase {}

const BAD = [
  ClassGuardedDebit,
  UndocumentedDebit,
  ServicePinDebit,
  InheritedDebit,
];
const FIXED = [ClassGuardedDebitFixed, UndocumentedDebitFixed];

/**
 * NUV-07's reading, kept to show the hole: method guards only, a
 * controller's own handlers only, and a route moves money only if it
 * documents idempotency_key_required.
 */
function nuv07Failures(controllers: Array<{ prototype: object }>): string[] {
  return controllers
    .flatMap((c) =>
      routesOf([c]).filter((r) =>
        Object.getOwnPropertyNames(c.prototype).includes(r.handler),
      ),
    )
    .filter((r) => {
      const fees = r.methodGuards.includes(FeesSetGuard);
      const first = r.methodGuards[0] === FeesSetGuard;
      if (r.documented.includes('idempotency_key_required')) {
        return (
          !first ||
          !r.documented.includes('fees_not_set') ||
          !r.documented.includes('limit_reached')
        );
      }
      return r.documented.includes('fees_not_set') !== fees || (fees && !first);
    })
    .map((r) => r.key);
}

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
    expect(
      declared
        .filter(movesMoney)
        .map((r) => r.key)
        .sort(),
    ).toEqual([
      'POST money/payments',
      'POST money/transfers/bank',
      'POST money/transfers/wawu',
    ]);
  });

  it('a debit can answer fees_not_set and limit_reached before any money moves (DEBIT_GATE_ERRORS)', () => {
    expect(DEBIT_GATE_ERRORS).toEqual(
      expect.arrayContaining(['fees_not_set', 'limit_reached']),
    );
  });

  it('every mounted route keeps the rules: a money-moving one runs FeesSetGuard with only WawuAuthGuard before it and documents fees_not_set and limit_reached; any other documents fees_not_set exactly when it runs the guard, as early', () => {
    expect(coverageFailures(mounted)).toEqual([]);
  });

  it('the routes that check a PIN and move no money are named, mounted, check a PIN, and answer nothing only a movement answers', () => {
    const named = mounted.filter((r) => r.key in MOVES_NO_MONEY);
    expect(named.map((r) => r.key).sort()).toEqual(
      Object.keys(MOVES_NO_MONEY).sort(),
    );
    for (const r of named) {
      expect({
        key: r.key,
        checksPin: runs(r, TransactionPinGuard),
        movementCodes: r.documented.filter((c) =>
          MOVEMENT_ONLY_CODES.includes(c),
        ),
      }).toEqual({ key: r.key, checksPin: true, movementCodes: [] });
    }
    expect([...MOVEMENT_ONLY_CODES].sort()).toEqual(
      [
        'idempotency_in_progress',
        'idempotency_key_required',
        'idempotency_key_reused',
        'insufficient_funds',
        'limit_reached',
        'quote_changed',
      ].sort(),
    );
  });

  it('the fee quote runs it before the wallet gate, its class guard (sign-in) read with it; the read-only routes do not run it', () => {
    const quote = mounted.find((r) => r.key === 'GET money/fees/quote')!;
    expect(quote.methodGuards).toEqual([FeesSetGuard, WalletGateGuard]);
    expect(quote.guards).toEqual([
      WawuAuthGuard,
      FeesSetGuard,
      WalletGateGuard,
    ]);
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
        guarded: runs(route, FeesSetGuard),
      }).toEqual({
        key,
        guarded: false,
      });
      expect(route.documented).not.toContain('fees_not_set');
    }
  });

  it('a PIN is never checked before the fees: on every mounted route with both, FeesSetGuard comes before TransactionPinGuard, class guards included', () => {
    for (const r of mounted.filter(
      (x) => runs(x, FeesSetGuard) && runs(x, TransactionPinGuard),
    )) {
      expect(r.guards.findIndex((g) => isGuard(g, FeesSetGuard))).toBeLessThan(
        r.guards.findIndex((g) => isGuard(g, TransactionPinGuard)),
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

describe("FIX-21: the verifier's two routes (NUV-07 finding 3) fail the rules, and pass once guarded properly", () => {
  it("NUV-07's reading let every one of them through (the hole, reproduced)", () => {
    expect(nuv07Failures(BAD)).toEqual([]);
  });

  it('the PIN guard on the class, @RequireFeesSet() last on the method: the wallet gate and the PIN run before the fees', () => {
    expect(coverageFailures(routesOf([ClassGuardedDebit]))).toEqual([
      'POST money/fix21/class-guarded: runs WalletGateGuard before FeesSetGuard',
      'POST money/fix21/class-guarded: runs TransactionPinGuard before FeesSetGuard',
    ]);
  });

  it('a debit that documents only the wallet gate and pin_incorrect is still a debit: no fees guard, neither code documented', () => {
    expect(coverageFailures(routesOf([UndocumentedDebit]))).toEqual([
      'POST money/fix21/undocumented: moves money (the PIN guard, pin_incorrect) and does not run FeesSetGuard',
      'POST money/fix21/undocumented: moves money and does not document fees_not_set',
      'POST money/fix21/undocumented: moves money and does not document limit_reached',
    ]);
  });

  it('the same with its PIN checked in the service, no PIN guard: what it documents is enough', () => {
    expect(coverageFailures(routesOf([ServicePinDebit]))).toEqual([
      'POST money/fix21/service-pin: moves money (pin_incorrect) and does not run FeesSetGuard',
      'POST money/fix21/service-pin: moves money and does not document fees_not_set',
      'POST money/fix21/service-pin: moves money and does not document limit_reached',
    ]);
  });

  it('the same with its handler inherited from a base class', () => {
    expect(coverageFailures(routesOf([InheritedDebit]))).toEqual([
      'POST money/fix21/inherited: moves money (the PIN guard, pin_incorrect) and does not run FeesSetGuard',
      'POST money/fix21/inherited: moves money and does not document fees_not_set',
      'POST money/fix21/inherited: moves money and does not document limit_reached',
    ]);
  });

  it('guarded properly (sign-in on the class; the PIN on the method; @RequireFeesSet() last; DEBIT_GATE_ERRORS documented): both pass', () => {
    const fixed = routesOf(FIXED);
    expect(fixed.map((r) => [r.key, movesMoney(r)])).toEqual([
      ['POST money/fix21/class-guarded-fixed', true],
      ['POST money/fix21/undocumented-fixed', true],
    ]);
    expect(coverageFailures(fixed)).toEqual([]);
  });
});

/**
 * The order this spec reads (class guards, then method guards, the last
 * decorator's first) is the order Nest runs, shown over HTTP: every guard
 * records itself, the PIN guard refuses as with no PIN sent (`403
 * pin_required`) and the fees guard as with Nuvion's fees unset (`503
 * fees_not_set`).
 */
describe('FIX-21: the order the spec reads is the order Nest runs', () => {
  let app: INestApplication<App>;
  const ran: string[] = [];
  const recorder = (name: string, refuse?: () => Error) => ({
    canActivate: () => {
      ran.push(name);
      if (refuse) throw refuse();
      return true;
    },
  });
  const REFUSES = new Set(['TransactionPinGuard', 'FeesSetGuard']);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [...BAD, ...FIXED],
    })
      .overrideGuard(WawuAuthGuard)
      .useValue(recorder('WawuAuthGuard'))
      .overrideGuard(WalletGateGuard)
      .useValue(recorder('WalletGateGuard'))
      .overrideGuard(TransactionPinGuard)
      .useValue(
        recorder(
          'TransactionPinGuard',
          () => new MoneyError('pin_required', 'Enter your PIN.'),
        ),
      )
      .overrideGuard(FeesSetGuard)
      .useValue(recorder('FeesSetGuard', feesNotSet))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['class-guarded', 403, 'pin_required'],
    ['undocumented', 403, 'pin_required'],
    ['service-pin', 201, null],
    ['inherited', 403, 'pin_required'],
    ['class-guarded-fixed', 503, 'fees_not_set'],
    ['undocumented-fixed', 503, 'fees_not_set'],
  ])(
    'POST money/fix21/%s answers %i %s, its guards run as the spec reads them',
    async (path, status, code) => {
      const route = routesOf([...BAD, ...FIXED]).find(
        (r) => r.key === `POST money/fix21/${path}`,
      )!;
      const expected: string[] = [];
      for (const g of route.guards) {
        expected.push(guardName(g));
        if (REFUSES.has(guardName(g))) break;
      }
      ran.length = 0;
      const res = await request(app.getHttpServer()).post(
        `/money/fix21/${path}`,
      );
      expect({
        status: res.status,
        code: (res.body as { reason?: { code?: string } }).reason?.code ?? null,
        ran,
      }).toEqual({ status, code, ran: expected });
    },
  );
});
