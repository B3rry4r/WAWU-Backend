import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { UserProfileModule } from '../user-profile.module';

/**
 * Whose works these are (ME-11): M34's header ("Lennox Emmanuel · 12") and
 * M35's creator row need the owner's name and picture, and nothing else in the
 * contract serves another person's name by id.
 *
 * What this suite proves, each as "a user can ...":
 *  - a visitor reading a creator's works, by id or by handle, gets that
 *    creator's name, handle and picture with the list, and with one work;
 *  - the owner reading their own list gets the same;
 *  - a person who cannot see the page gets no owner: the same 404 as before;
 *  - the answers a work's create and edit return keep exactly their old keys.
 *
 * It creates its own rows (works for two seeded accounts) and removes only the
 * ids it made. It never touches a seeded row.
 */

const MOCK_WAWU_ID_BASE =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const OWNER_EMAIL = 'creator-pro@test.wawu.dev';
const OWNER_SUB = '00000000-0000-4000-8000-000000000003';
const OWNER_NAME = 'Zainab Bello';
const VISITOR_EMAIL = 'creator-basic@test.wawu.dev';
/** A seeded account with a profile and no creator state: nobody can visit it. */
const PLAIN_SUB = '00000000-0000-4000-8000-000000000001';

type Json = Record<string, unknown>;
interface OwnerJson {
  wawuId: string;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Featured works: whose they are (ME-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wawuId: WawuIdClient;
  let baseUrl = '';
  let ownerToken: string;
  let visitorToken: string;
  let ownerHandle: string | null = null;
  let ownerAvatar: string | null = null;
  const made: string[] = [];
  const http = () => request(baseUrl);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

  /** One work of the owner's own, added by this suite and removed by id. */
  async function addWork(): Promise<string> {
    const res = await http()
      .post('/users/me/featured-works')
      .set(auth(ownerToken))
      .send({ title: 'Owner view', role: 'Director', year: 2024 })
      .expect(201);
    const body = data<Json>(res);
    made.push(body.id as string);
    return body.id as string;
  }

  beforeAll(async () => {
    [ownerToken, visitorToken] = await Promise.all([
      login(OWNER_EMAIL),
      login(VISITOR_EMAIL),
    ]);
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    prisma = moduleRef.get(PrismaService);
    wawuId = moduleRef.get(WawuIdClient, { strict: false });
    const profile = await prisma.userProfile.findUnique({
      where: { wawuUserId: OWNER_SUB },
      select: { handle: true, avatarUrl: true },
    });
    ownerHandle = profile?.handle ?? null;
    ownerAvatar = profile?.avatarUrl ?? null;
  }, 30000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (made.length > 0) {
      await prisma.profileWork.deleteMany({
        where: { id: { in: made }, wawuUserId: OWNER_SUB },
      });
    }
    await app.close();
  });

  it("a visitor reading a creator's list gets the creator's name, handle and picture, by id and by handle", async () => {
    await addWork();
    const byId = await http()
      .get(`/users/${OWNER_SUB}/featured-works`)
      .set(auth(visitorToken))
      .expect(200);
    const owner = data<{ owner: OwnerJson }>(byId).owner;
    expect(owner.wawuId).toBe(OWNER_SUB);
    expect(owner.displayName).toBe(OWNER_NAME);
    expect(owner.handle).toBe(ownerHandle);
    expect(Object.keys(owner).sort()).toEqual([
      'avatarUrl',
      'displayName',
      'handle',
      'wawuId',
    ]);
    if (ownerAvatar === null) expect(owner.avatarUrl).toBeNull();

    if (ownerHandle) {
      const byHandle = await http()
        .get(`/users/${ownerHandle}/featured-works`)
        .set(auth(visitorToken))
        .expect(200);
      expect(data<{ owner: OwnerJson }>(byHandle).owner).toEqual(owner);
    }
  });

  it('a visitor opening one work gets the same owner beside it', async () => {
    const id = await addWork();
    const res = await http()
      .get(`/users/${OWNER_SUB}/featured-works/${id}`)
      .set(auth(visitorToken))
      .expect(200);
    const body = data<Json & { owner: OwnerJson }>(res);
    expect(body.id).toBe(id);
    expect(body.owner.wawuId).toBe(OWNER_SUB);
    expect(body.owner.displayName).toBe(OWNER_NAME);
  });

  it('the owner reading their own list, with a category and a limit, still gets who they are', async () => {
    await addWork();
    const res = await http()
      .get('/users/me/featured-works?limit=1&category=nothing-matches-this')
      .set(auth(ownerToken))
      .expect(200);
    const body = data<{ owner: OwnerJson; works: unknown[]; count: number }>(
      res,
    );
    expect(body.owner.displayName).toBe(OWNER_NAME);
    expect(body.works).toHaveLength(0);
    expect(body.count).toBeGreaterThan(0);
  });

  it('when the identity service does not answer, the name falls back to the handle and nothing breaks', async () => {
    await addWork();
    jest.spyOn(wawuId, 'lookupPublicIdentities').mockResolvedValue(new Map());
    const res = await http()
      .get(`/users/${OWNER_SUB}/featured-works`)
      .set(auth(visitorToken))
      .expect(200);
    expect(data<{ owner: OwnerJson }>(res).owner.displayName).toBe(ownerHandle);
  });

  it('a page nobody can visit has no owner to read: the same 404 as before', async () => {
    const res = await http()
      .get(`/users/${PLAIN_SUB}/featured-works`)
      .set(auth(visitorToken))
      .expect(404);
    expect(JSON.stringify(res.body)).not.toMatch(/owner|displayName/);
    expect((res.body as { message: string }).message).toBe('User not found');
  });

  it('creating and editing a work answer with the keys they always had: no owner', async () => {
    const created = await http()
      .post('/users/me/featured-works')
      .set(auth(ownerToken))
      .send({ title: 'No owner key', role: 'Editor', year: 2023 })
      .expect(201);
    const work = data<Json>(created);
    made.push(work.id as string);
    expect(Object.keys(work).sort()).toEqual([
      'category',
      'client',
      'createdAt',
      'description',
      'id',
      'link',
      'media',
      'position',
      'role',
      'title',
      'year',
    ]);
    const edited = await http()
      .patch(`/users/me/featured-works/${work.id as string}`)
      .set(auth(ownerToken))
      .send({ title: 'Still no owner key' })
      .expect(200);
    expect(Object.keys(data<Json>(edited))).not.toContain('owner');
  });
});
