import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AdminRole } from '../../../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Shared admin-session fixtures for the contract specs that had to change when
 * the six operator controllers moved off AdminKeyGuard (a single shared static
 * secret) onto AdminAuthGuard + AdminRolesGuard.
 *
 * Six suites now need the same four things — an AdminUser per role, a real
 * HTTP login against the real `POST /api/hub/admin/auth/login`, the
 * `ADMIN_JWT_*` secrets set, and a teardown. Copying that into six files is
 * how a role matrix quietly drifts from suite to suite; one helper means every
 * suite asserts against the same four identities.
 *
 * NOT a `*.spec.ts` file on purpose — jest's `testRegex` would pick it up as a
 * suite with no tests and fail. It sits beside the other non-spec test support
 * module in this repo (src/evg-score/tests/test-jwks-server.ts).
 *
 * Every id is derived from a caller-supplied prefix so two suites can never
 * collide on the shared, deliberately non-parallel test database (README §
 * Test hygiene rules).
 */

export const ALL_ADMIN_ROLES = [
  'superadmin',
  'reviewer',
  'support',
  'finance',
] as const satisfies readonly AdminRole[];

export interface AdminFixture {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

/** One access token per role, keyed by role. */
export type AdminTokens = Record<AdminRole, string>;

/**
 * Long enough to satisfy AdminTokenService's 32-character minimum. Per-suite
 * values are still distinct because the suite passes its own slug.
 */
export function adminJwtSecrets(slug: string): {
  access: string;
  refresh: string;
} {
  return {
    access: `admin-access-secret-for-${slug}-0123456789`,
    refresh: `admin-refresh-secret-for-${slug}-0123456789`,
  };
}

/** A password that clears seed-admin's 12-character floor. */
export const ADMIN_FIXTURE_PASSWORD = 'ops-admin-auth-contract-password';

/**
 * Four admins, one per role, under `<idPrefix>-0000-4000-8000-00000000000N`.
 *
 * `idPrefix` must be 8 hex characters and unique to the calling suite;
 * `emailSlug` keeps the unique-email constraint per suite too.
 */
export function adminFixtures(
  idPrefix: string,
  emailSlug: string,
): AdminFixture[] {
  return ALL_ADMIN_ROLES.map((role, i) => ({
    id: `${idPrefix}-0000-4000-8000-00000000000${i + 1}`,
    email: `${emailSlug}-${role}@admin.test.wawu.dev`,
    name: `${emailSlug} ${role}`,
    role,
  }));
}

/** Replaces any previous run's rows, so a crashed suite cannot poison the next. */
export async function seedAdminFixtures(
  prisma: PrismaService,
  fixtures: AdminFixture[],
): Promise<void> {
  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash(ADMIN_FIXTURE_PASSWORD);
  await prisma.adminUser.deleteMany({
    where: { id: { in: fixtures.map((f) => f.id) } },
  });
  await prisma.adminUser.createMany({
    data: fixtures.map((f) => ({
      id: f.id,
      email: f.email,
      name: f.name,
      role: f.role,
      passwordHash,
    })),
  });
}

export async function deleteAdminFixtures(
  prisma: PrismaService,
  fixtures: AdminFixture[],
): Promise<void> {
  await prisma.adminUser.deleteMany({
    where: { id: { in: fixtures.map((f) => f.id) } },
  });
}

/**
 * A REAL login through the real controller, so the token under test is one
 * AdminTokenService actually minted — never one injected into the request.
 */
export async function loginAdmin(
  app: INestApplication,
  email: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/hub/admin/auth/login')
    .send({ email, password: ADMIN_FIXTURE_PASSWORD })
    .expect(200);
  return res.body.data.accessToken as string;
}

export async function loginAllAdmins(
  app: INestApplication,
  fixtures: AdminFixture[],
): Promise<AdminTokens> {
  const entries = await Promise.all(
    fixtures.map(
      async (f) => [f.role, await loginAdmin(app, f.email)] as const,
    ),
  );
  return Object.fromEntries(entries) as AdminTokens;
}

/** `Authorization` header for a bearer token, in the shape supertest wants. */
export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * The roles that must NOT reach a handler, given the ones that must.
 * Keeps a 403 assertion honest: it is derived from the allow-list rather than
 * written out beside it, so adding a role to a handler without updating the
 * spec turns a passing 403 test red instead of leaving a silent gap.
 */
export function rolesOtherThan(allowed: readonly AdminRole[]): AdminRole[] {
  return ALL_ADMIN_ROLES.filter((r) => !allowed.includes(r));
}
