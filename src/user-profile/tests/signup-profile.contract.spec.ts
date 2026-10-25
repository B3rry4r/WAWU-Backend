// AUTH-06: what the sign-up sequence writes to the Hub's profile, and who A13 suggests.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ExploreModule } from '../../explore/explore.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';
import { StorageService } from '../../storage/storage.service';
import { UserProfileModule } from '../user-profile.module';

const CHIDI = '00000000-0000-4000-8000-000000000002'; // seeded creator, live pieces
const ZAINAB = '00000000-0000-4000-8000-000000000003'; // seeded creator, live pieces

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** A brand-new person, as WAWU ID makes one: a token for a sub the Hub has never seen. */
async function newPerson(tag: string): Promise<{ token: string; sub: string }> {
  const unique = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const res = await fetch(`${MOCK_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Auth Six ${tag}`,
      email: `auth06-${tag}-${unique}@test.wawu.dev`,
      phone: `+23480${unique.slice(-8)}`,
      country: 'Nigeria',
      password: 'a-test-password-1',
    }),
  });
  if (res.status !== 201)
    throw new Error(`mock register failed: ${res.status}`);
  const token = ((await res.json()) as { accessToken: string }).accessToken;
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as { sub: string };
  const sub = claims.sub;
  return { token, sub };
}

describe('After sign-up: account type, interests and people to follow (AUTH-06, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  const made: string[] = [];
  const saved: Record<string, string[]> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  type Data<T> = { body: { data: T } };
  const meOf = async (token: string) =>
    (
      (await http()
        .get('/api/hub/users/me')
        .set(bearer(token))
        .expect(200)) as Data<{
        accountType: string | null;
        interests: string[];
      }>
    ).body.data;

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not come up');
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
        ExploreModule,
        FollowRelationshipModule,
      ],
    })
      .overrideProvider(StorageService)
      .useValue({ freshUrlFor: (s: string | null) => Promise.resolve(s) })
      .compile();
    app = moduleRef.createNestApplication();
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
    await app.listen(0);
    prisma = app.get(PrismaService);
    for (const id of [CHIDI, ZAINAB]) {
      saved[id] = (
        await prisma.userProfile.findUniqueOrThrow({
          where: { wawuUserId: id },
          select: { interests: true },
        })
      ).interests;
    }
    await prisma.userProfile.update({
      where: { wawuUserId: CHIDI },
      data: { interests: ['Film & Video', 'makeup'] },
    });
    await prisma.userProfile.update({
      where: { wawuUserId: ZAINAB },
      data: { interests: ['photography', 'film_video'] },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: { in: made } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: made } },
    });
    for (const [id, interests] of Object.entries(saved)) {
      await prisma.userProfile.update({
        where: { wawuUserId: id },
        data: { interests },
      });
    }
    await app.close();
    mock?.kill();
  });

  it('a person who has just signed up as a creator is a creator on their Hub profile, with no wallet opened', async () => {
    const { token, sub } = await newPerson('creator');
    made.push(sub);
    expect((await meOf(token)).accountType).toBeNull();
    const put = (await http()
      .put('/api/hub/users/me/account-type')
      .set(bearer(token))
      .send({ accountType: 'creator' })
      .expect(200)) as Data<{ accountType: string }>;
    expect(put.body.data.accountType).toBe('creator');
    expect((await meOf(token)).accountType).toBe('creator');
    expect(
      await prisma.creatorWallet.count({ where: { wawuUserId: sub } }),
    ).toBe(0);
    // Sent again (the app does, on every start while the sequence is open), nothing changes.
    await http()
      .put('/api/hub/users/me/account-type')
      .set(bearer(token))
      .send({ accountType: 'creator' })
      .expect(200);
    expect(await prisma.userProfile.count({ where: { wawuUserId: sub } })).toBe(
      1,
    );
  });

  it('a person who signed up to discover is a user, and Become a creator moves them to creator but never back', async () => {
    const { token, sub } = await newPerson('user');
    made.push(sub);
    const first = (await http()
      .put('/api/hub/users/me/account-type')
      .set(bearer(token))
      .send({ accountType: 'user' })
      .expect(200)) as Data<{ accountType: string }>;
    expect(first.body.data.accountType).toBe('user');
    const up = (await http()
      .put('/api/hub/users/me/account-type')
      .set(bearer(token))
      .send({ accountType: 'creator' })
      .expect(200)) as Data<{ accountType: string }>;
    expect(up.body.data.accountType).toBe('creator');
    const back = (await http()
      .put('/api/hub/users/me/account-type')
      .set(bearer(token))
      .send({ accountType: 'user' })
      .expect(200)) as Data<{ accountType: string }>;
    expect(back.body.data.accountType).toBe('creator');
    expect((await meOf(token)).accountType).toBe('creator');
    expect(
      await prisma.creatorWallet.count({ where: { wawuUserId: sub } }),
    ).toBe(0);
  });

  it('a type that is not user or creator, an extra field, or no token is refused', async () => {
    const { token, sub } = await newPerson('bad');
    made.push(sub);
    for (const body of [
      { accountType: 'admin' },
      {},
      { accountType: 'user', extra: 1 },
      { accountType: null },
    ]) {
      await http()
        .put('/api/hub/users/me/account-type')
        .set(bearer(token))
        .send(body)
        .expect(400);
    }
    await http()
      .put('/api/hub/users/me/account-type')
      .send({ accountType: 'user' })
      .expect(401);
    expect(await prisma.userProfile.count({ where: { wawuUserId: sub } })).toBe(
      0,
    );
  });

  it('a user can read the twelve interests and the minimum, then save three or more and have them on their profile', async () => {
    const { token, sub } = await newPerson('interests');
    made.push(sub);
    const view = (await http()
      .get('/api/hub/users/me/interests')
      .set(bearer(token))
      .expect(200)) as Data<{
      minimum: number;
      options: Array<{ id: string; label: string }>;
      selected: string[];
    }>;
    expect(view.body.data.minimum).toBe(3);
    expect(view.body.data.options).toHaveLength(12);
    expect(view.body.data.options[0]).toEqual({
      id: 'music_audio',
      label: 'Music & Audio',
    });
    expect(view.body.data.selected).toEqual([]);

    const saved3 = (await http()
      .put('/api/hub/users/me/interests')
      .set(bearer(token))
      .send({ interests: ['fashion_beauty', 'music_audio', 'film_video'] })
      .expect(200)) as Data<{ selected: string[] }>;
    // Back in the chips' order, whatever order they were picked in.
    expect(saved3.body.data.selected).toEqual([
      'music_audio',
      'film_video',
      'fashion_beauty',
    ]);
    const me = await meOf(token);
    expect(me.interests).toEqual([
      'fashion_beauty',
      'music_audio',
      'film_video',
    ]);
    // The save made the profile row; it did not decide a creator: it holds the user type.
    expect(me.accountType).toBe('user');
  });

  it('saving interests keeps a tag the profile editor wrote, and replaces the picks of the time before', async () => {
    const { token, sub } = await newPerson('keep');
    made.push(sub);
    await http()
      .put('/api/hub/users/me/account-type')
      .set(bearer(token))
      .send({ accountType: 'user' })
      .expect(200);
    await prisma.userProfile.update({
      where: { wawuUserId: sub },
      data: { interests: ['makeup', 'Technology'] },
    });
    await http()
      .put('/api/hub/users/me/interests')
      .set(bearer(token))
      .send({ interests: ['photography', 'art_design', 'gaming_esports'] })
      .expect(200);
    const me = await meOf(token);
    expect(me.interests).toEqual([
      'photography',
      'art_design',
      'gaming_esports',
      'makeup',
    ]);
  });

  it('fewer than the minimum, a repeat, an unknown id or something that is not a list is a 400 and saves nothing', async () => {
    const { token, sub } = await newPerson('badpick');
    made.push(sub);
    for (const interests of [
      ['music_audio', 'film_video'],
      [],
      ['music_audio', 'music_audio', 'film_video'],
      ['music_audio', 'film_video', 'nope'],
      ['music_audio', 'film_video', 7],
      'music_audio',
    ]) {
      await http()
        .put('/api/hub/users/me/interests')
        .set(bearer(token))
        .send({ interests })
        .expect(400);
    }
    await http()
      .put('/api/hub/users/me/interests')
      .set(bearer(token))
      .send({ interests: ['a', 'b', 'c'], more: 1 })
      .expect(400);
    expect(await prisma.userProfile.count({ where: { wawuUserId: sub } })).toBe(
      0,
    );
  });

  it('people to follow: those matching the most of what was picked come first, one pick narrows, none picked lists them all', async () => {
    const { token, sub } = await newPerson('suggest');
    made.push(sub);
    const ids = async (query: string) =>
      (
        (await http()
          .get(`/api/hub/explore/suggested-creators${query}`)
          .set(bearer(token))
          .expect(200)) as Data<{
          items: Array<{ wawuId: string; following: boolean }>;
        }>
      ).body.data.items.map((i) => i.wawuId);
    // ZAINAB matches both picks, CHIDI one.
    expect(await ids('?interests=photography,film_video')).toEqual([
      ZAINAB,
      CHIDI,
    ]);
    expect(await ids('?interests=photography&interests=film_video')).toEqual([
      ZAINAB,
      CHIDI,
    ]);
    // R2-AUTHME3 (A13): one pick no longer narrows the list to the matches alone. They stay first; the other
    // creators with live content follow, so the screen is not empty for a person whose picks match few or none.
    expect(await ids('?interests=photography')).toEqual([ZAINAB, CHIDI]);
    expect([...(await ids('?interests=technology'))].sort()).toEqual(
      [CHIDI, ZAINAB].sort(),
    );
    expect([...(await ids(''))].sort()).toEqual([CHIDI, ZAINAB].sort());
    expect(await ids('?interests=film_video&limit=1')).toHaveLength(1);
  });

  it('people to follow: when the picks match fewer creators than the list holds, the rest are creators with live content, most followed first, and the matches stay first (R2-AUTHME3, A13)', async () => {
    const { token, sub } = await newPerson('fallback');
    made.push(sub);
    const ids = async (query: string) =>
      (
        (await http()
          .get(`/api/hub/explore/suggested-creators${query}`)
          .set(bearer(token))
          .expect(200)) as Data<{ items: Array<{ wawuId: string }> }>
      ).body.data.items.map((i) => i.wawuId);
    // Two creators who saved no interest at all: one followed by three people, one by one.
    const many = await newPerson('fbmany');
    const few = await newPerson('fbfew');
    const pieces: string[] = [];
    const stamp = Date.now();
    for (const [person, tag] of [
      [many, 'many'],
      [few, 'few'],
    ] as const) {
      made.push(person.sub);
      await prisma.userProfile.create({
        data: {
          wawuUserId: person.sub,
          accountType: 'creator',
          handle: `zz-fb-${tag}-${stamp}`,
          interests: [],
        },
      });
      const piece = await prisma.contentPiece.create({
        data: {
          slug: `fb-${tag}-${stamp}`,
          creatorWawuId: person.sub,
          contentType: 'video',
          title: `Fallback ${tag}`,
          description: 'Seeded',
          category: 'business_entrepreneurship',
          accessType: 'paid',
          price: 1500,
          previewAssetUrl: 'https://cdn.example.com/p.jpg',
          fullAssetUrl: 'https://cdn.example.com/f.mp4',
          status: 'live',
        },
      });
      pieces.push(piece.id);
    }
    // More followers than either seeded creator has, whatever the seed left: three above the most followed, one above.
    const top = Math.max(
      ...(await Promise.all(
        [CHIDI, ZAINAB].map((id) =>
          prisma.followRelationship.count({ where: { followingWawuId: id } }),
        ),
      )),
    );
    const followedBy = (target: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        followerWawuId: `fb-${i}-${stamp}`,
        followingWawuId: target,
      }));
    await prisma.followRelationship.createMany({
      data: [...followedBy(many.sub, top + 3), ...followedBy(few.sub, top + 1)],
    });
    try {
      // Picks that match nobody: every creator with live content, the most followed first, then by handle.
      const none = await ids('?interests=technology');
      expect(none.slice(0, 2)).toEqual([many.sub, few.sub]);
      expect(new Set(none)).toEqual(
        new Set([many.sub, few.sub, CHIDI, ZAINAB]),
      );
      // Picks that match one: that one first, never repeated, then the rest as above.
      const one = await ids('?interests=photography');
      expect(one).toEqual([ZAINAB, many.sub, few.sub, CHIDI]);
      // The list is never longer than the limit, and the matches are not pushed out by the fill.
      expect(await ids('?interests=photography&limit=2')).toEqual([
        ZAINAB,
        many.sub,
      ]);
      expect(await ids('?interests=photography&limit=1')).toEqual([ZAINAB]);
      // The viewer is never in their own list, fill included.
      expect(none).not.toContain(sub);
      // No picks is still the plain list (nothing to fill).
      expect(new Set(await ids(''))).toEqual(
        new Set([many.sub, few.sub, CHIDI, ZAINAB]),
      );
    } finally {
      await prisma.contentPiece.deleteMany({ where: { id: { in: pieces } } });
      await prisma.followRelationship.deleteMany({
        where: { followingWawuId: { in: [many.sub, few.sub] } },
      });
    }
  });

  it('people to follow shows who the viewer already follows, never the viewer, and refuses hostile values', async () => {
    const { token, sub } = await newPerson('follow');
    made.push(sub);
    await http()
      .post(`/api/hub/creators/${ZAINAB}/follow`)
      .set(bearer(token))
      .expect((r) => expect([200, 201]).toContain(r.status));
    const list = (await http()
      .get(
        '/api/hub/explore/suggested-creators?interests=photography,film_video',
      )
      .set(bearer(token))
      .expect(200)) as Data<{
      items: Array<{ wawuId: string; following: boolean; name: string }>;
    }>;
    const byId = Object.fromEntries(
      list.body.data.items.map((i) => [i.wawuId, i]),
    );
    expect(byId[ZAINAB].following).toBe(true);
    expect(byId[CHIDI].following).toBe(false);
    expect(byId[ZAINAB].name).not.toBe('');
    expect(byId[sub]).toBeUndefined();
    for (const q of [
      '?interests=nope',
      '?limit=0',
      '?limit=21',
      '?limit=x',
      '?interests=%00',
    ]) {
      await http()
        .get(`/api/hub/explore/suggested-creators${q}`)
        .set(bearer(token))
        .expect(400);
    }
  });
});
