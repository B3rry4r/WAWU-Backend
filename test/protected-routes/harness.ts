import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as argon2 from 'argon2';
import { Client } from 'pg';
import type { Actor } from './registry';

/**
 * Everything the protected route suite needs that is not a route: a pinned
 * environment, a sealed network, the identities probes run as, and the
 * `{{placeholder}}` context probes read and write.
 */

// ── environment ──────────────────────────────────────────────────────────

/**
 * The suite pins the configuration the lock was recorded under, which is the
 * CI configuration (.github/workflows/deploy.yml): no payment keys, no storage,
 * no AI, no partner APIs. Every value is set explicitly, empty where CI leaves
 * it unset, because ConfigModule would otherwise fill a gap from a developer's
 * own `.env` and the same code would answer differently on two machines.
 *
 * Empty behaves as unset for every reader of these variables: each one tests
 * truthiness or compares to a literal, except GEMINI_MODEL and STORAGE_REGION
 * (`?? default`), which are only read once GEMINI_API_KEY or the STORAGE_*
 * credentials are set, and those are pinned empty.
 *
 * FLUTTERWAVE_PUBLIC_KEY is the one value set to something: production sets
 * it, and payment-init responses carry it, so the lock should see the field.
 */
const PINNED_ENV: Record<string, string> = {
  FLUTTERWAVE_SECRET_KEY: '',
  FLUTTERWAVE_SECRET_HASH: '',
  FLUTTERWAVE_MODE: '',
  FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK_TEST-protected-routes-suite',
  GEMINI_API_KEY: '',
  GEMINI_MODEL: '',
  STORAGE_ENDPOINT: '',
  STORAGE_REGION: '',
  STORAGE_BUCKET: '',
  STORAGE_ACCESS_KEY_ID: '',
  STORAGE_SECRET_ACCESS_KEY: '',
  STORAGE_FORCE_PATH_STYLE: '',
  WELLAHEALTH_BASE_URL: '',
  WELLAHEALTH_CLIENT_ID: '',
  WELLAHEALTH_CLIENT_SECRET: '',
  WELLAHEALTH_PARTNER_CODE: '',
  WALLET_FUNDING: '',
  WAWU_ADMIN_KEY: '',
  ADMIN_WAWU_USER_IDS: '',
  WAWU_ID_INTERNAL_SERVICE_KEY: '',
  MOCK_WAWU_ID_INTERNAL_SERVICE_KEY: '',
  WAWU_ID_JWT_ISSUER: '',
  WAWU_ID_JWT_AUDIENCE: '',
  ADMIN_JWT_ACCESS_TTL: '30m',
  ADMIN_JWT_REFRESH_TTL: '7d',
};

/** Only filled in when the caller has not set them (CI and the runner do). */
const DEFAULTED_ENV: Record<string, string> = {
  ADMIN_JWT_SECRET: 'protected-routes-suite-admin-secret-00000000',
  ADMIN_JWT_REFRESH_SECRET: 'protected-routes-suite-admin-refresh-secret-0',
};

export function pinEnvironment(): () => void {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(PINNED_ENV)) {
    before.set(k, process.env[k]);
    process.env[k] = v;
  }
  for (const [k, v] of Object.entries(DEFAULTED_ENV)) {
    before.set(k, process.env[k]);
    if (!process.env[k]) process.env[k] = v;
  }
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ── network ──────────────────────────────────────────────────────────────

/**
 * Seals the process off from the internet for the duration of the suite.
 *
 * With no keys configured most adapters never call out, but a few build a
 * request anyway and only fail on the answer. Answers from the real
 * Flutterwave would make the lock depend on the network and on their uptime.
 * Every non-local fetch is refused as if the machine were offline, which is a
 * state the code already has to handle, and every refusal is recorded so the
 * report can say which routes tried.
 */
export function sealNetwork(): { attempts: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const attempts: string[] = [];
  const sealed: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1')
      return original(input, init);
    attempts.push(url);
    return Promise.reject(
      new TypeError(
        `fetch failed (sealed by the protected route suite: ${host})`,
      ),
    );
  };
  globalThis.fetch = sealed;
  return { attempts, restore: () => (globalThis.fetch = original) };
}

// ── mock WAWU ID ─────────────────────────────────────────────────────────

export const WAWU_ID_BASE = (
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001'
).replace(/\/+$/, '');

async function healthy(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${WAWU_ID_BASE}/health`)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Reuses a running mock WAWU ID, or starts one on the configured port. */
export async function ensureMockWawuId(): Promise<ChildProcess | null> {
  if (await healthy(1000)) return null;
  const child = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '../../mock-wawu-id'),
    env: {
      ...process.env,
      MOCK_WAWU_ID_PORT: new URL(WAWU_ID_BASE).port || '4001',
    },
    stdio: 'ignore',
  });
  if (!(await healthy(15000))) {
    child.kill();
    throw new Error(`mock-wawu-id did not become healthy at ${WAWU_ID_BASE}`);
  }
  return child;
}

export interface Identity {
  sub: string;
  token: string;
}

/**
 * A fresh WAWU ID for one run. Nothing else touches it, so no other spec can
 * move a balance or a slot under a probe (README, "Why not parallel").
 */
export async function registerIdentity(
  label: string,
  nonce: string,
  index: number,
): Promise<Identity> {
  const res = await fetch(`${WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Protected ${label}`,
      email: `protected-routes-${label}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce.slice(-8)}${index % 10}`,
      country: 'Nigeria',
      password: 'protected-routes-suite',
    }),
  });
  if (!res.ok)
    throw new Error(
      `mock-wawu-id register failed for ${label}: ${res.status} ${await res.text()}`,
    );
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken };
}

// ── admins ───────────────────────────────────────────────────────────────

export const ADMIN_ROLES = [
  'superadmin',
  'reviewer',
  'support',
  'finance',
] as const;
export const ADMIN_PASSWORD = 'protected-routes-suite-password';

export function adminEmail(role: string, nonce: string): string {
  return `protected-routes-${role}-${nonce}@test.wawu.dev`;
}

/** One active admin per role. Removed again by the snapshot restore. */
export async function createAdmins(
  databaseUrl: string,
  nonce: string,
): Promise<void> {
  const hash = await argon2.hash(ADMIN_PASSWORD);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const role of ADMIN_ROLES) {
      await client.query(
        `INSERT INTO "AdminUser" (id, email, "passwordHash", name, role, status, "tokenVersion", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4::"AdminRole", 'active', 0, now(), now())`,
        [adminEmail(role, nonce), hash, `Protected ${role}`, role],
      );
    }
  } finally {
    await client.end();
  }
}

// ── context ──────────────────────────────────────────────────────────────

export type Tokens = Record<Exclude<Actor, 'anonymous'>, string>;

/** Reads `data.items[0].id` style paths out of a response body. */
export function pick(body: unknown, dotted: string): unknown {
  let cur: unknown = body;
  for (const part of dotted.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) cur = (cur as Record<string, unknown> | null | undefined)?.[m[1]];
    for (const idx of m[2].match(/\d+/g) ?? [])
      cur = (cur as unknown[] | null | undefined)?.[Number(idx)];
  }
  return cur;
}

/**
 * Replaces `{{key}}` in strings, recursively. A probe that needs a value no
 * earlier probe captured fails with the name of the missing key, which is the
 * first thing to read when a capture upstream changed.
 */
export function resolve<T>(value: T, ctx: Map<string, string>): T {
  if (typeof value === 'string') {
    const whole = /^\{\{([\w.-]+)\}\}$/.exec(value);
    const sub = (key: string): string => {
      if (!ctx.has(key))
        throw new Error(
          `needs {{${key}}}, which no fixture or earlier probe provided`,
        );
      return ctx.get(key)!;
    };
    if (whole) return sub(whole[1]) as T;
    return value.replace(/\{\{([\w.-]+)\}\}/g, (_m, key: string) =>
      sub(key),
    ) as T;
  }
  if (Array.isArray(value))
    return (value as unknown[]).map((v) => resolve(v, ctx)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, ctx)]),
    ) as T;
  }
  return value;
}

export function fillPath(
  routePath: string,
  params: Record<string, string>,
): string {
  return routePath.replace(/:([A-Za-z_]\w*)/g, (_m, name: string) => {
    if (!(name in params)) throw new Error(`no value for :${name}`);
    return encodeURIComponent(params[name]);
  });
}
