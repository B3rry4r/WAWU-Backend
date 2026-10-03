import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../../app.module';
import { MoneyContractModule } from '../money-contract.module';
import { MONEY_ERROR_CODES } from '../dto/money-enums';
import { MONEY_ERROR_STATUS } from '../money-contract';
import { WalletController } from '../../wallet/wallet.controller';
import { MoneyPinController } from '../pin/money-pin.controller';

/**
 * THE NAIRA WALLET CONTRACT IS DECLARED BEFORE IT IS SERVED (task MONEY-04).
 *
 * These routes exist so the mobile app can generate its types before the
 * Fintava client does. If a declared one were reachable it would answer every
 * request with a thrown declaration, and a debit route answering 500 is a
 * money incident. So: nothing AppModule mounts may include the contract
 * module or any of its controllers, and contract/openapi.json must mark
 * every declared operation as not served and name the task that serves it.
 *
 * A task that serves routes adds them to SERVED_MONEY_ROUTES below, and the
 * tests then hold the other side too: each of those is mounted, carries no
 * "not served" marker, and still names its task.
 */

/** Money routes a mounted module serves, and the task that serves each. */
const SERVED_MONEY_ROUTES: Record<string, string> = {
  'GET /api/hub/money/pin': 'MONEY-09',
  'POST /api/hub/money/pin': 'MONEY-09',
  'PUT /api/hub/money/pin': 'MONEY-09',
  'POST /api/hub/money/pin/verify': 'MONEY-09',
  'GET /api/hub/money/wallet/balance': 'MONEY-11',
  'GET /api/hub/money/identity': 'KYC-01',
  'POST /api/hub/money/identity/bvn': 'KYC-01',
  'PUT /api/hub/money/identity/occupation': 'KYC-01',
  'GET /api/hub/money/identity/selfie': 'KYC-02',
  'POST /api/hub/money/identity/selfie': 'KYC-02',
  'GET /api/hub/money/wallet': 'MONEY-12',
  'POST /api/hub/money/wallet/open': 'MONEY-12',
  'GET /api/hub/money/beneficiaries': 'WALLET-14',
  'POST /api/hub/money/beneficiaries': 'WALLET-14',
  'DELETE /api/hub/money/beneficiaries/{id}': 'WALLET-14',
  'GET /api/hub/money/payout-account': 'WALLET-14',
  'PUT /api/hub/money/payout-account': 'WALLET-14',
  'POST /api/hub/money/pin/reset': 'MONEY-14',
  'POST /api/hub/money/pin/reset/confirm': 'MONEY-14',
  'GET /api/hub/money/device': 'MONEY-14',
  'PUT /api/hub/money/device': 'MONEY-14',
  'DELETE /api/hub/money/device': 'MONEY-14',
  'POST /api/hub/money/device/challenge': 'MONEY-14',
  'POST /api/hub/money/approval/verify': 'MONEY-14',
  'GET /api/hub/money/transactions': 'MONEY-15',
  'GET /api/hub/money/transactions/summary': 'MONEY-15',
  'GET /api/hub/money/transactions/{id}': 'MONEY-15',
  'GET /api/hub/money/fees/quote': 'WALLET-15',
  'POST /api/hub/money/transactions/{id}/receipt': 'WALLET-18',
  'GET /api/hub/money/transactions/{id}/receipt/image': 'WALLET-18',
  'GET /api/hub/money/transactions/{id}/receipt/pdf': 'WALLET-18',
};

type ModuleRef =
  | { module?: unknown; forwardRef?: () => unknown }
  | (abstract new (...args: never[]) => unknown);

function resolveModule(entry: unknown): unknown {
  if (!entry) return null;
  if (typeof entry === 'object' && 'forwardRef' in entry) {
    return (entry as { forwardRef: () => unknown }).forwardRef();
  }
  if (typeof entry === 'object' && 'module' in entry) {
    return entry.module;
  }
  return entry;
}

/** Every module reachable from `root` through `imports`, dynamic and forwardRef ones included. */
function reachableModules(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const mod = resolveModule(stack.pop());
    if (!mod || seen.has(mod)) continue;
    seen.add(mod);
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ??
      []) as ModuleRef[];
    // A dynamic module (`{ module, imports }`) carries its own imports on the object.
    for (const entry of imports) {
      stack.push(entry);
      if (entry && typeof entry === 'object' && 'imports' in entry) {
        stack.push(...((entry as { imports?: unknown[] }).imports ?? []));
      }
    }
  }
  return seen;
}

describe('money contract (MONEY-04)', () => {
  it('AppModule mounts neither MoneyContractModule nor any of its controllers', () => {
    const mounted = reachableModules(AppModule);
    expect(mounted.has(MoneyContractModule)).toBe(false);

    // The walk itself works: it reaches the Flutterwave wallet's controller,
    // which AppModule does mount.
    const allMounted = [...mounted].flatMap(
      (mod) =>
        (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) ??
          []) as unknown[],
    );
    expect(allMounted).toContain(WalletController);
    // The served PIN routes (MONEY-09) are mounted.
    expect(allMounted).toContain(MoneyPinController);

    const declared = new Set(
      (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, MoneyContractModule) ??
        []) as unknown[],
    );
    expect(declared.size).toBeGreaterThan(0);
    for (const mod of mounted) {
      const controllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        mod as object,
      ) ?? []) as unknown[];
      for (const controller of controllers) {
        expect(declared.has(controller)).toBe(false);
      }
    }
  });

  it('every money error code has exactly one HTTP status', () => {
    expect(Object.keys(MONEY_ERROR_STATUS).sort()).toEqual(
      [...MONEY_ERROR_CODES].sort(),
    );
  });

  describe('contract/openapi.json', () => {
    const spec = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../contract/openapi.json'),
        'utf8',
      ),
    ) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    const moneyOps = Object.entries(spec.paths)
      .filter(([path]) => path.startsWith('/api/hub/money/'))
      .flatMap(([path, item]) =>
        Object.entries(item).map(([method, op]) => ({
          route: `${method.toUpperCase()} ${path}`,
          op,
        })),
      );

    it('has the declared money routes (rerun npm run contract:build if this fails)', () => {
      expect(moneyOps.length).toBeGreaterThan(0);
    });

    it('marks every declared money route as not served, with the task that serves it', () => {
      for (const { route, op } of moneyOps) {
        if (route in SERVED_MONEY_ROUTES) continue;
        expect({ route, served: op['x-wawu-served'] }).toEqual({
          route,
          served: false,
        });
        expect({ route, builtBy: typeof op['x-wawu-built-by'] }).toEqual({
          route,
          builtBy: 'string',
        });
      }
    });

    it('marks no served money route as declared, and names its task', () => {
      const routes = new Set(moneyOps.map(({ route }) => route));
      for (const route of Object.keys(SERVED_MONEY_ROUTES)) {
        expect({ route, present: routes.has(route) }).toEqual({
          route,
          present: true,
        });
      }
      for (const { route, op } of moneyOps) {
        if (!(route in SERVED_MONEY_ROUTES)) continue;
        expect({
          route,
          served: op['x-wawu-served'],
          builtBy: op['x-wawu-built-by'],
          declaredNote:
            typeof op.description === 'string' &&
            op.description.includes('not served'),
        }).toEqual({
          route,
          served: undefined,
          builtBy: SERVED_MONEY_ROUTES[route],
          declaredNote: false,
        });
      }
    });

    it('describes every money success body by a named schema, never an inline object (G-1)', () => {
      type Schema = {
        $ref?: string;
        type?: string;
        items?: Schema;
        allOf?: Schema[];
      };
      const named = (schema: Schema): boolean =>
        Boolean(schema.$ref) ||
        (schema.allOf?.length === 1 && Boolean(schema.allOf[0].$ref)) ||
        (schema.type === 'array' &&
          Boolean(schema.items) &&
          named(schema.items as Schema));
      for (const { route, op } of moneyOps) {
        const responses = op.responses as Record<
          string,
          { content?: Record<string, { schema?: Schema }> }
        >;
        for (const [status, response] of Object.entries(responses)) {
          const schema = response.content?.['application/json']?.schema;
          if (!schema) continue;
          expect({ route, status, named: named(schema) }).toEqual({
            route,
            status,
            named: true,
          });
        }
      }
    });

    it('keeps null in a nullable named field (allOf + nullable, never a $ref sibling)', () => {
      const offenders: string[] = [];
      const walk = (node: unknown, where: string): void => {
        if (Array.isArray(node))
          return node.forEach((n, i) => walk(n, `${where}/${i}`));
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        if (typeof obj.$ref === 'string' && obj.nullable) offenders.push(where);
        for (const [key, value] of Object.entries(obj))
          walk(value, `${where}/${key}`);
      };
      for (const { route, op } of moneyOps) walk(op, route);
      const moneySchemas = new Set(
        moneyOps.flatMap(
          ({ op }) =>
            JSON.stringify(op).match(/#\/components\/schemas\/\w+/g) ?? [],
        ),
      );
      for (const ref of moneySchemas) {
        const name = ref.split('/').pop() as string;
        walk(spec.components.schemas[name], name);
      }
      expect(offenders).toEqual([]);
    });

    it('requires Idempotency-Key and X-Transaction-Pin on every route that moves money', () => {
      const moving = moneyOps.filter(({ route }) =>
        [
          'POST /api/hub/money/transfers/wawu',
          'POST /api/hub/money/transfers/bank',
          'POST /api/hub/money/payments',
        ].includes(route),
      );
      expect(moving).toHaveLength(3);
      for (const { route, op } of moving) {
        const headers = (
          (op.parameters ?? []) as Array<{
            in: string;
            name: string;
            required?: boolean;
          }>
        )
          .filter((p) => p.in === 'header' && p.required)
          .map((p) => p.name)
          .sort();
        expect({ route, headers }).toEqual({
          route,
          headers: ['Idempotency-Key', 'X-Transaction-Pin'],
        });
      }
    });

    it('requires X-Transaction-Pin to change or check the PIN', () => {
      for (const route of [
        'PUT /api/hub/money/pin',
        'POST /api/hub/money/pin/verify',
      ]) {
        const op = moneyOps.find((o) => o.route === route)?.op;
        const headers = (
          (op?.parameters ?? []) as Array<{
            in: string;
            name: string;
            required?: boolean;
          }>
        )
          .filter((p) => p.in === 'header' && p.required)
          .map((p) => p.name);
        expect({ route, headers }).toEqual({
          route,
          headers: ['X-Transaction-Pin'],
        });
      }
    });

    it('types every field and parameter whose name ends in Kobo as an integer', () => {
      const wrong: string[] = [];
      let seen = 0;
      const walk = (node: unknown, where: string): void => {
        if (Array.isArray(node))
          return node.forEach((n, i) => walk(n, `${where}/${i}`));
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        if (obj.properties && typeof obj.properties === 'object') {
          for (const [name, prop] of Object.entries(
            obj.properties as Record<string, { type?: string }>,
          )) {
            if (!name.endsWith('Kobo')) continue;
            seen++;
            if (prop.type !== 'integer')
              wrong.push(`${where}/${name}: ${String(prop.type)}`);
          }
        }
        if (
          typeof obj.name === 'string' &&
          obj.name.endsWith('Kobo') &&
          'in' in obj
        ) {
          seen++;
          const type = (obj.schema as { type?: string } | undefined)?.type;
          if (type !== 'integer')
            wrong.push(`${where} parameter ${obj.name}: ${String(type)}`);
        }
        for (const [key, value] of Object.entries(obj))
          walk(value, `${where}/${key}`);
      };
      walk(spec, '');
      expect(seen).toBeGreaterThan(0);
      expect(wrong).toEqual([]);
    });

    it('never puts a PIN in a URL', () => {
      for (const { route, op } of moneyOps) {
        const inUrl = (
          (op.parameters ?? []) as Array<{ in: string; name: string }>
        ).filter(
          (p) => (p.in === 'query' || p.in === 'path') && /pin/i.test(p.name),
        );
        expect({ route, inUrl }).toEqual({ route, inUrl: [] });
      }
    });
  });
});
