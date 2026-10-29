import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * BILLS-09: `GET /bills/:id/status` must not take over any other `/bills/*` route.
 *
 * The inventory is the contract (`contract/openapi.json`, built from every controller): every GET path under
 * `/api/hub/bills/`. For each first segment a `/bills/<segment>/status` request could carry, the only GET routes that
 * can match are listed, so a route added later that clashes fails here.
 */
const contract = JSON.parse(
  readFileSync(join(__dirname, '../../../contract/openapi.json'), 'utf8'),
) as {
  paths: Record<string, Record<string, unknown>>;
};

const BILLS_GET = Object.entries(contract.paths)
  .filter(([path, ops]) => path.startsWith('/api/hub/bills/') && 'get' in ops)
  .map(([path]) => path);

function matches(pattern: string, concrete: string): boolean {
  const re = new RegExp(`^${pattern.replace(/\{[^}]+\}/g, '[^/]+')}$`);
  return re.test(concrete);
}

function routesFor(concrete: string): string[] {
  return BILLS_GET.filter((p) => matches(p, concrete)).sort();
}

describe('BILLS-09: GET /bills/:id/status against every other /bills/* route', () => {
  it('is in the contract', () => {
    expect(BILLS_GET).toContain('/api/hub/bills/{id}/status');
  });

  it('is the only GET route a bill id can reach with /status', () => {
    expect(
      routesFor('/api/hub/bills/0f8fad5b-d9cb-469f-a165-70867728950e/status'),
    ).toEqual(['/api/hub/bills/{id}/status']);
  });

  it.each([
    'categories',
    'billers',
    'validate',
    'init',
    'mine',
    'ops',
    'electricity',
  ])(
    '/bills/%s/status reaches no route but the status route (and /bills/%s itself is not it)',
    (segment) => {
      expect(routesFor(`/api/hub/bills/${segment}/status`)).toEqual([
        '/api/hub/bills/{id}/status',
      ]);
    },
  );

  it('/bills/wallet/status also matches the wallet bill read; both take a UUID on `id`, so it answers the same 400', () => {
    expect(routesFor('/api/hub/bills/wallet/status')).toEqual([
      '/api/hub/bills/wallet/{id}',
      '/api/hub/bills/{id}/status',
    ]);
  });

  it('the fixed GET routes keep their paths: /bills/mine is not read as a bill id', () => {
    expect(routesFor('/api/hub/bills/mine')).toEqual(['/api/hub/bills/mine']);
    expect(routesFor('/api/hub/bills/categories')).toEqual([
      '/api/hub/bills/categories',
    ]);
    expect(routesFor('/api/hub/bills/ops/stuck')).toEqual([
      '/api/hub/bills/ops/stuck',
    ]);
    // /bills/wallet is POST only: no GET route to take over.
    expect(routesFor('/api/hub/bills/wallet')).toEqual([]);
  });
});
