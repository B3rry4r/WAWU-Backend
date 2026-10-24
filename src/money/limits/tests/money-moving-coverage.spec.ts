import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  Controller,
  type DynamicModule,
  type INestApplication,
  Module,
  Post,
  RequestMethod,
  UseGuards,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
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
 * - Every non-GET route under `money/` moves money (and keeps the rules
 *   above) or is named in NON_MONEY_WRITES with its reason, so a debit that
 *   documents nothing and carries no PIN guard cannot hide (FIX-26).
 * - The only global guard is the throttler (FIX-26).
 *
 * The walk reads the module graph as Nest scans it: imports, `forwardRef`s,
 * dynamic modules (their `controllers`, `imports` and `providers`, given
 * directly or as a Promise), and a controller's inherited class guards and
 * class-level `@ApiResponse` (FIX-26).
 *
 * The verifier's two routes are rebuilt below as fixtures, with their
 * properly guarded versions: each fails these rules, and passes once
 * guarded. FIX-26 adds one fixture for each other shape the first round
 * could not see. The order this spec reads, and the mounting of dynamic
 * modules, are checked against what Nest does, over HTTP.
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
  // WALLET-31 (R-84): the WAWU card.
  'POST money/cards/:id/reveal':
    "reads a card's number, expiry and CVV from the issuer and shows them; nothing is stored or moved, the PIN is its approval",
  'POST money/cards/:id/unfreeze':
    'lets a frozen card be used again; no money moves, the PIN is its approval',
};

/**
 * The other writes under `money/` (a route that is not a GET), each with why
 * it moves no money. Deny by default (FIX-26, FIX-21 finding F1e): nothing on
 * a route says it moves money unless it carries the PIN guard or documents a
 * refusal only a debit answers, so a debit that carries neither cannot be
 * told from a read of its metadata. So every non-GET route under `money/`
 * must either move money (and keep the rules above) or be named here with its
 * reason. A new write under `money/` fails the spec until it is one or the
 * other, by someone who has read it.
 */
const NON_MONEY_WRITES: Readonly<Record<string, string>> = {
  // The PIN, and approving from a phone
  'POST money/pin': 'sets the first PIN; a hashed value is stored',
  'POST money/pin/reset': 'sends a reset code by text; no wallet is touched',
  'POST money/pin/reset/confirm': 'sets a new PIN with the code that was sent',
  'DELETE money/device': 'turns off approving from this phone',
  'POST money/device/challenge':
    'issues a challenge for the phone to sign; nothing is stored but the challenge',
  // Opening the wallet (R-6): identity checks, then the wallet
  'POST money/identity/bvn': "sends the BVN to the provider's identity check",
  'POST money/identity/selfie': 'sends the selfie for the identity check',
  'PUT money/identity/occupation': 'saves the occupation the opening asks for',
  'POST money/identity/documents':
    'sends identity documents for the opening, on the Nuvion provider',
  'POST money/identity/liveness':
    "asks the provider to start the opening's selfie step, on the Nuvion provider",
  'POST money/wallet/open':
    'opens the wallet after the checks; no money is in it yet',
  // Saved payees and the payout account
  'POST money/beneficiaries':
    'saves a payee; the person sends later, with a PIN',
  'DELETE money/beneficiaries/:id': 'removes a saved payee',
  'PUT money/payout-account':
    'saves or replaces the bank account earnings are paid out to, after a name check',
  // Reads sent as POSTs
  'POST money/banks/name-check':
    "asks the bank for an account's name before a send; a read",
  'POST money/transactions/:id/receipt':
    'renders a receipt of one finished transaction; a read',
  // WALLET-25: the attempt is unpaid, so nothing moves.
  'POST money/add-money/:id/cancel':
    'cancels an unpaid attempt; moves no money',
  'POST money/statements/email':
    "emails a statement of finished transactions to the person's own confirmed address; a read sent as a POST",
  // Foreign accounts (WALLET-21): opening one and asking for a rate move nothing
  'POST money/fx/accounts':
    'opens an account at the provider for the person; no money is in it yet',
  'POST money/fx/quotes':
    'asks the provider for a rate and keeps it for the person, to use once; a read sent as a POST',
  // WALLET-31 (R-84): the WAWU card. Stopping a card must not wait for a PIN.
  'POST money/cards/:id/freeze':
    "freezes one of the person's own cards at the issuer; no money moves, and a lost card is stopped at once",
  'DELETE money/cards/:id':
    "blocks one of the person's own cards for good at the issuer; no money moves, and a lost card is stopped at once",
};

/** A controller class, as a module lists it. */
type ControllerClass = { prototype: object };

/** What the walk over a module graph found. */
type ModuleWalk = {
  /** Every module class reached, static or dynamic. */
  modules: Set<unknown>;
  /** Every controller Nest mounts: a module's own and a dynamic module's `controllers`. */
  controllers: ControllerClass[];
  /** Every provider declared, a module's own and a dynamic module's. */
  providers: unknown[];
};

/**
 * Nest's own scan of the module graph (DependenciesScanner): a module's
 * imports, `forwardRef`s resolved, and a dynamic module's imports, controllers
 * and providers as well as its class's. A dynamic module's `controllers`
 * are mounted by Nest (FIX-26, FIX-21 finding F1a), and an import given as a
 * Promise of a dynamic module (`ConfigModule.forRoot()` is one) is awaited, as
 * Nest awaits it.
 */
async function walkModules(root: unknown): Promise<ModuleWalk> {
  const modules = new Set<unknown>();
  const controllers = new Set<ControllerClass>();
  const providers: unknown[] = [];
  const stack: unknown[] = [root];
  while (stack.length) {
    let mod = await stack.pop();
    if (mod && typeof mod === 'object' && 'forwardRef' in mod) {
      mod = (mod as { forwardRef: () => unknown }).forwardRef();
    }
    if (mod && typeof mod === 'object' && 'module' in mod) {
      const dynamic = mod as {
        module: unknown;
        imports?: unknown[];
        controllers?: ControllerClass[];
        providers?: unknown[];
      };
      stack.push(...(dynamic.imports ?? []));
      for (const c of dynamic.controllers ?? []) controllers.add(c);
      providers.push(...(dynamic.providers ?? []));
      mod = dynamic.module;
    }
    if (!mod || modules.has(mod)) continue;
    modules.add(mod);
    stack.push(
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ??
        []) as unknown[]),
    );
    for (const c of controllersOf(mod)) controllers.add(c);
    providers.push(
      ...((Reflect.getMetadata(MODULE_METADATA.PROVIDERS, mod) ??
        []) as unknown[]),
    );
  }
  return { modules, controllers: [...controllers], providers };
}

/** The controllers a module class declares itself (its decorator's `controllers`). */
function controllersOf(mod: unknown): ControllerClass[] {
  return (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) ??
    []) as ControllerClass[];
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

function routesOf(controllers: ControllerClass[]): Route[] {
  const routes: Route[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const proto = controller.prototype as Record<string, unknown>;
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ??
      []) as unknown[];
    // Documented on the class, the contract shows it on every route of it
    // (FIX-26, finding F1c): swagger merges the class's responses under the
    // method's, by status, so a method's own status wins.
    const classResponses = (Reflect.getMetadata(
      API_RESPONSE_METADATA,
      controller,
    ) ?? {}) as Record<string, { description?: string }>;
    for (const name of handlerNames(proto)) {
      const handler = proto[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      if (path === undefined) continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const responses = {
        ...classResponses,
        ...((Reflect.getMetadata(API_RESPONSE_METADATA, handler) ??
          {}) as Record<string, { description?: string }>),
      };
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

/**
 * A guard given as its class, as an instance of it, or as a subclass of it
 * (FIX-26, finding F1b): a subclass of the PIN guard checks a PIN, and a
 * subclass of the fees guard is the fees guard.
 */
function isGuard(guard: unknown, type: unknown): boolean {
  if (guard === type) return true;
  if (typeof type !== 'function') return false;
  if (typeof guard === 'function') return guard.prototype instanceof type;
  return typeof guard === 'object' && guard !== null && guard instanceof type;
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

/** A route at `money` itself or anywhere under `money/` (SWEEP-MONEY, FIX-26 L1: the bare `money` was missed). */
const UNDER_MONEY = /^\w+ money(\/|$)/;

/**
 * Every write under `money/` that is neither money-moving nor named: the
 * deny-by-default rule (see NON_MONEY_WRITES). A route that moves money is
 * held to the rules by `coverageFailures`, so it is not repeated here.
 */
function unnamedMoneyWrites(routes: Route[]): string[] {
  return routes
    .filter((r) => !r.key.startsWith('GET ') && UNDER_MONEY.test(r.key))
    .filter(
      (r) =>
        !movesMoney(r) &&
        !(r.key in MOVES_NO_MONEY) &&
        !(r.key in NON_MONEY_WRITES),
    )
    .map(
      (r) =>
        `${r.key}: a write under money/ that nothing on it says moves money, and is not named in NON_MONEY_WRITES (name it with its reason, or give it the PIN guard and the debit refusals)`,
    );
}

/**
 * A global guard runs before every route's own guards, so the one the app
 * has (the throttler, which uses no PIN, opens no wallet and stores nothing)
 * is the only one allowed (FIX-26, finding F1d). Nest has no per-module
 * guard: an `APP_GUARD` provider in any reachable module is global. One that
 * is not given as a class cannot be read, so it is refused too.
 */
const MAY_BE_GLOBAL: readonly unknown[] = [ThrottlerGuard];

function globalGuardFailures(walk: ModuleWalk): string[] {
  return walk.providers
    .filter(
      (p): p is { provide: unknown } =>
        typeof p === 'object' &&
        p !== null &&
        (p as { provide?: unknown }).provide === APP_GUARD,
    )
    .flatMap((p) => {
      const given = (p as { useClass?: unknown }).useClass;
      if (typeof given !== 'function') {
        return ['an APP_GUARD that is not given as a class (useClass)'];
      }
      return MAY_BE_GLOBAL.some((t) => isGuard(given, t))
        ? []
        : [`a global guard, ${given.name}, runs before every route's own`];
    });
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

// ---------------------------------------------------------------------------
// FIX-26: the route shapes FIX-21's verifier showed the spec could not see
// (F1), and the shapes that kill the four mutants of the spec's own reading
// that no fixture killed (F2). Never mounted in the app.
// ---------------------------------------------------------------------------

/** What the FIX-26 guards below record when Nest runs them, in order. */
const ran26: string[] = [];

/** The PIN guard given as an INSTANCE (`@UseGuards(new ...)`): F2, a guard instance is its class. */
class PinInstanceGuard extends TransactionPinGuard {
  constructor() {
    super(undefined as never);
  }
  override canActivate(): Promise<boolean> {
    ran26.push('PinInstanceGuard');
    return Promise.reject(new MoneyError('pin_required', 'Enter your PIN.'));
  }
}

/** A subclass of the PIN guard, given by class: F1b. */
class StrictPinGuard extends TransactionPinGuard {}

/** F2: an instance of the PIN guard, on a route documenting only the wallet gate. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix26/instance')
class InstanceGuardedDebit {
  @Post()
  @UseGuards(new PinInstanceGuard())
  @MoneyErrors(...WALLET_GATE_ERRORS)
  pay() {
    return { moved: true };
  }
}

/** F2: the class guards come from an abstract base, the controller has none of its own. */
@UseGuards(WawuAuthGuard, WalletGateGuard, TransactionPinGuard)
abstract class GuardedDebitBase {
  @Post()
  @MoneyErrors(...DEBIT_GATE_ERRORS)
  @RequireFeesSet()
  pay() {
    return { moved: true };
  }
}
@Controller('money/fix26/inherited-guards')
class InheritedGuardsDebit extends GuardedDebitBase {}

/** F2: the same with the controller's own `@UseGuards` on top of the base's (Nest runs the base's first). */
@UseGuards(WalletGateGuard, TransactionPinGuard)
abstract class PinGuardedDebitBase {
  @Post()
  @MoneyErrors(...DEBIT_GATE_ERRORS)
  @RequireFeesSet()
  pay() {
    return { moved: true };
  }
}
@UseGuards(WawuAuthGuard)
@Controller('money/fix26/inherited-and-own-guards')
class InheritedAndOwnGuardsDebit extends PinGuardedDebitBase {}

/** F1b: a subclass of the PIN guard, given by class, on a route documenting only the wallet gate. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix26/pin-subclass')
class PinSubclassDebit {
  @Post()
  @UseGuards(WalletGateGuard, StrictPinGuard)
  @MoneyErrors(...WALLET_GATE_ERRORS)
  pay() {
    return { moved: true };
  }
}

/** F1b: the same subclass ahead of the fees guard, everything documented. */
@UseGuards(WawuAuthGuard, StrictPinGuard)
@Controller('money/fix26/pin-subclass-first')
class PinSubclassFirstDebit {
  @Post()
  @MoneyErrors(...DEBIT_GATE_ERRORS)
  @RequireFeesSet()
  pay() {
    return { moved: true };
  }
}

/** The codes of a debit, documented on the CLASS with swagger's @ApiResponse (what MoneyErrors applies). */
const documentedOnClass = (...codes: MoneyErrorCode[]) =>
  MoneyErrors(...codes) as unknown as ClassDecorator;

/** F1c: the wallet gate and `pin_incorrect` documented on the class, none on the method. */
@UseGuards(WawuAuthGuard)
@documentedOnClass(...WALLET_GATE_ERRORS, 'pin_incorrect')
@Controller('money/fix26/class-documented')
class ClassDocumentedDebit {
  @Post()
  @RequireOpenWallet()
  pay() {
    return { moved: true };
  }
}

/** Swagger merges the class's responses under the method's by status: the method's 403 replaces the class's. */
@UseGuards(WawuAuthGuard)
@documentedOnClass('fees_not_set', 'limit_reached', 'pin_incorrect')
@Controller('money/fix26/class-and-method-documented')
class ClassAndMethodDocumented {
  @Post()
  @RequireOpenWallet()
  @MoneyErrors('pin_required')
  pay() {
    return { moved: true };
  }
}

/** FIX-26 L1: the same silent debit mounted at `money` itself, with no sub-path. */
@UseGuards(WawuAuthGuard)
@Controller('money')
class SilentDebitAtRoot {
  @Post()
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  pay() {
    return { moved: true };
  }
}

/** F1e: a debit that documents nothing and carries no PIN guard; only the deny-by-default list sees it. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix26/silent')
class SilentDebit {
  @Post()
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  pay() {
    return { moved: true };
  }
}

/** F1a: the same shape as the verifier's undocumented debit, reached only through a dynamic module. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix26/dynamic')
class DynamicListedDebit {
  @Post()
  @RequireTransactionPin()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_incorrect')
  pay() {
    return { moved: true };
  }
}
@Module({})
class ListingModule {
  /** `{ module, controllers }`: how a `forRoot()` lists a controller. */
  static forRoot(): DynamicModule {
    return { module: ListingModule, controllers: [DynamicListedDebit] };
  }
}

/** F1a: the same, from a dynamic module given as a Promise (Nest awaits those too). */
@UseGuards(WawuAuthGuard)
@Controller('money/fix26/async-dynamic')
class AsyncDynamicDebit {
  @Post()
  @RequireTransactionPin()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_incorrect')
  pay() {
    return { moved: true };
  }
}
@Module({})
class AsyncListingModule {
  static forRootAsync(): Promise<DynamicModule> {
    return Promise.resolve({
      module: AsyncListingModule,
      controllers: [AsyncDynamicDebit],
    });
  }
}

/** F2: a controller in a static module that only a dynamic module's `imports` reaches. */
@UseGuards(WawuAuthGuard)
@Controller('money/fix26/dynamic-import')
class ImportedViaDynamicDebit {
  @Post()
  @RequireTransactionPin()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_incorrect')
  pay() {
    return { moved: true };
  }
}
@Module({ controllers: [ImportedViaDynamicDebit] })
class BehindDynamicModule {}
@Module({})
class ImportingModule {
  static forRoot(): DynamicModule {
    return { module: ImportingModule, imports: [BehindDynamicModule] };
  }
}

/** A module graph holding the three ways a controller is reached through a dynamic module. */
@Module({
  imports: [
    ListingModule.forRoot(),
    AsyncListingModule.forRootAsync(),
    ImportingModule.forRoot(),
  ],
})
class DynamicShapesModule {}

/** F1d: global guards, as a static module's provider, a dynamic module's, and one given by a factory. */
@Module({ providers: [{ provide: APP_GUARD, useClass: StrictPinGuard }] })
class GlobalPinModule {}
@Module({})
class GlobalGateModule {
  static forRoot(): DynamicModule {
    return {
      module: GlobalGateModule,
      providers: [{ provide: APP_GUARD, useClass: WalletGateGuard }],
    };
  }
}
@Module({
  providers: [
    { provide: APP_GUARD, useFactory: () => ({ canActivate: () => true }) },
  ],
})
class GlobalFactoryModule {}
@Module({ providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }] })
class GlobalThrottlerModule {}
@Module({
  imports: [GlobalPinModule, GlobalGateModule.forRoot(), GlobalFactoryModule],
})
class GlobalShapesModule {}

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
  let walk: ModuleWalk;
  let mounted: Route[];
  const declared = routesOf(controllersOf(MoneyContractModule));

  beforeAll(async () => {
    walk = await walkModules(AppModule);
    mounted = routesOf(walk.controllers);
  });

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
    // MONEY-17 serves the payment and its quote (src/money/payments/), and
    // WALLET-07 the send to a WAWU user and WALLET-09 the send to a bank
    // account (src/money/transfers/): they left the
    // declared controller and are mounted, money-moving, here. So does
    // TIER-03's purchase of a tier, which pays through the same service
    // (src/plans/purchases/), and POINTS-04's conversion of points to cash
    // (src/points/convert/), which moves cash from WAWU's account into the
    // person's wallet. So does INBOX-16's purchase of a credit pack
    // (src/credit-purchase/wallet/), which pays through the same service.
    expect(
      mounted
        .filter(movesMoney)
        .map((r) => r.key)
        .sort(),
    ).toEqual([
      'POST bills/wallet/pay',
      // NUV-12: Capital's reservation, confirmation and withdrawal.
      'POST capital/orders',
      'POST capital/orders/:id/confirm',
      'POST capital/orders/:id/withdrawal',
      'POST chats/:chatId/money-requests/:requestId/pay',
      // INBOX-24: a private community's monthly pass pays from the wallet.
      'POST communities/:id/pass',
      'POST content/:id/unlock/wallet',
      'POST credits/purchase/wallet',
      'POST dm/send/wallet/pay',
      'POST events/orders/wallet/pay',
      'POST legal/requests/:id/pay/wallet',
      // WALLET-25, WALLET-26: add money takes fees and a PIN (a card or a bank checkout pays into the wallet).
      'POST money/add-money',
      'POST money/cards',
      'POST money/fx/sends',
      'POST money/fx/swaps',
      'POST money/payments',
      'POST money/transfers/bank',
      'POST money/transfers/wawu',
      'POST plans/purchases',
      'POST points/convert',
      'POST points/shortfall',
      'POST tips/wallet',
    ]);
    expect(mounted.map((r) => r.key)).toContain('GET money/payments/quote');
    // No declared route is left to move money: WALLET-09 served the last one.
    expect(declared.filter(movesMoney)).toEqual([]);
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

  it('the walk reads every import, a Promise of a dynamic module (ConfigModule.forRoot()) included, and the only global guard is the throttler (FIX-26)', () => {
    expect(walk.modules.has(ConfigModule)).toBe(true);
    expect(
      walk.providers.filter(
        (p) => (p as { provide?: unknown } | null)?.provide === APP_GUARD,
      ),
    ).toHaveLength(1);
    expect(globalGuardFailures(walk)).toEqual([]);
  });

  it('and none is registered in code either: nothing calls useGlobalGuards() (FIX-26)', () => {
    const SRC = join(__dirname, '..', '..', '..');
    const sources: string[] = [];
    const visit = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) visit(join(dir, e.name));
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
          sources.push(join(dir, e.name));
        }
      }
    };
    visit(SRC);
    expect(sources.length).toBeGreaterThan(100);
    expect(
      sources.filter((f) =>
        /\buseGlobalGuards\s*\(/.test(readFileSync(f, 'utf8')),
      ),
    ).toEqual([]);
  });

  it('every write under money/ moves money (and keeps the rules above) or is named with a reason: a debit that documents nothing and carries no PIN guard cannot hide (FIX-26)', () => {
    expect(unnamedMoneyWrites([...mounted, ...declared])).toEqual([]);
  });

  it('the named writes are real writes under money/ that move no money, each with a reason (a stale name is removed)', () => {
    const all = [...mounted, ...declared];
    for (const [key, why] of Object.entries(NON_MONEY_WRITES)) {
      const route = all.find((r) => r.key === key);
      expect({ key, found: route !== undefined }).toEqual({ key, found: true });
      expect({
        key,
        write: !key.startsWith('GET ') && UNDER_MONEY.test(key),
        moves: movesMoney(route!),
        alsoNamedAsPinOnly: key in MOVES_NO_MONEY,
      }).toEqual({
        key,
        write: true,
        moves: false,
        alsoNamedAsPinOnly: false,
      });
      expect(why.length).toBeGreaterThan(10);
      expect(why).not.toContain(String.fromCharCode(0x2014));
    }
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

  it('MoneyLimitsModule needs nothing from MoneyModule, so MoneyModule can import it', async () => {
    expect(
      (await walkModules(MoneyLimitsModule)).modules.has(MoneyModule),
    ).toBe(false);
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

/**
 * FIX-26: each route shape the FIX-21 verifier showed the spec could not see
 * (F1), and the readings of the spec's own that no fixture locked (F2). Each
 * fixture is read by the spec's own `routesOf` and `coverageFailures`, then
 * served over HTTP below with recording guards.
 */
describe('FIX-26: the shapes the spec could not see now fail it', () => {
  const lines = (key: string, ...problems: string[]) =>
    problems.map((p) => `${key}: ${p}`);
  const unguardedDebit = (key: string, gates: string) =>
    lines(
      key,
      `moves money (${gates}) and does not run FeesSetGuard`,
      'moves money and does not document fees_not_set',
      'moves money and does not document limit_reached',
    );

  it('a guard counts as its class when given as the class, as an instance, or as a subclass of it, and a base is not its own subclass', () => {
    const instance = new PinInstanceGuard();
    for (const g of [TransactionPinGuard, instance, StrictPinGuard]) {
      expect(isGuard(g, TransactionPinGuard)).toBe(true);
    }
    expect(
      isGuard(new StrictPinGuard(undefined as never), TransactionPinGuard),
    ).toBe(true);
    expect(isGuard(TransactionPinGuard, StrictPinGuard)).toBe(false);
    expect(isGuard(WalletGateGuard, TransactionPinGuard)).toBe(false);
    expect(isGuard(undefined, TransactionPinGuard)).toBe(false);
  });

  it('F2: a guard instance is its class (the PIN guard given as an instance makes the route a debit)', () => {
    expect(coverageFailures(routesOf([InstanceGuardedDebit]))).toEqual(
      unguardedDebit('POST money/fix26/instance', 'the PIN guard'),
    );
  });

  it('F2: class guards an abstract base carries are read, with and without the controller guards of its own', () => {
    expect(coverageFailures(routesOf([InheritedGuardsDebit]))).toEqual(
      lines(
        'POST money/fix26/inherited-guards',
        'runs WalletGateGuard before FeesSetGuard',
        'runs TransactionPinGuard before FeesSetGuard',
      ),
    );
    const own = routesOf([InheritedAndOwnGuardsDebit])[0];
    expect(own.classGuards).toEqual([
      WalletGateGuard,
      TransactionPinGuard,
      WawuAuthGuard,
    ]);
    expect(coverageFailures([own])).toEqual(
      lines(
        'POST money/fix26/inherited-and-own-guards',
        'runs WalletGateGuard before FeesSetGuard',
        'runs TransactionPinGuard before FeesSetGuard',
      ),
    );
  });

  it('F1b: a subclass of the PIN guard, given by class, is the PIN guard', () => {
    expect(coverageFailures(routesOf([PinSubclassDebit]))).toEqual(
      unguardedDebit('POST money/fix26/pin-subclass', 'the PIN guard'),
    );
    expect(coverageFailures(routesOf([PinSubclassFirstDebit]))).toEqual(
      lines(
        'POST money/fix26/pin-subclass-first',
        'runs StrictPinGuard before FeesSetGuard',
      ),
    );
  });

  it('F1c: codes documented on the class count, merged under the method by status the way swagger merges them into the contract', () => {
    expect(coverageFailures(routesOf([ClassDocumentedDebit]))).toEqual(
      unguardedDebit('POST money/fix26/class-documented', 'pin_incorrect'),
    );
    // Class: 503 fees_not_set and 403 limit_reached, pin_incorrect. Method:
    // 403 pin_required. The method's 403 replaces the class's, so
    // limit_reached is not on the route in the contract.
    expect(routesOf([ClassAndMethodDocumented])[0].documented.sort()).toEqual([
      'fees_not_set',
      'pin_required',
    ]);
  });

  it('F1a and F2: a controller listed only in a dynamic module (given directly or as a Promise), or in a static module only a dynamic module imports, is mounted and read', async () => {
    const walk = await walkModules(DynamicShapesModule);
    expect(
      walk.modules.has(ListingModule) &&
        walk.modules.has(AsyncListingModule) &&
        walk.modules.has(ImportingModule) &&
        walk.modules.has(BehindDynamicModule),
    ).toBe(true);
    const routes = routesOf(walk.controllers);
    expect(routes.map((r) => r.key).sort()).toEqual([
      'POST money/fix26/async-dynamic',
      'POST money/fix26/dynamic',
      'POST money/fix26/dynamic-import',
    ]);
    expect(coverageFailures(routes).sort()).toEqual(
      [
        ...unguardedDebit(
          'POST money/fix26/dynamic',
          'the PIN guard, pin_incorrect',
        ),
        ...unguardedDebit(
          'POST money/fix26/async-dynamic',
          'the PIN guard, pin_incorrect',
        ),
        ...unguardedDebit(
          'POST money/fix26/dynamic-import',
          'the PIN guard, pin_incorrect',
        ),
      ].sort(),
    );
  });

  it('F1d: a global guard other than the throttler fails, wherever the module is, however it is given', async () => {
    expect(
      globalGuardFailures(await walkModules(GlobalShapesModule)).sort(),
    ).toEqual(
      [
        "a global guard, StrictPinGuard, runs before every route's own",
        "a global guard, WalletGateGuard, runs before every route's own",
        'an APP_GUARD that is not given as a class (useClass)',
      ].sort(),
    );
    expect(
      globalGuardFailures(await walkModules(GlobalThrottlerModule)),
    ).toEqual([]);
  });

  it('F1e: a debit that documents nothing and carries no PIN guard passes every other rule, and the deny-by-default list names it', () => {
    const silent = routesOf([SilentDebit]);
    expect(coverageFailures(silent)).toEqual([]);
    expect(silent.map(movesMoney)).toEqual([false]);
    expect(unnamedMoneyWrites(silent)).toEqual([
      expect.stringMatching(
        /^POST money\/fix26\/silent: a write under money\/ that nothing on it says moves money/,
      ),
    ]);
    // A write at `money` itself, with no sub-path, is asked for a name too.
    const atRoot = routesOf([SilentDebitAtRoot]);
    expect(atRoot.map((r) => r.key)).toEqual(['POST money']);
    expect(unnamedMoneyWrites(atRoot)).toEqual([
      expect.stringMatching(/^POST money: a write under money\/ that/),
    ]);
    // A read, a named write and a route that moves money are not asked for a name.
    const named = routesOf(controllersOf(MoneyContractModule)).filter(
      (r) => r.key in NON_MONEY_WRITES || r.key.startsWith('GET '),
    );
    expect(unnamedMoneyWrites(named)).toEqual([]);
    expect(
      unnamedMoneyWrites(
        routesOf([ClassGuardedDebitFixed, InstanceGuardedDebit]),
      ),
    ).toEqual([]);
  });
});

/**
 * The order and the mounting the FIX-26 fixtures are read with are what Nest
 * does: every guard records itself, the PIN guards refuse as with no PIN sent
 * (`403 pin_required`), and the dynamic modules are mounted for real.
 */
describe('FIX-26: what the spec reads is what Nest runs', () => {
  let app: INestApplication<App>;
  let dynamicRoutes: Route[];
  const recorder = (name: string, refuse?: () => Error) => ({
    canActivate: () => {
      ran26.push(name);
      if (refuse) throw refuse();
      return true;
    },
  });
  const pin = () => new MoneyError('pin_required', 'Enter your PIN.');
  const REFUSES = new Set([
    'TransactionPinGuard',
    'StrictPinGuard',
    'PinInstanceGuard',
    'FeesSetGuard',
  ]);
  const STATIC = [
    InstanceGuardedDebit,
    InheritedGuardsDebit,
    InheritedAndOwnGuardsDebit,
    PinSubclassDebit,
    PinSubclassFirstDebit,
    ClassDocumentedDebit,
    ClassAndMethodDocumented,
    SilentDebit,
  ];

  beforeAll(async () => {
    dynamicRoutes = routesOf(
      (await walkModules(DynamicShapesModule)).controllers,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: STATIC,
      imports: [DynamicShapesModule],
    })
      .overrideGuard(WawuAuthGuard)
      .useValue(recorder('WawuAuthGuard'))
      .overrideGuard(WalletGateGuard)
      .useValue(recorder('WalletGateGuard'))
      .overrideGuard(TransactionPinGuard)
      .useValue(recorder('TransactionPinGuard', pin))
      .overrideGuard(StrictPinGuard)
      .useValue(recorder('StrictPinGuard', pin))
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
    ['instance', 403, 'pin_required'],
    ['inherited-guards', 403, 'pin_required'],
    ['inherited-and-own-guards', 403, 'pin_required'],
    ['pin-subclass', 403, 'pin_required'],
    ['pin-subclass-first', 403, 'pin_required'],
    ['class-documented', 201, null],
    ['class-and-method-documented', 201, null],
    ['silent', 201, null],
    ['dynamic', 403, 'pin_required'],
    ['async-dynamic', 403, 'pin_required'],
    ['dynamic-import', 403, 'pin_required'],
  ])(
    'POST money/fix26/%s answers %i %s, its guards run as the spec reads them',
    async (path, status, code) => {
      const route = [...routesOf(STATIC), ...dynamicRoutes].find(
        (r) => r.key === `POST money/fix26/${path}`,
      )!;
      expect(route).toBeDefined();
      const expected: string[] = [];
      for (const g of route.guards) {
        expected.push(guardName(g));
        if (REFUSES.has(guardName(g))) break;
      }
      ran26.length = 0;
      const res = await request(app.getHttpServer()).post(
        `/money/fix26/${path}`,
      );
      expect({
        status: res.status,
        code: (res.body as { reason?: { code?: string } }).reason?.code ?? null,
        ran: ran26,
      }).toEqual({ status, code, ran: expected });
    },
  );
});
