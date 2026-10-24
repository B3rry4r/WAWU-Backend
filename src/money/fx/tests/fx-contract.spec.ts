import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WALLET-21: the foreign-currency routes in contract/openapi.json. Served (not
 * marked `x-wawu-served: false`), every `...Minor` figure an integer, a debit
 * carries the key and both approval headers, and the admin routes are named.
 */
type Op = {
  'x-wawu-served'?: boolean;
  'x-wawu-built-by'?: string;
  parameters?: Array<{ in: string; name: string; required?: boolean }>;
};
const spec = JSON.parse(
  readFileSync(join(__dirname, '../../../../contract/openapi.json'), 'utf8'),
) as {
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, unknown> };
};
const routes = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([m]) => ['get', 'post', 'put', 'delete'].includes(m))
    .map(([method, op]) => ({
      route: `${method.toUpperCase()} ${path.replace('/api/hub', '')}`,
      op,
    })),
);
const fx = routes.filter((r) => r.route.includes('/money/fx'));

describe('the foreign-currency contract (WALLET-21)', () => {
  it('has the customer routes and the admin routes, each served and built by WALLET-21', () => {
    expect(fx.map((r) => r.route).sort()).toEqual([
      'GET /admin/money/fx/operations',
      'GET /admin/money/fx/operations/{id}',
      'GET /admin/money/fx/people/{wawuUserId}/accounts',
      'GET /money/fx/accounts',
      'GET /money/fx/accounts/{id}',
      'GET /money/fx/accounts/{id}/transactions',
      'GET /money/fx/currencies',
      'GET /money/fx/sends/quote',
      'GET /money/fx/sends/{id}',
      'GET /money/fx/swaps/{id}',
      'POST /admin/money/fx/accounts/{id}/freeze',
      'POST /admin/money/fx/accounts/{id}/unfreeze',
      'POST /money/fx/accounts',
      'POST /money/fx/quotes',
      'POST /money/fx/sends',
      'POST /money/fx/swaps',
    ]);
    for (const { route, op } of fx) {
      expect({ route, served: op['x-wawu-served'] }).toEqual({
        route,
        served: undefined,
      });
      expect({ route, builtBy: op['x-wawu-built-by'] }).toEqual({
        route,
        builtBy: 'WALLET-21',
      });
    }
  });

  it('a swap and a send need the Idempotency-Key and the PIN or a device approval; nothing else does', () => {
    for (const { route, op } of fx) {
      const headers = (op.parameters ?? [])
        .filter((p) => p.in === 'header')
        .map((p) => p.name)
        .sort();
      const debit =
        route === 'POST /money/fx/swaps' || route === 'POST /money/fx/sends';
      expect({ route, headers }).toEqual({
        route,
        headers: debit
          ? ['Idempotency-Key', 'X-Device-Approval', 'X-Transaction-Pin']
          : [],
      });
    }
  });

  it('types every field whose name ends in Minor as an integer, and no money field as a string', () => {
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
          if (!name.endsWith('Minor')) continue;
          seen += 1;
          if (prop.type !== 'integer')
            wrong.push(`${where}/${name}: ${String(prop.type)}`);
        }
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${where}/${k}`);
    };
    walk(spec.components.schemas, '');
    expect(seen).toBeGreaterThan(30);
    expect(wrong).toEqual([]);
  });

  it('every Minor field sits beside a currency field', () => {
    const lonely: string[] = [];
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      const props = Object.keys(
        (schema as { properties?: object }).properties ?? {},
      );
      if (!props.some((p) => p.endsWith('Minor'))) continue;
      const hasCurrency = props.some((p) => /currency$/i.test(p));
      if (/^(Admin)?Fx/.test(name) && !hasCurrency) lonely.push(name);
    }
    expect(lonely).toEqual([]);
  });
});
