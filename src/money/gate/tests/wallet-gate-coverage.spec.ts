import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { MoneyContractModule } from '../../money-contract.module';
import { MoneyModule } from '../../money.module';
import { TransactionPinGuard } from '../../pin/transaction-pin.guard';
import { WalletGateGuard } from '../wallet-gate';

/**
 * EVERY WALLET ROUTE ANSWERS "NO WALLET YET" THE SAME WAY (task MONEY-13).
 *
 * The contract (MONEY-04) says which routes can answer `wallet_not_open`
 * and `wallet_opening`: each lists them in `@MoneyErrors(...)`. These
 * checks hold the code to it, over every controller AppModule mounts, so a
 * task that serves a wallet route later cannot forget the gate:
 *
 * - a mounted route that documents the gate codes runs WalletGateGuard, and
 *   a route that runs it documents them;
 * - on a route that takes a PIN the gate runs before the PIN, so a person
 *   with no wallet never uses up a try;
 * - every mounted `/money` route is gated, or is one of the routes below
 *   that a person without a wallet must reach;
 * - every declared, not yet served `/money` route documents the gate codes
 *   (so the first rule catches it when it is served), or is listed below.
 */

/**
 * `/money` routes that are not behind the gate, and why. A new entry needs a
 * reason a person with no wallet must be able to call it.
 */
const NOT_GATED: Record<string, string> = {
  // Open your wallet itself (R-6, KYC-01, KYC-02, MONEY-12): where the gate leads.
  'GET money/identity': 'Open your wallet: the identity step state (KYC-01)',
  'POST money/identity/bvn': 'Open your wallet: BVN and NIN (A26, KYC-01)',
  'PUT money/identity/occupation': 'Open your wallet: A5 (KYC-01)',
  'GET money/identity/selfie': 'Open your wallet: the selfie state (KYC-02)',
  'POST money/identity/selfie': 'Open your wallet: the selfie (A6, KYC-02)',
  'POST money/wallet/open':
    'Open your wallet: opening the account (A7, MONEY-12)',
  'GET money/wallet':
    'Answers 200 with state not_open or opening: how the Wallet tab finds out (MONEY-12)',
  // Declared, not served: Nigeria's bank list and a name check need no wallet.
  'GET money/banks': 'the bank list (WALLET-09) reads no wallet',
  'POST money/banks/name-check':
    'a bank name check (WALLET-09) reads no wallet',
};

/** Where @ApiResponse keeps a method's responses (@nestjs/swagger's DECORATORS.API_RESPONSE). */
const API_RESPONSE_METADATA = 'swagger/apiResponse';

type Route = {
  key: string;
  controller: string;
  handler: string;
  guards: unknown[];
  documented: string[];
};

/** Every module reachable from `root` through `imports`, dynamic and forwardRef ones included. */
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

function controllersOf(
  mod: unknown,
): Array<{ name: string; prototype: object }> {
  return (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) ??
    []) as Array<{ name: string; prototype: object }>;
}

function join(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split('/'))
    .filter((p) => p !== '')
    .join('/');
}

/** Every route of these controllers, with its guards in run order and the codes it documents. */
function routesOf(
  controllers: Array<{ name: string; prototype: object }>,
): Route[] {
  const routes: Route[] = [];
  for (const controller of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, controller) ?? '') as
      string | string[];
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | string[] | undefined;
      if (path === undefined) continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const responses = (Reflect.getMetadata(API_RESPONSE_METADATA, handler) ??
        {}) as Record<string, { description?: string }>;
      const documented = Object.values(responses).flatMap((r) =>
        (r.description ?? '')
          .replace(/^reason\.code:\s*/, '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      );
      routes.push({
        key: `${RequestMethod[method]} ${join(String(base), String(path))}`,
        controller: controller.name,
        handler: name,
        // Class guards run first, then the method's in the order listed.
        guards: [
          ...((Reflect.getMetadata(GUARDS_METADATA, controller) ??
            []) as unknown[]),
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) ??
            []) as unknown[]),
        ],
        documented,
      });
    }
  }
  return routes;
}

const documentsGate = (r: Route) =>
  r.documented.includes('wallet_not_open') ||
  r.documented.includes('wallet_opening');

describe('the wallet gate covers every wallet route (MONEY-13)', () => {
  const mounted = routesOf(
    [...reachable(AppModule)].flatMap((mod) => controllersOf(mod)),
  );
  const declared = routesOf(controllersOf(MoneyContractModule));

  it('finds the routes it checks (the walk itself works)', () => {
    const keys = mounted.map((r) => r.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'GET money/pin',
        'POST money/pin',
        'PUT money/pin',
        'POST money/pin/verify',
        'GET money/wallet/balance',
        'GET money/wallet',
        'POST money/wallet/open',
        'POST money/identity/bvn',
        // A route outside the wallet, so the walk is not money-only.
        'GET wallet',
      ]),
    );
    expect(declared.map((r) => r.key)).toEqual(
      expect.arrayContaining(['POST money/payments', 'GET money/transactions']),
    );
  });

  it('a mounted route that documents wallet_not_open or wallet_opening runs the gate, and one that runs the gate documents both', () => {
    const wrong = mounted
      .filter((r) => documentsGate(r) !== r.guards.includes(WalletGateGuard))
      .map((r) => `${r.key} (${r.controller}.${r.handler})`);
    expect(wrong).toEqual([]);
    const half = mounted
      .filter((r) => r.guards.includes(WalletGateGuard))
      .filter(
        (r) =>
          !r.documented.includes('wallet_not_open') ||
          !r.documented.includes('wallet_opening'),
      )
      .map((r) => r.key);
    expect(half).toEqual([]);
  });

  it('the gated routes today: the PIN and the balance', () => {
    expect(
      mounted
        .filter((r) => r.guards.includes(WalletGateGuard))
        .map((r) => r.key)
        .sort(),
    ).toEqual([
      'GET money/pin',
      'GET money/wallet/balance',
      'POST money/pin',
      'POST money/pin/verify',
      'PUT money/pin',
    ]);
  });

  it('on a route that takes a PIN, the gate runs first', () => {
    const pinRoutes = mounted.filter((r) =>
      r.guards.includes(TransactionPinGuard),
    );
    expect(pinRoutes.map((r) => r.key).sort()).toEqual([
      'POST money/pin/verify',
      'PUT money/pin',
    ]);
    for (const r of pinRoutes) {
      const gate = r.guards.indexOf(WalletGateGuard);
      expect({
        route: r.key,
        gateFirst: gate >= 0 && gate < r.guards.indexOf(TransactionPinGuard),
      }).toEqual({
        route: r.key,
        gateFirst: true,
      });
    }
  });

  it('every mounted /money route is gated, or is one a person with no wallet must reach', () => {
    const open = mounted
      .filter((r) => r.key.split(' ')[1].startsWith('money/'))
      .filter((r) => !r.guards.includes(WalletGateGuard))
      .filter((r) => !(r.key in NOT_GATED))
      .map((r) => r.key);
    expect(open).toEqual([]);
  });

  it('every declared /money route documents both gate codes, or is listed as needing no wallet', () => {
    const missing = declared
      .filter((r) => !(r.key in NOT_GATED))
      .filter(
        (r) =>
          !r.documented.includes('wallet_not_open') ||
          !r.documented.includes('wallet_opening'),
      )
      .map((r) => r.key);
    expect(missing).toEqual([]);
    // And no listed route is in fact gated or documents the codes.
    for (const r of [...mounted, ...declared].filter(
      (x) => x.key in NOT_GATED,
    )) {
      expect({
        route: r.key,
        gated: r.guards.includes(WalletGateGuard),
        documents: documentsGate(r),
      }).toEqual({
        route: r.key,
        gated: false,
        documents: false,
      });
    }
  });

  it('MoneyModule provides and exports the gate for the modules that add wallet routes', () => {
    const providers = (Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      MoneyModule,
    ) ?? []) as unknown[];
    const exported = (Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      MoneyModule,
    ) ?? []) as unknown[];
    expect(providers).toContain(WalletGateGuard);
    expect(exported).toContain(WalletGateGuard);
  });
});
