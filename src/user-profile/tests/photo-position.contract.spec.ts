// Run against a test database — see README "Running the tests"; always via
// `npm run test:contract`, never bare jest.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CreatorDiscoveryModule } from '../../creator-discovery/creator-discovery.module';
import { UserProfileModule } from '../user-profile.module';

const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
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

type Shown = { avatarUrl: string | null; coverUrl: string | null };
const shown = (res: { body: unknown }): Shown =>
  (res.body as { data: Shown }).data;

const HOST = 'https://wawu.sfo3.digitaloceanspaces.com';
const AVATAR = `${HOST}/avatars/pho-1/a.jpg?X-Amz-Signature=one`;
const COVER = `${HOST}/profile/cover/pho-1/c.jpg?X-Amz-Signature=two`;
const AVATAR_NEW = `${HOST}/avatars/pho-1/b.jpg?X-Amz-Signature=three`;

/**
 * R-96: where a person put their profile picture and cover in its frame. The
 * position rides on the link as `#wmt-pos=x,y,zoom,ratio`, so every response
 * that carries the link carries the position, and nothing else changes shape.
 */
describe('Photo position (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let proToken: string;
  let plainToken: string;
  let before: { avatarUrl: string | null; coverUrl: string | null } | null;

  const patchMe = (body: Record<string, unknown>, token = proToken) =>
    request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const getMe = () =>
    request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${proToken}`)
      .expect(200);
  const stored = () =>
    prisma.userProfile.findUnique({
      where: { wawuUserId: USER_CREATOR_PRO },
      select: { avatarUrl: true, coverUrl: true },
    });

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1500))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
    }
    proToken = await login('creator-pro@test.wawu.dev');
    plainToken = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
        CreatorDiscoveryModule,
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
    await app.init();
    prisma = moduleRef.get(PrismaService);
    before = await stored();
  }, 40000);

  afterAll(async () => {
    await prisma.userProfile.update({
      where: { wawuUserId: USER_CREATOR_PRO },
      data: {
        avatarUrl: before?.avatarUrl ?? null,
        coverUrl: before?.coverUrl ?? null,
      },
    });
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  }, 30000);

  it('a picture with no position is stored and served exactly as sent, as the web has always sent it', async () => {
    await patchMe({ avatarUrl: AVATAR, coverUrl: COVER }).expect(200);
    expect(await stored()).toEqual({ avatarUrl: AVATAR, coverUrl: COVER });
    const me = shown(await getMe());
    expect(me.avatarUrl).toBe(AVATAR);
    expect(me.coverUrl).toBe(COVER);
    expect(Object.keys(me)).not.toContain('avatarPosition');
    expect(Object.keys(me)).not.toContain('coverPosition');
  });

  it('a user saves where the picture and the cover sit, and reads the same back on their own profile', async () => {
    await patchMe({
      avatarUrl: `${AVATAR}#wmt-pos=0.5200,0.41,1.80,1.33330`,
      coverUrl: `${COVER}#wmt-pos=0.5,0.3,2,1.5`,
    }).expect(200);

    expect(await stored()).toEqual({
      avatarUrl: `${AVATAR}#wmt-pos=0.52,0.41,1.8,1.3333`,
      coverUrl: `${COVER}#wmt-pos=0.5,0.3,2,1.5`,
    });
    const me = shown(await getMe());
    expect(me.avatarUrl).toBe(`${AVATAR}#wmt-pos=0.52,0.41,1.8,1.3333`);
    expect(me.coverUrl).toBe(`${COVER}#wmt-pos=0.5,0.3,2,1.5`);
  });

  it('another person sees the same position on the public profile', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${USER_CREATOR_PRO}/public-profile`)
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(200);
    expect(shown(res).avatarUrl).toBe(`${AVATAR}#wmt-pos=0.52,0.41,1.8,1.3333`);
    expect(shown(res).coverUrl).toBe(`${COVER}#wmt-pos=0.5,0.3,2,1.5`);
  });

  it('a list of people carries the position on each picture too', async () => {
    const res = await request(app.getHttpServer())
      .get('/creators')
      .query({ perPage: 50 })
      .expect(200);
    const me = (
      res.body as { data: { wawuId: string; avatarUrl: string | null }[] }
    ).data.find((c) => c.wawuId === USER_CREATOR_PRO);
    expect(me?.avatarUrl).toBe(`${AVATAR}#wmt-pos=0.52,0.41,1.8,1.3333`);
  });

  it('choosing a new photo starts it centred: the new link has no position and the old one is gone', async () => {
    await patchMe({ avatarUrl: AVATAR_NEW }).expect(200);
    expect(await stored()).toEqual({
      avatarUrl: AVATAR_NEW,
      coverUrl: `${COVER}#wmt-pos=0.5,0.3,2,1.5`,
    });
    const me = shown(await getMe());
    expect(me.avatarUrl).toBe(AVATAR_NEW);
    // The cover was not touched, so it keeps where it was.
    expect(me.coverUrl).toBe(`${COVER}#wmt-pos=0.5,0.3,2,1.5`);
  });

  it('saving the profile without the pictures leaves their positions alone', async () => {
    await patchMe({ avatarUrl: `${AVATAR_NEW}#wmt-pos=0.5,0.5,1.5,1` }).expect(
      200,
    );
    await patchMe({ bio: 'Positions stay.' }).expect(200);
    const me = shown(await getMe());
    expect(me.avatarUrl).toBe(`${AVATAR_NEW}#wmt-pos=0.5,0.5,1.5,1`);
    expect(me.coverUrl).toBe(`${COVER}#wmt-pos=0.5,0.3,2,1.5`);
  });

  it('putting a picture back to centred is sending its link with no position', async () => {
    await patchMe({ coverUrl: COVER }).expect(200);
    expect((await stored())?.coverUrl).toBe(COVER);
  });

  it.each([
    ['a zoom past four', '#wmt-pos=0.5,0.5,5,1'],
    ['a point off the photo', '#wmt-pos=1.5,0.5,1,1'],
    ['words', '#wmt-pos=left,top,big,wide'],
    ['three numbers', '#wmt-pos=0.5,0.5,1'],
    [
      'a shape far too tall (the one that drew a 384 by 7680 avatar)',
      '#wmt-pos=0.5,0.5,4,0.05',
    ],
    ['a shape far too wide', '#wmt-pos=0.5,0.5,4,20'],
  ])(
    'refuses %s with a plain 400 and changes nothing',
    async (_name, fragment) => {
      const was = await stored();
      const res = await patchMe({
        avatarUrl: `${AVATAR_NEW}${fragment}`,
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain('picture position');
      expect(JSON.stringify(res.body)).not.toContain('—');
      expect(await stored()).toEqual(was);
    },
  );

  it('keeps an unrelated # on a link exactly as sent', async () => {
    await patchMe({ avatarUrl: `${AVATAR}#top` }).expect(200);
    expect((await stored())?.avatarUrl).toBe(`${AVATAR}#top`);
  });

  it('an account with no picture still has none', async () => {
    await patchMe({ avatarUrl: null }).expect(200);
    expect(shown(await getMe()).avatarUrl).toBeNull();
  });
});
