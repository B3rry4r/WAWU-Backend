import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import type { Shape } from './shape';

/**
 * The `protectedRoutes` section of `.pipeline/protected-registry.json`.
 *
 * Everything else in that file is the August ground truth and is left exactly
 * as it was; this section is the list the regression suite runs from.
 */

/** Who a probe runs as. Identities are registered fresh by the harness on every run. */
export type Actor =
  | 'anonymous'
  | 'buyer'
  | 'creator'
  | 'creator2'
  | 'member'
  /** Registered in WAWU ID and never used here before: no profile, no rows. */
  | 'newcomer'
  /** mock-wawu-id's seeded user@test.wawu.dev, for reads of seeded rows only. */
  | 'seeded'
  | 'superadmin'
  | 'reviewer'
  | 'support'
  | 'finance';

/**
 * public          no guard at all
 * user-optional   OptionalWawuAuthGuard: anonymous is served, a token is read if sent
 * user            WawuAuthGuard: a WAWU ID access token is required
 * creator         WawuAuthGuard + CreatorAccountGuard: and the account type must be creator
 * admin           AdminAuthGuard (+ AdminRolesGuard): an admin session, never a WAWU ID token
 */
export type AuthKind =
  'public' | 'user-optional' | 'user' | 'creator' | 'admin';

/**
 * A step that puts data in place for a probe and is not itself under test:
 * a call through the API (which must succeed) or a row written directly,
 * for data no protected route creates (a legacy verification submission).
 * `{{key}}` templates work as in probes; `capture` reads the response body
 * (api) or the first returned row (sql, by column name).
 */
export type Step =
  | {
      api: string;
      as: Actor;
      params?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      capture?: Record<string, string>;
      /** The step is EXPECTED to be refused (it sets up a failure an operator queue lists). */
      tolerate?: boolean;
    }
  | { sql: string; values?: string[]; capture?: Record<string, string> };

export interface Probe {
  as: Actor;
  /** Steps run right before this probe (and its auth checks, which never write). */
  before?: Step[];
  /**
   * Steps run right after this probe has passed its checks (or been
   * recorded), for a probe whose own answer changes state the probes after
   * it rely on. A step that fails fails this probe. First use: R-40, a tier
   * change sends a published event back to review, so an admin approves it
   * again, which also proves it went back.
   */
  after?: Step[];
  /** Values for `:name` path segments. `{{key}}` is replaced from the run's context. */
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  /** Context keys to set from this response: `{ "contentId": "data.id" }`. */
  capture?: Record<string, string>;
  /** Objects whose keys are data rather than fields (see shape.ts `$map`). */
  mapPaths?: string[];
  /** Why the probe asks for what it asks for, when that is not obvious. */
  why?: string;
}

export interface Expectation {
  status: number;
  /**
   * success     the probe reached the handler and got the answer a caller acts on
   * refusal     the probe reached the handler and was refused (4xx) on purpose,
   *             because a success needs something this suite cannot have
   *             (a real Flutterwave charge, a configured partner API)
   * unavailable the handler answered 5xx/502 because an external dependency is
   *             not configured in a test environment; the status and the error
   *             envelope are still pinned
   */
  coverage: 'success' | 'refusal' | 'unavailable';
  shape: Shape;
}

export interface ProtectedRoute {
  /** `METHOD /path`, plus ` [variant]` for a second probe of the same route. */
  id: string;
  /**
   * A second entry for a route whose handler branches on state the caller
   * already has (a get-or-create read, say): the first entry pins one branch,
   * this one the other.
   */
  variant?: string;
  method: string;
  /** Without the `/api/hub` prefix, like every other path in this registry. */
  path: string;
  callers: { web: string[]; dashboard: string[] };
  auth: { kind: AuthKind; guards: string[]; adminRoles: string[] | null };
  probe: Probe;
  expect?: Expectation;
}

export interface ProtectedRoutesSection {
  version: number;
  note: string;
  wirePrefix: string;
  sources: Record<string, unknown>;
  notProtected: Record<string, unknown>;
  /** Steps run once, after the identities exist and before the first probe. */
  setup: Step[];
  lock: { lockedAt: string; lockedAgainst: string; sha256: string } | null;
  routes: ProtectedRoute[];
}

export const DEFAULT_REGISTRY_PATH = path.resolve(
  __dirname,
  '../../.pipeline/protected-registry.json',
);

/**
 * `PROTECTED_REGISTRY` lets V3 run the lock from main against a branch's code:
 * editing a branch's own copy does not change the lock it is checked against
 * (README, "Protected route suite", for what this does not cover).
 */
export function registryPath(): string {
  return process.env.PROTECTED_REGISTRY
    ? path.resolve(process.env.PROTECTED_REGISTRY)
    : DEFAULT_REGISTRY_PATH;
}

export function loadRegistry(file = registryPath()): {
  raw: Record<string, unknown>;
  section: ProtectedRoutesSection;
} {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const section = raw.protectedRoutes as ProtectedRoutesSection | undefined;
  if (!section) throw new Error(`${file} has no "protectedRoutes" section.`);
  return { raw, section };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The fingerprint the lock stores: the setup steps and every route, probe and expectation. */
export function lockHash(
  section: Pick<ProtectedRoutesSection, 'setup' | 'routes'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(stable({ setup: section.setup, routes: section.routes })),
    )
    .digest('hex');
}

/** Same formatting the file already had (2-space, no trailing newline), so a re-lock diffs only what changed. */
export function writeRegistry(
  file: string,
  raw: Record<string, unknown>,
): void {
  writeFileSync(file, JSON.stringify(raw, null, 2));
}
