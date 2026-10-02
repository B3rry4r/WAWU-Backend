// Must stay the first import: see the file for why.
import { restorePinnedEnvironment } from '../../test/protected-routes/pin-environment';
import { execSync } from 'child_process';
import { appendFileSync } from 'fs';
import type { ChildProcess } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../app.module';
import { FlutterwaveWalletClient } from '../wallet/flutterwave-wallet.client';
import { FLUTTERWAVE_WALLET_GATEWAY } from '../wallet/flutterwave-wallet.gateway';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import {
  assertDisposableDatabase,
  restoreSnapshot,
  takeSnapshot,
  type DbSnapshot,
} from '../../test/protected-routes/db-snapshot';
import {
  ADMIN_PASSWORD,
  ADMIN_ROLES,
  adminEmail,
  createAdmins,
  ensureMockWawuId,
  fillPath,
  loginSeeded,
  pick,
  registerIdentity,
  resolve,
  sealNetwork,
  type Tokens,
} from '../../test/protected-routes/harness';
import {
  loadRegistry,
  registryPath,
  lockHash,
  writeRegistry,
  type AuthKind,
  type ProtectedRoute,
  type Step,
} from '../../test/protected-routes/registry';
import {
  liveRoutes,
  type LiveRoute,
} from '../../test/protected-routes/route-table';
import { compareShape, fingerprint } from '../../test/protected-routes/shape';

/**
 * MONEY-01 / V3: the protected route regression suite.
 *
 * Every route the live web app (wawuafrica) and the admin dashboard
 * (wawu-dashboard) call today is listed in `.pipeline/protected-registry.json`
 * under `protectedRoutes`, with its auth, a probe, and the status and response
 * shape that probe got from main when the list was locked. This file is
 * generated FROM that list: one test per entry, in the registry's order, and
 * nothing route-specific is written here.
 *
 * For each route it proves:
 *
 *   1. the route is still mounted, with the same guards and admin roles;
 *   2. the auth contract holds on the wire: no token and a bad token are 401
 *      on user routes; a WAWU ID token is 401 on admin routes and an admin
 *      token is 401 on user routes; a plain user is 403 on creator routes; an
 *      admin outside the route's roles is 403;
 *   3. the probe gets the locked status, and a body whose shape matches the
 *      lock (see test/protected-routes/shape.ts for exactly what that means).
 *
 * The probes are a scenario, not isolated calls: a creator signs up, submits
 * KYC, an admin approves it, the creator lists content, a buyer unlocks it,
 * and so on. Later probes read ids earlier ones captured, so one break can
 * fail the entries after it. Read the FIRST failure.
 *
 * RE-LOCKING (PROTECTED_ROUTES_RECORD=1) rewrites every expectation from what
 * the code answers now. It is how the list was made against main and it is
 * an owner decision, never a way to make a red run green (WORKFLOW.md
 * section 9: the suite going red stops the task).
 *
 * The database is snapshotted before the first request and restored after
 * the last (test/protected-routes/db-snapshot.ts), so the run leaves no trace.
 */

const RECORD = process.env.PROTECTED_ROUTES_RECORD === '1';
/** PROTECTED_ROUTES_TRACE=<file> appends one JSON line per probe: what was sent and what came back. */
const TRACE = process.env.PROTECTED_ROUTES_TRACE;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';
process.env.DATABASE_URL = DATABASE_URL;

const ABSENT_UUID = '9f000000-0000-4000-8000-0000000004f5';
const EMPTY_BODY = '<empty>';

const file = registryPath();
const { raw, section } = loadRegistry(file);
const routes: ProtectedRoute[] = section.routes;

/** Captured ids are strings or numbers; anything else is kept as JSON. */
function asText(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
}

/** The admin roles a route refuses, if any; used for the 403 check. */
function refusedRole(
  roles: string[] | null,
): (typeof ADMIN_ROLES)[number] | null {
  if (!roles) return null;
  return ADMIN_ROLES.find((r) => !roles.includes(r)) ?? null;
}

function authKindOf(live: LiveRoute): AuthKind {
  if (live.guards.includes('AdminAuthGuard')) return 'admin';
  if (live.guards.includes('CreatorAccountGuard')) return 'creator';
  if (live.guards.includes('WawuAuthGuard')) return 'user';
  if (live.guards.includes('OptionalWawuAuthGuard')) return 'user-optional';
  return 'public';
}

describe('Protected routes (MONEY-01, V3 regression)', () => {
  let app: INestApplication;
  let live: LiveRoute[];
  let snapshot: DbSnapshot | null = null;
  let network: ReturnType<typeof sealNetwork> | null = null;
  let mock: ChildProcess | null = null;
  const tokens = {} as Tokens;
  const ctx = new Map<string, string>();
  const recorded = new Map<string, ProtectedRoute['expect']>();
  const sealedBy = new Map<string, string[]>();

  beforeAll(async () => {
    assertDisposableDatabase(DATABASE_URL);
    mock = await ensureMockWawuId();
    snapshot = await takeSnapshot(DATABASE_URL);
    network = sealNetwork();

    const nonce = `${Date.now()}`.slice(-8);
    const people = [
      'buyer',
      'creator',
      'creator2',
      'member',
      'newcomer',
    ] as const;
    for (const [i, who] of people.entries()) {
      const id = await registerIdentity(who, nonce, i);
      tokens[who] = id.token;
      ctx.set(`${who}.sub`, id.sub);
    }
    await createAdmins(DATABASE_URL, nonce);
    ctx.set('absentUuid', ABSENT_UUID);
    ctx.set('nonce', nonce);
    // Events and consultations refuse a date in the past.
    ctx.set(
      'future',
      new Date(Date.now() + 45 * 24 * 3600 * 1000).toISOString(),
    );
    ctx.set(
      'futureEnd',
      new Date(
        Date.now() + 45 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
      ).toISOString(),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The global limit is 20 requests a second (app.module.ts); this suite
      // is a burst. Throttling is not part of any route's contract here.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      // Under jest the wallet module wires its in-memory mock gateway, whose
      // balances only ever come from a funding cron that does not run here,
      // so a withdrawal could never succeed. The production client against
      // the canned Flutterwave (providers.ts) runs the code production runs.
      .overrideProvider(FLUTTERWAVE_WALLET_GATEWAY)
      .useClass(FlutterwaveWalletClient)
      .compile();
    app = moduleRef.createNestApplication();
    // The same globals src/main.ts installs, minus helmet/compression, which
    // touch headers and transfer encoding but never the body.
    app.use(cookieParser());
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    live = liveRoutes(app);

    for (const role of ADMIN_ROLES) {
      const res = await request(app.getHttpServer() as Server)
        .post('/api/hub/admin/auth/login')
        .send({ email: adminEmail(role, nonce), password: ADMIN_PASSWORD });
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `admin login for ${role} failed: ${res.status} ${JSON.stringify(res.body)}`,
        );
      }
      tokens[role] = (
        res.body as { data: { accessToken: string } }
      ).data.accessToken;
    }
    // One seeded account (prisma/seed.ts, CI seeds it too), used ONLY for
    // reads of rows nothing a protected route can create any more: the
    // seeded course enrolment.
    tokens.seeded = await loginSeeded('user@test.wawu.dev');
    ctx.set('superadmin.email', adminEmail('superadmin', nonce));
    ctx.set('adminPassword', ADMIN_PASSWORD);

    for (const step of section.setup ?? []) await runStep(step, 'setup');
  }, 120_000);

  /** Runs a setup or `before` step; a step that fails stops the run with its own error. */
  async function runStep(step: Step, where: string): Promise<void> {
    if ('sql' in step) {
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      try {
        const res = await client.query<Record<string, unknown>>(
          step.sql,
          resolve(step.values ?? [], ctx),
        );
        for (const [key, column] of Object.entries(step.capture ?? {})) {
          const value = res.rows[0]?.[column];
          if (value !== undefined && value !== null)
            ctx.set(key, asText(value));
        }
      } finally {
        await client.end();
      }
      return;
    }
    const [method, routePath] = step.api.split(' ');
    const url = `/api/hub${fillPath(routePath, resolve(step.params ?? {}, ctx))}`;
    let req = request(app.getHttpServer() as Server)
      [method.toLowerCase() as 'get'](url)
      .query(resolve(step.query ?? {}, ctx));
    if (step.as !== 'anonymous')
      req = req.set('Authorization', `Bearer ${tokens[step.as]}`);
    if (step.body !== undefined)
      req = req.send(resolve(step.body, ctx) as object);
    const res = await req;
    if (res.status >= 400 && !step.tolerate) {
      throw new Error(
        `${where} step ${step.api} as ${step.as} failed: ${res.status} ${res.text.slice(0, 300)}`,
      );
    }
    for (const [key, dotted] of Object.entries(step.capture ?? {})) {
      const value = pick(res.body, dotted);
      if (value !== undefined && value !== null) ctx.set(key, asText(value));
    }
  }

  afterAll(async () => {
    try {
      if (RECORD && recorded.size === routes.length) {
        for (const r of routes) r.expect = recorded.get(r.id);
        section.lock = {
          lockedAt: new Date().toISOString(),
          lockedAgainst: (() => {
            try {
              return execSync('git rev-parse HEAD', { cwd: __dirname })
                .toString()
                .trim();
            } catch {
              return 'unknown';
            }
          })(),
          sha256: lockHash(section),
        };
        raw.protectedRoutes = section;
        writeRegistry(file, raw);
      } else if (RECORD) {
        // A partial record is never written: a lock with holes in it would
        // pass routes it never checked.
        console.warn(
          `Not re-locking: ${recorded.size} of ${routes.length} routes recorded.`,
        );
      }
      if (sealedBy.size > 0) {
        console.info(
          `Routes that tried to reach the internet (refused, as offline):\n` +
            [...sealedBy]
              .map(
                ([id, urls]) =>
                  `  ${id}: ${[...new Set(urls.map((u) => new URL(u).host))].join(', ')}`,
              )
              .join('\n'),
        );
      }
    } finally {
      await app?.close();
      network?.restore();
      if (snapshot) await restoreSnapshot(DATABASE_URL, snapshot);
      mock?.kill();
      restorePinnedEnvironment();
    }
  }, 120_000);

  it('the registry still matches its lock (an edit without re-locking is refused)', () => {
    if (RECORD) return;
    expect(section.lock).not.toBeNull();
    expect(lockHash(section)).toBe(section.lock!.sha256);
  });

  it('every protected route is still mounted, with the same guards and admin roles', () => {
    const problems: string[] = [];
    for (const r of routes) {
      const match = live.filter(
        (l) => l.method === r.method && l.path === r.path,
      );
      if (match.length === 0) {
        problems.push(`${r.id}: no longer mounted`);
        continue;
      }
      const l = match[0];
      if (authKindOf(l) !== r.auth.kind)
        problems.push(
          `${r.id}: auth is now ${authKindOf(l)}, locked as ${r.auth.kind}`,
        );
      if (JSON.stringify(l.guards) !== JSON.stringify(r.auth.guards)) {
        problems.push(
          `${r.id}: guards are now [${l.guards.join(', ')}], locked as [${r.auth.guards.join(', ')}]`,
        );
      }
      const nowRoles = l.adminRoles ? [...l.adminRoles].sort() : null;
      const lockedRoles = r.auth.adminRoles
        ? [...r.auth.adminRoles].sort()
        : null;
      if (JSON.stringify(nowRoles) !== JSON.stringify(lockedRoles)) {
        problems.push(
          `${r.id}: admin roles are now ${JSON.stringify(nowRoles)}, locked as ${JSON.stringify(lockedRoles)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  describe.each(routes.map((r) => [r.id, r] as const))('%s', (_id, route) => {
    it('keeps its auth contract, status and response shape', async () => {
      const probe = route.probe;
      for (const step of probe.before ?? [])
        await runStep(step, `${route.id} before`);
      const params = resolve(probe.params ?? {}, ctx);
      const query = resolve(probe.query ?? {}, ctx);
      const body =
        probe.body === undefined ? undefined : resolve(probe.body, ctx);
      const url = `/api/hub${fillPath(route.path, params)}`;
      const server = app.getHttpServer() as Server;

      const send = (token: string | null) => {
        let req = request(server)
          [route.method.toLowerCase() as 'get'](url)
          .query(query);
        if (token !== null) req = req.set('Authorization', `Bearer ${token}`);
        if (body !== undefined) req = req.send(body as object);
        return req;
      };

      // 2. The auth contract. None of these requests gets past a guard, so none writes.
      const authProblems: string[] = [];
      const expectStatus = async (
        label: string,
        token: string | null,
        want: number,
      ) => {
        const res = await send(token);
        if (res.status !== want)
          authProblems.push(`${label}: expected ${want}, got ${res.status}`);
      };
      const kind = route.auth.kind;
      if (kind === 'user' || kind === 'creator') {
        await expectStatus('no token', null, 401);
        await expectStatus('malformed token', 'not-a-jwt', 401);
        await expectStatus(
          'an admin token on a user route',
          tokens.superadmin,
          401,
        );
      }
      if (kind === 'creator')
        await expectStatus('a non-creator account', tokens.buyer, 403);
      if (kind === 'admin') {
        await expectStatus('no token', null, 401);
        await expectStatus(
          'a WAWU ID token on an admin route',
          tokens.buyer,
          401,
        );
        const outside = refusedRole(route.auth.adminRoles);
        if (outside)
          await expectStatus(
            `an admin with role ${outside}`,
            tokens[outside],
            403,
          );
      }
      if (kind === 'user-optional' && probe.as !== 'anonymous') {
        const res = await send(null);
        if (res.status === 401)
          authProblems.push(
            'anonymous: optional auth now refuses a caller with no token',
          );
      }
      expect(authProblems).toEqual([]);

      // 3. The probe itself.
      const before = network!.attempts.length;
      const servedBefore = network!.served.length;
      const res = await send(
        probe.as === 'anonymous' ? null : tokens[probe.as],
      );
      const tried = network!.attempts.slice(before);
      if (tried.length) sealedBy.set(route.id, tried);

      const actual: unknown = res.text === '' ? EMPTY_BODY : res.body;
      if (TRACE) {
        appendFileSync(
          TRACE,
          `${JSON.stringify({ id: route.id, url, as: probe.as, sent: body ?? null, status: res.status, providers: network!.served.slice(servedBefore), body: res.text.slice(0, 2000) })}\n`,
        );
      }
      for (const [key, dotted] of Object.entries(probe.capture ?? {})) {
        const value = pick(res.body, dotted);
        if (value !== undefined && value !== null) ctx.set(key, asText(value));
      }

      if (RECORD) {
        recorded.set(route.id, {
          status: res.status,
          coverage:
            res.status < 400
              ? 'success'
              : res.status < 500
                ? 'refusal'
                : 'unavailable',
          shape:
            actual === EMPTY_BODY
              ? EMPTY_BODY
              : fingerprint(actual, probe.mapPaths ?? []),
        });
        return;
      }

      const lock = route.expect;
      if (!lock)
        throw new Error(
          `${route.id} has no locked expectation; the registry was never recorded`,
        );
      const detail = `${route.method} ${url} as ${probe.as} -> ${res.status} ${res.text.slice(0, 300)}`;
      if (res.status !== lock.status) {
        throw new Error(`locked status ${lock.status}, now: ${detail}`);
      }
      const problems =
        lock.shape === EMPTY_BODY
          ? actual === EMPTY_BODY
            ? []
            : ['body: locked as empty, now has content']
          : actual === EMPTY_BODY
            ? ['body: locked with content, now empty']
            : compareShape(lock.shape, actual);
      expect({ route: route.id, shapeProblems: problems }).toEqual({
        route: route.id,
        shapeProblems: [],
      });
    });
  });
});
