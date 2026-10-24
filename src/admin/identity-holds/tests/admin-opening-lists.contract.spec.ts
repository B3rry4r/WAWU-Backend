import { randomUUID } from 'node:crypto';
import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminTokenService } from '../../auth/admin-token.service';
import { AdminIdentityHoldsListController } from '../admin-identity-holds-list.controller';
import { AdminOpeningListsService } from '../admin-opening-lists.service';
import type {
  IdentityHoldsPage,
  StuckOpeningsPage,
} from '../admin-opening-lists.type';
import { AdminWalletOpeningsController } from '../admin-wallet-openings.controller';

/**
 * OPS-26: the two lists support could not see, both read only. Wallet
 * openings that are stuck (`GET /admin/wallet-openings/stuck`) and identity
 * holds (`GET /admin/identity-holds`). Proved against a real database with
 * openings planted in it: which ones are listed, oldest first, in cursor
 * pages, the roles, what is never said (a BVN, a hash, a phone number, the
 * provider's own words) and that reading changes nothing. No provider is
 * involved.
 */

@Module({
  imports: [AdminAuthModule],
  controllers: [
    AdminIdentityHoldsListController,
    AdminWalletOpeningsController,
  ],
  providers: [AdminOpeningListsService],
})
class UnderTestModule {}

const STUCK = '/api/hub/admin/wallet-openings/stuck';
const HOLDS = '/api/hub/admin/identity-holds';
/** Far earlier than any row another spec leaves, so these come first. */
const T0 = new Date('2001-03-01T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('Admin: stuck wallet openings and identity holds (OPS-26)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const previous: Record<string, string | undefined> = {};
  const adminIds: string[] = [];
  const tokens: Partial<Record<AdminRole, string>> = {};
  const tag = randomUUID().slice(0, 8);
  const people: string[] = [];
  /** Strings that must never come back: planted in the columns the lists never read out. */
  const SECRET_PHONE_PREFIX = `+2340009${tag}`;
  const SECRET_HASH_PREFIX = `ops26-secret-hash-${tag}`;
  const WORDS = `Provider said BVN 12345678901 was refused ${tag}`;

  const http = () => request(app.getHttpServer());
  const get = (path: string, role?: AdminRole) => {
    const r = http().get(path);
    return role && tokens[role]
      ? r.set('Authorization', `Bearer ${tokens[role]}`)
      : r;
  };

  async function opening(
    key: string,
    data: {
      state: string;
      attemptStartedAt?: Date;
      bvnVerifiedAt?: Date;
      failure?: string | null;
      provider?: string | null;
      attempts?: number;
      released?: boolean;
    },
  ): Promise<string> {
    const id = randomUUID();
    people.push(id);
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: id,
        state: data.state,
        bvnHash: `${data.released ? 'released:' : ''}${SECRET_HASH_PREFIX}-${key}`,
        bvnVerifiedAt: data.bvnVerifiedAt ?? at(0),
        phone: `${SECRET_PHONE_PREFIX}${key}`,
        attempts: data.attempts ?? 1,
        attemptStartedAt: data.attemptStartedAt ?? at(0),
        failure: data.failure ?? null,
        ...(data.provider !== undefined ? { provider: data.provider } : {}),
      },
    });
    return id;
  }

  async function wallet(id: string, key: string): Promise<void> {
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: `ops26-${tag}-c-${key}`,
        walletId: `ops26-${tag}-w-${key}`,
        accountNumber: `0${Math.floor(Math.random() * 1e9)
          .toString()
          .padStart(9, '0')}`,
      },
    });
  }

  let ids: Record<string, string>;

  async function allPages<T extends { nextCursor: string | null }>(
    path: string,
    limit: number,
    role: AdminRole,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const res: request.Response = await get(
        `${path}?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        role,
      ).expect(200);
      const page = (res.body as { data: T }).data;
      out.push(page);
      cursor = page.nextCursor;
      if (!cursor) return out;
    }
    throw new Error('the list never ended');
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'ops26-open-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'ops26-open-admin-refresh-secret-0123456789abc',
    })) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        UnderTestModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.support,
      AdminRole.finance,
      AdminRole.reviewer,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email: `ops26o-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `OPS-26 ${role}`,
          role,
        },
      });
      tokens[role] = issuer.issuePair(admin).accessToken;
    }

    const recent = new Date();
    ids = {
      // Stuck: oldest first by the attempt's start.
      opening: await opening('s1', {
        state: 'opening',
        attemptStartedAt: at(0),
        attempts: 2,
      }),
      unknown: await opening('s2', {
        state: 'unknown',
        attemptStartedAt: at(10),
        failure: 'attempt_unconfirmed',
        provider: 'nuvion',
      }),
      open: await opening('s3', { state: 'open', attemptStartedAt: at(20) }),
      conflict: await opening('s4', {
        state: 'conflict',
        attemptStartedAt: recent,
        failure: WORDS,
      }),
      // Not stuck.
      fresh: await opening('n1', {
        state: 'opening',
        attemptStartedAt: recent,
      }),
      failed: await opening('n2', { state: 'failed', attemptStartedAt: at(0) }),
      expired: await opening('n3', {
        state: 'expired',
        attemptStartedAt: at(0),
        released: true,
      }),
      openWithWallet: await opening('n4', {
        state: 'open',
        attemptStartedAt: at(0),
      }),
      // Holds: longest held first.
      reviewing: await opening('h1', {
        state: 'review',
        bvnVerifiedAt: at(0),
        provider: 'nuvion',
        failure: 'entity_held_by_another_account',
      }),
      stopped: await opening('h2', {
        state: 'stopped',
        bvnVerifiedAt: at(30),
        provider: 'nuvion',
      }),
      releasedReview: await opening('n5', {
        state: 'review',
        bvnVerifiedAt: at(0),
        released: true,
      }),
      reviewWithWallet: await opening('n6', {
        state: 'review',
        bvnVerifiedAt: at(0),
      }),
    };
    await wallet(ids.openWithWallet, 'a');
    await wallet(ids.reviewWithWallet, 'b');
    await prisma.nuvionEntity.create({
      data: { wawuUserId: ids.reviewing, status: 'incomplete' },
    });
    await prisma.nuvionEntity.create({
      data: { wawuUserId: ids.stopped, status: 'suspended' },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (app) await app.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe.each([STUCK, HOLDS])('guards of %s', (path) => {
    it('no token: 401; a bad token: 401', async () => {
      await get(path).expect(401);
      await get(path).set('Authorization', 'Bearer not.a.token').expect(401);
    });

    it.each([AdminRole.finance, AdminRole.reviewer])(
      '%s is refused entirely: 403',
      async (role) => {
        await get(path, role).expect(403);
      },
    );

    it.each([AdminRole.support, AdminRole.superadmin])(
      '%s reads it: 200, no-store, a cursor page with a count and no total',
      async (role) => {
        const res = await get(path, role).expect(200);
        expect(res.headers['cache-control']).toBe('no-store');
        const data = (res.body as { data: Record<string, unknown> }).data;
        expect(Object.keys(data)).not.toContain('total');
        expect(data).toHaveProperty('count');
        expect(data).toHaveProperty('items');
        expect(data).toHaveProperty('nextCursor');
      },
    );

    it('a bad limit or a cursor this list did not give: 400, a plain sentence', async () => {
      for (const q of ['limit=0', 'limit=101', 'limit=abc']) {
        const res = await get(`${path}?${q}`, AdminRole.support).expect(400);
        expect(JSON.stringify(res.body)).toContain(
          'limit must be a whole number from 1 to 100.',
        );
      }
      for (const c of ['nope', 'o1.', 'o1.bm90LWpzb24', 'r1.AAAA']) {
        const res = await get(`${path}?cursor=${c}`, AdminRole.support).expect(
          400,
        );
        expect(JSON.stringify(res.body)).toContain(
          'cursor is not one this list gave.',
        );
      }
    });
  });

  describe('stuck openings', () => {
    it('lists openings with no wallet that wait, oldest first, and not the ones that do not', async () => {
      const pages = await allPages<StuckOpeningsPage>(
        STUCK,
        100,
        AdminRole.support,
      );
      const items = pages.flatMap((p) => p.items);
      const mine = items.filter((i) => people.includes(i.wawuUserId));
      expect(mine.map((i) => i.wawuUserId)).toEqual([
        ids.opening,
        ids.unknown,
        ids.open,
        ids.conflict,
      ]);
      expect(pages[0].stuckAfterMinutes).toBe(60);
      expect(pages[0].count).toBeGreaterThanOrEqual(4);
      expect(mine[0]).toEqual({
        wawuUserId: ids.opening,
        state: 'opening',
        failureCode: null,
        provider: 'fintava',
        attempts: 2,
        startedAt: at(0).toISOString(),
        stage: null,
      });
      expect(mine[1]).toMatchObject({
        state: 'unknown',
        failureCode: 'attempt_unconfirmed',
        provider: 'nuvion',
      });
      // A conflict is listed at once, however new; a fresh `opening` is not.
      expect(mine[3]).toMatchObject({ state: 'conflict' });
    });

    it('pages by cursor without repeating or skipping a row, whatever the page size', async () => {
      for (const size of [1, 2, 3]) {
        const pages = await allPages<StuckOpeningsPage>(
          STUCK,
          size,
          AdminRole.superadmin,
        );
        const seen = pages.flatMap((p) => p.items.map((i) => i.wawuUserId));
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.filter((id) => people.includes(id))).toEqual([
          ids.opening,
          ids.unknown,
          ids.open,
          ids.conflict,
        ]);
      }
    });
  });

  describe('identity holds', () => {
    it('lists openings in review or stopped that hold a BVN and have no wallet, longest held first', async () => {
      const pages = await allPages<IdentityHoldsPage>(
        HOLDS,
        100,
        AdminRole.support,
      );
      const items = pages.flatMap((p) => p.items);
      const mine = items.filter((i) => people.includes(i.wawuUserId));
      expect(mine.map((i) => i.wawuUserId)).toEqual([
        ids.reviewing,
        ids.stopped,
      ]);
      expect(pages[0].count).toBeGreaterThanOrEqual(2);
      expect(mine[0]).toMatchObject({
        wawuUserId: ids.reviewing,
        state: 'review',
        stage: 'needs_documents',
        failureCode: 'entity_held_by_another_account',
        provider: 'nuvion',
        heldSince: at(0).toISOString(),
      });
      expect(Date.parse(mine[0].changedAt)).not.toBeNaN();
      expect(mine[1]).toMatchObject({ state: 'stopped', stage: 'stopped' });
    });

    it('pages by cursor without repeating or skipping a row', async () => {
      for (const size of [1, 2]) {
        const pages = await allPages<IdentityHoldsPage>(
          HOLDS,
          size,
          AdminRole.superadmin,
        );
        const seen = pages.flatMap((p) => p.items.map((i) => i.wawuUserId));
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.filter((id) => people.includes(id))).toEqual([
          ids.reviewing,
          ids.stopped,
        ]);
      }
    });
  });

  describe('what is never said, and what is never changed', () => {
    it("never carries a BVN, a hash, a phone number or the provider's words, in either list", async () => {
      const mineOnly = <T extends { wawuUserId: string }>(rows: T[]) =>
        rows.filter((r) => people.includes(r.wawuUserId));
      const bodies = [
        JSON.stringify(
          mineOnly(
            (
              await allPages<StuckOpeningsPage>(STUCK, 100, AdminRole.support)
            ).flatMap((p) => p.items),
          ),
        ),
        JSON.stringify(
          mineOnly(
            (
              await allPages<IdentityHoldsPage>(HOLDS, 100, AdminRole.support)
            ).flatMap((p) => p.items),
          ),
        ),
      ];
      expect(bodies[0].length).toBeGreaterThan(100);
      expect(bodies[1].length).toBeGreaterThan(100);
      // The account ids WAWU made itself are cut out first: a random uuid can
      // hold 11 digits in a row, which is what a BVN looks like.
      const withoutIds = (text: string) =>
        people.reduce((t, id) => t.split(id).join('<id>'), text);
      for (const raw of bodies) {
        const body = withoutIds(raw);
        expect(body).not.toContain(SECRET_HASH_PREFIX);
        expect(body).not.toContain(SECRET_PHONE_PREFIX);
        expect(body).not.toContain('12345678901');
        expect(body).not.toContain('released:');
        expect(body).not.toMatch(/bvn/i);
        expect(body).not.toMatch(/\d{11}/);
      }
      // The conflict row carried free text in its failure column: only a code is ever sent.
      const stuck = (
        await allPages<StuckOpeningsPage>(STUCK, 100, AdminRole.support)
      ).flatMap((p) => p.items);
      expect(
        stuck.find((i) => i.wawuUserId === ids.conflict)?.failureCode,
      ).toBeNull();
    });

    it('is read only: no opening, wallet or entity changes by reading every page', async () => {
      const snapshot = async () =>
        JSON.stringify({
          openings: await prisma.fintavaWalletOpening.findMany({
            where: { wawuUserId: { in: people } },
            orderBy: { wawuUserId: 'asc' },
          }),
          wallets: await prisma.fintavaWallet.count({
            where: { wawuUserId: { in: people } },
          }),
          entities: await prisma.nuvionEntity.findMany({
            where: { wawuUserId: { in: people } },
            orderBy: { wawuUserId: 'asc' },
          }),
        });
      const before = await snapshot();
      await allPages(STUCK, 2, AdminRole.support);
      await allPages(HOLDS, 1, AdminRole.superadmin);
      expect(await snapshot()).toBe(before);
    });
  });
});
