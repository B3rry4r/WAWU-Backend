// OPS-20: the admin list of the featured rail, and saving its order.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminRole } from '../../../../generated/prisma/enums';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { configureHubApp } from '../../../hub-app-config';
import { AdminTokenService } from '../../auth/admin-token.service';
import { AdminFeaturedCreatorsModule } from '../admin-featured-creators.module';
import type {
  FeaturedCreatorAdminView,
  FeaturedOrderView,
} from '../featured-creator-admin-view.type';

jest.setTimeout(120_000);

const BASE = '/api/hub/admin/featured-creators';
type Envelope<T> = { data: T };

/** WAWU ID answers for these ids only; the rest have no name there. */
const identities = new Map<
  string,
  {
    firstName: string | null;
    lastName: string | null;
    verificationTier: string;
  }
>();

describe('Admin: the featured creators rail (OPS-20)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const adminIds: string[] = [];
  const tokens: Partial<Record<AdminRole, string>> = {};
  const profileIds: string[] = [];
  const previous: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const as = (role: AdminRole) => ({ Authorization: `Bearer ${tokens[role]}` });
  const list = () => http().get(BASE).set(as(AdminRole.superadmin));
  const items = (res: request.Response) =>
    (res.body as Envelope<FeaturedCreatorAdminView[]>).data;
  const order = (ids: string[], role: AdminRole = AdminRole.superadmin) =>
    http().post(`${BASE}/order`).set(as(role)).send({ order: ids });

  async function creator(handle: string, opts: { live?: boolean } = {}) {
    const id = randomUUID();
    profileIds.push(id);
    await prisma.userProfile.create({
      data: { wawuUserId: id, accountType: 'creator', handle },
    });
    if (opts.live !== false) {
      await prisma.contentPiece.create({
        data: {
          slug: `ops20-${id}`,
          creatorWawuId: id,
          contentType: 'video',
          title: 'OPS-20 piece',
          description: 'A piece the featured rail spec makes.',
          category: 'ops20-spec',
          accessType: 'paid',
          price: 1500,
          previewAssetUrl: 'https://cdn.example.com/p.jpg',
          fullAssetUrl: 'https://cdn.example.com/f.mp4',
          status: 'live',
        },
      });
    }
    return id;
  }
  const feature = (id: string, position?: number) =>
    http()
      .put(`${BASE}/${id}`)
      .set(as(AdminRole.superadmin))
      .send(position === undefined ? {} : { position })
      .expect(200);

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'ops20-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'ops20-admin-refresh-secret-0123456789abcd',
    })) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AdminFeaturedCreatorsModule,
      ],
    })
      .overrideProvider(WawuIdClient)
      .useValue({
        lookupPublicIdentities: (ids: string[]) =>
          Promise.resolve(
            new Map([...identities].filter(([id]) => ids.includes(id))),
          ),
      })
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    configureHubApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.support,
      AdminRole.reviewer,
      AdminRole.finance,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email: `ops20-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `OPS-20 ${role}`,
          role,
        },
      });
      tokens[role] = issuer.issuePair(admin).accessToken;
    }
  });

  beforeEach(async () => {
    await prisma.featuredCreator.deleteMany({});
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.featuredCreator.deleteMany({});
      await prisma.contentPiece.deleteMany({
        where: { creatorWawuId: { in: profileIds } },
      });
      await prisma.privacySettings.deleteMany({
        where: { userWawuId: { in: profileIds } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: profileIds } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (app) await app.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('only a signed-in superadmin may read the rail or save its order', async () => {
    const a = await creator('ops20-a');
    await feature(a);
    await http().get(BASE).expect(401);
    await http()
      .post(`${BASE}/order`)
      .send({ order: [a] })
      .expect(401);
    for (const role of [
      AdminRole.support,
      AdminRole.reviewer,
      AdminRole.finance,
    ]) {
      await http().get(BASE).set(as(role)).expect(403);
      await order([a], role).expect(403);
    }
    await list().expect(200);
  });

  it('an empty rail is an empty list', async () => {
    expect(items(await list().expect(200))).toEqual([]);
  });

  it('lists the rail in Explore order with each creator name', async () => {
    const a = await creator('ops20-first');
    const b = await creator('ops20-second');
    const c = await creator('ops20-third');
    identities.set(b, {
      firstName: 'Ada',
      lastName: 'Obi',
      verificationTier: 'none',
    });
    await feature(c, 0);
    await feature(a, 5);
    await feature(b, 2);
    const rows = items(await list().expect(200));
    expect(rows.map((r) => r.wawuId)).toEqual([c, b, a]);
    expect(rows.map((r) => r.position)).toEqual([0, 2, 5]);
    // A name comes from WAWU ID, else the handle.
    expect(rows.map((r) => r.name)).toEqual([
      'ops20-third',
      'Ada Obi',
      'ops20-first',
    ]);
    expect(rows[1]).toMatchObject({
      handle: 'ops20-second',
      pieceCount: 1,
      shownInExplore: true,
      hiddenReason: null,
    });
    expect(Object.keys(rows[1]).sort()).toEqual([
      'featuredAt',
      'handle',
      'hiddenReason',
      'name',
      'pieceCount',
      'position',
      'shownInExplore',
      'wawuId',
    ]);
  });

  it('says why a featured creator is hidden today', async () => {
    const quiet = await creator('ops20-quiet');
    const hidden = await creator('ops20-hidden');
    await feature(quiet, 0);
    await feature(hidden, 1);
    await prisma.contentPiece.deleteMany({ where: { creatorWawuId: quiet } });
    await prisma.privacySettings.upsert({
      where: { userWawuId: hidden },
      create: { userWawuId: hidden, showInMemberLists: false },
      update: { showInMemberLists: false },
    });
    const rows = items(await list().expect(200));
    expect(
      rows.map((r) => [r.wawuId, r.shownInExplore, r.hiddenReason]),
    ).toEqual([
      [quiet, false, 'no_live_content'],
      [hidden, false, 'hidden_from_member_lists'],
    ]);
    await prisma.userProfile.update({
      where: { wawuUserId: hidden },
      data: { accountType: 'user' },
    });
    expect(items(await list().expect(200))[1].hiddenReason).toBe(
      'not_a_creator',
    );
  });

  it('saves the order as 0, 1, 2 in one go, and Explore reads it', async () => {
    const a = await creator('ops20-oa');
    const b = await creator('ops20-ob');
    const c = await creator('ops20-oc');
    await feature(a, 0);
    await feature(b, 0);
    await feature(c, 0);
    const res = await order([c, a, b]).expect(200);
    const saved = (res.body as Envelope<FeaturedOrderView>).data.items;
    expect(saved.map((r) => [r.wawuId, r.position])).toEqual([
      [c, 0],
      [a, 1],
      [b, 2],
    ]);
    expect(
      (
        await prisma.featuredCreator.findMany({ orderBy: { position: 'asc' } })
      ).map((r) => r.wawuUserId),
    ).toEqual([c, a, b]);
    expect(items(await list().expect(200)).map((r) => r.wawuId)).toEqual([
      c,
      a,
      b,
    ]);
  });

  it('refuses an order that misses someone, repeats someone, or names someone not featured', async () => {
    const a = await creator('ops20-ra');
    const b = await creator('ops20-rb');
    const stranger = await creator('ops20-rc');
    await feature(a, 0);
    await feature(b, 1);
    for (const body of [[a], [a, b, stranger], [a, stranger], [a, a], []]) {
      await order(body).expect(400);
    }
    for (const bad of [
      { order: 'x' },
      { order: [1, 2] },
      { order: ['%00'] },
      { order: [a, b], extra: 1 },
      {},
    ]) {
      await http()
        .post(`${BASE}/order`)
        .set(as(AdminRole.superadmin))
        .send(bad)
        .expect(400);
    }
    // Nothing moved.
    expect(items(await list().expect(200)).map((r) => r.position)).toEqual([
      0, 1,
    ]);
  });

  it('a refused order leaves every place as it was', async () => {
    const a = await creator('ops20-ta');
    const b = await creator('ops20-tb');
    await feature(a, 7);
    await feature(b, 3);
    await order([a, 'not-featured']).expect(400);
    expect(
      (
        await prisma.featuredCreator.findMany({ orderBy: { position: 'asc' } })
      ).map((r) => [r.wawuUserId, r.position]),
    ).toEqual([
      [b, 3],
      [a, 7],
    ]);
  });
});
