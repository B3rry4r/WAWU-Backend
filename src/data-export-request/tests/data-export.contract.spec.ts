// SETTINGS-04: a data export that arrives, holds only the requester's own
// data, and holds no secrets.
//
// Each test is one thing a user (or the person reading their mail) can do.
// The fixtures plant a sentinel string in every place that must NOT reach the
// file (another person's reply, a message sent to the user, a PIN hash, a
// bank account number, a follower, a stranger's comment), so a section that
// starts leaking fails on a name, not on a vague diff.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { DataExportRequestModule } from '../data-export-request.module';
import { DataExportFulfilmentService } from '../data-export-fulfilment.service';
import { DataExportMailer } from '../data-export-mailer';
import { signExportLink, verifyExportLink } from '../data-export-link';

const USER = '00000000-0000-4000-8000-000000000001'; // Adaeze
const OTHER = '00000000-0000-4000-8000-000000000002'; // Chidi
const PRO = '00000000-0000-4000-8000-000000000003'; // Zainab, blocked by USER in the fixtures
const MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002';
const SERVICE_KEY =
  process.env.WAWU_ID_INTERNAL_SERVICE_KEY ??
  'dev-internal-service-key-not-secret';

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

const SENTINELS = {
  otherReply: 'SENTINEL_OTHER_PERSON_REPLY',
  dmAnswer: 'SENTINEL_CREATOR_ANSWER',
  inboundDm: 'SENTINEL_MESSAGE_SENT_TO_USER',
  strangerComment: 'SENTINEL_STRANGER_COMMENT',
  pinHash: 'SENTINEL_PIN_HASH_$argon2',
  bankNumber: '0099887766',
  reporter: 'SENTINEL_REPORT_TEXT',
};
const OWN_COMMENT_TEXT = 'S04 export: my own comment';
const OWN_DM_TEXT = 'S04 export: what I paid to ask';

const ID = {
  ownComment: '5b040000-0000-4000-8000-000000000001',
  strangerComment: '5b040000-0000-4000-8000-000000000002',
  dmSent: '5b040000-0000-4000-8000-000000000003',
  dmReceived: '5b040000-0000-4000-8000-000000000004',
  dmReply: '5b040000-0000-4000-8000-000000000005',
  block: '5b040000-0000-4000-8000-000000000007',
  follower: '5b040000-0000-4000-8000-000000000008',
  following: '5b040000-0000-4000-8000-00000000000a',
};

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

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function outbox(): Promise<
  Array<{ userId: string; to: string; downloadUrl: string; expiresAt: string }>
> {
  const res = await fetch(`${MOCK_BASE}/internal/mail-outbox`, {
    headers: { 'X-Service-Key': SERVICE_KEY },
  });
  return ((await res.json()) as { data: never[] }).data;
}

describe('Data export (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fulfil: DataExportFulfilmentService;
  let config: ConfigService;
  let mock: ChildProcess | undefined;
  let ownedMock = false;
  let token: string;
  const requestIds: string[] = [];

  /** Ask for an export as USER and return the row. */
  const ask = async () => {
    const res = await request(app.getHttpServer())
      .post('/settings/privacy/export')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    const row = (res.body as { data: { id: string; status: string } }).data;
    if (!requestIds.includes(row.id)) requestIds.push(row.id);
    return row;
  };
  const mailFor = async (requestId: string) => {
    const row = await prisma.dataExportRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(row.status).toBe('sent');
    const mails = (await outbox()).filter((m) => m.userId === USER);
    return mails[mails.length - 1];
  };
  const openLink = (downloadUrl: string) => {
    const u = new URL(downloadUrl);
    return request(app.getHttpServer()).get(
      u.pathname.replace('/api/hub', '') + u.search,
    );
  };

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      ownedMock = true;
      if (!(await waitForHealth(`${MOCK_BASE}/health`)))
        throw new Error('mock did not come up');
    }
    token = await login('user@test.wawu.dev');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        DataExportRequestModule,
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
    fulfil = moduleRef.get(DataExportFulfilmentService);
    config = moduleRef.get(ConfigService);

    await prisma.dataExportRequest.deleteMany({
      where: { userWawuId: { in: [USER, OTHER] } },
    });
    // Clear anything a crashed earlier run left under this spec's ids.
    await prisma.dmReply.deleteMany({ where: { id: ID.dmReply } });
    await prisma.directMessage.deleteMany({
      where: { id: { in: [ID.dmSent, ID.dmReceived] } },
    });
    await prisma.comment.deleteMany({
      where: { id: { in: [ID.ownComment, ID.strangerComment] } },
    });
    await prisma.blockedAccount.deleteMany({ where: { id: ID.block } });
    const soon = new Date(Date.now() + 86_400_000);
    await prisma.comment.createMany({
      data: [
        {
          id: ID.ownComment,
          contentId: MAKEUP_VIDEO,
          authorWawuId: USER,
          text: OWN_COMMENT_TEXT,
        },
        {
          id: ID.strangerComment,
          contentId: MAKEUP_VIDEO,
          authorWawuId: OTHER,
          text: SENTINELS.strangerComment,
        },
      ],
    });
    await prisma.directMessage.createMany({
      data: [
        {
          id: ID.dmSent,
          creatorWawuId: OTHER,
          senderWawuId: USER,
          text: OWN_DM_TEXT,
          amount: 300,
          responseText: SENTINELS.dmAnswer,
          flutterwaveTxRef: 's04-export-dm-sent',
          deadlineAt: soon,
        },
        {
          id: ID.dmReceived,
          creatorWawuId: USER,
          senderWawuId: OTHER,
          text: SENTINELS.inboundDm,
          amount: 300,
          flutterwaveTxRef: 's04-export-dm-received',
          deadlineAt: soon,
        },
      ],
    });
    await prisma.dmReply.create({
      data: {
        id: ID.dmReply,
        messageId: ID.dmSent,
        creatorWawuId: OTHER,
        text: SENTINELS.otherReply,
      },
    });
    // USER follows OTHER, and OTHER follows USER. The second is somebody
    // else's action, which must not be in USER's file. Rows that are already
    // there (the seed, or another spec) are left alone, and only ours are
    // deleted afterwards.
    for (const [followerWawuId, followingWawuId, id] of [
      [USER, OTHER, ID.following],
      [OTHER, USER, ID.follower],
    ] as const) {
      const existing = await prisma.followRelationship.findFirst({
        where: { followerWawuId, followingWawuId },
      });
      if (!existing) {
        await prisma.followRelationship.create({
          data: { id, followerWawuId, followingWawuId },
        });
      }
    }
    await prisma.blockedAccount.create({
      data: { id: ID.block, userWawuId: USER, blockedWawuId: PRO },
    });
    await prisma.transactionPin.upsert({
      where: { wawuUserId: USER },
      update: { pinHash: SENTINELS.pinHash },
      create: { wawuUserId: USER, pinHash: SENTINELS.pinHash },
    });
    await prisma.moneyPayoutAccount.upsert({
      where: { wawuUserId: USER },
      update: { accountNumber: SENTINELS.bankNumber },
      create: {
        wawuUserId: USER,
        bankCode: '058',
        bankName: 'S04 Bank',
        accountNumber: SENTINELS.bankNumber,
        accountName: 'S04',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.moneyPayoutAccount.deleteMany({ where: { wawuUserId: USER } });
    await prisma.transactionPin.deleteMany({ where: { wawuUserId: USER } });
    await prisma.blockedAccount.deleteMany({ where: { id: ID.block } });
    await prisma.followRelationship.deleteMany({
      where: { id: { in: [ID.follower, ID.following] } },
    });
    await prisma.dmReply.deleteMany({ where: { id: ID.dmReply } });
    await prisma.directMessage.deleteMany({
      where: { id: { in: [ID.dmSent, ID.dmReceived] } },
    });
    await prisma.comment.deleteMany({
      where: { id: { in: [ID.ownComment, ID.strangerComment] } },
    });
    await prisma.dataExportRequest.deleteMany({
      where: { id: { in: requestIds } },
    });
    await app.close();
    if (ownedMock && mock) mock.kill();
  });

  // Each test starts with no export requests for USER, so the daily limit
  // (3 in 24 hours) is only ever what the test itself asks for.
  beforeEach(async () => {
    await prisma.dataExportRequest.deleteMany({
      where: { userWawuId: { in: [USER, OTHER] } },
    });
  });

  it('a user can ask for their data and the link is emailed to them through WAWU ID', async () => {
    const before = (await outbox()).length;
    const req = await ask();
    expect(req.status).toBe('pending');

    expect(await fulfil.fulfil(req.id)).toBe(true);

    const mails = await outbox();
    expect(mails.length).toBe(before + 1);
    const mail = await mailFor(req.id);
    expect(mail.to).toBe('user@test.wawu.dev');
    expect(mail.downloadUrl).toContain(
      '/api/hub/settings/privacy/export/download?token=',
    );
    // The link expires, and says when.
    const hours = (Date.parse(mail.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThanOrEqual(72);
  });

  it('a user sees where their request stands, and only their own requests', async () => {
    const mine = await ask();
    const other = await prisma.dataExportRequest.create({
      data: { userWawuId: OTHER },
    });
    requestIds.push(other.id);
    const res = await request(app.getHttpServer())
      .get('/settings/privacy/export')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = (
      res.body as { data: Array<{ id: string; userWawuId: string }> }
    ).data;
    expect(rows.map((r) => r.id)).toContain(mine.id);
    expect(rows.every((r) => r.userWawuId === USER)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(other.id);
    await request(app.getHttpServer())
      .get('/settings/privacy/export')
      .expect(401);
  });

  it('a user who asks twice before the email goes out gets one request and one email', async () => {
    await prisma.dataExportRequest.deleteMany({
      where: { userWawuId: USER, status: 'pending' },
    });
    const first = await ask();
    const second = await ask();
    expect(second.id).toBe(first.id);
    const before = (await outbox()).length;
    await fulfil.fulfil(first.id);
    await fulfil.fulfil(first.id);
    expect((await outbox()).length).toBe(before + 1);
  });

  it('a user who opens the emailed link downloads a file with their own data', async () => {
    const req = await ask();
    await fulfil.fulfil(req.id);
    const mail = await mailFor(req.id);

    const res = await openLink(mail.downloadUrl).expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const file = JSON.parse(res.text) as {
      accountId: string;
      requestId: string;
      notIncluded: string[];
      data: Record<
        string,
        Array<Record<string, unknown>> & Record<string, unknown>
      >;
    };

    expect(file.accountId).toBe(USER);
    expect(file.requestId).toBe(req.id);
    const text = (rows: unknown) => JSON.stringify(rows);
    expect(text(file.data.comments)).toContain(OWN_COMMENT_TEXT);
    expect(text(file.data.paidMessagesSent)).toContain(OWN_DM_TEXT);
    const followedInDb = (
      await prisma.followRelationship.findMany({
        where: { followerWawuId: USER },
      })
    )
      .map((f) => f.followingWawuId)
      .sort();
    expect(followedInDb).toContain(OTHER);
    expect(
      (file.data.following as unknown as Array<{ followingWawuId: string }>)
        .map((f) => f.followingWawuId)
        .sort(),
    ).toEqual(followedInDb);
    expect(
      (file.data.blockedAccounts as unknown as Array<{ blockedWawuId: string }>)
        .length,
    ).toBe(1);
    expect((file.data.profile as unknown as { handle: string }).handle).toBe(
      'adaeze',
    );
    // The file says what it does not hold.
    expect(file.notIncluded.length).toBeGreaterThan(0);
    expect(file.notIncluded.join(' ')).not.toMatch(/—/);
  });

  it('a downloaded file holds nothing another person wrote and no secret', async () => {
    const req = await ask();
    await fulfil.fulfil(req.id);
    const mail = await mailFor(req.id);
    const body = (await openLink(mail.downloadUrl).expect(200)).text;

    for (const [name, sentinel] of Object.entries(SENTINELS)) {
      expect({ name, leaked: body.includes(sentinel) }).toEqual({
        name,
        leaked: false,
      });
    }
    // Nothing that looks like a signed link, a hash or a provider reference.
    expect(body).not.toMatch(
      /X-Amz-Signature|pinHash|flutterwave|accountNumber|argon2/i,
    );
    // Every section is only about the requester: no other account id is in
    // it except where the requester's own action names one (who they follow,
    // whom they messaged or blocked, whose piece they bought).
    const ownActionTargets = new Set([OTHER, PRO]);
    const idsInFile =
      body.match(/00000000-0000-4000-8000-0000000000\d\d/g) ?? [];
    for (const id of idsInFile) {
      expect(id === USER || ownActionTargets.has(id)).toBe(true);
    }
    // The follower row (OTHER follows USER) is not there: every row of
    // `following` points away from USER.
    const file = JSON.parse(body) as {
      data: { following: Array<{ followingWawuId: string }> };
    };
    expect(file.data.following.map((f) => f.followingWawuId)).not.toContain(
      USER,
    );
  });

  it('a link that was changed, expired or never issued opens nothing', async () => {
    const req = await ask();
    await fulfil.fulfil(req.id);
    const mail = await mailFor(req.id);
    const good = new URL(mail.downloadUrl).searchParams.get('token') as string;
    const route = '/settings/privacy/export/download';
    const secret = config.get<string>('ADMIN_JWT_SECRET');

    await request(app.getHttpServer()).get(route).expect(404);
    await request(app.getHttpServer())
      .get(`${route}?token=nonsense`)
      .expect(404);
    const [payload, sig] = good.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ r: req.id, e: Math.floor(Date.now() / 1000) + 10 ** 9 }),
    ).toString('base64url');
    await request(app.getHttpServer())
      .get(`${route}?token=${forgedPayload}.${sig}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`${route}?token=${payload}.${sig.slice(1)}x`)
      .expect(404);
    // Correctly signed but already expired.
    const expired = signExportLink(req.id, new Date(Date.now() - 1000), secret);
    await request(app.getHttpServer())
      .get(`${route}?token=${expired}`)
      .expect(404);
    expect(verifyExportLink(expired, secret)).toBeNull();
    // Correctly signed for a request nobody made.
    const unknown = signExportLink(
      '5b040000-0000-4000-8000-0000000000ff',
      new Date(Date.now() + 60_000),
      secret,
    );
    await request(app.getHttpServer())
      .get(`${route}?token=${unknown}`)
      .expect(404);
    // Signed with some other secret.
    const foreign = signExportLink(
      req.id,
      new Date(Date.now() + 60_000),
      'z'.repeat(40),
    );
    await request(app.getHttpServer())
      .get(`${route}?token=${foreign}`)
      .expect(404);
    // The genuine link still works after all of that.
    await request(app.getHttpServer())
      .get(`${route}?token=${good}`)
      .expect(200);
  });

  it('a link stops working when the request is gone, as it is when the account is deleted', async () => {
    const req = await ask();
    await fulfil.fulfil(req.id);
    const mail = await mailFor(req.id);
    await openLink(mail.downloadUrl).expect(200);
    await prisma.dataExportRequest.delete({ where: { id: req.id } });
    await openLink(mail.downloadUrl).expect(404);
  });

  it('a link is not honoured before the email went out', async () => {
    const req = await ask(); // still pending
    const pending = await prisma.dataExportRequest.findUniqueOrThrow({
      where: { id: req.id },
    });
    expect(pending.status).toBe('pending');
    const early = signExportLink(
      req.id,
      new Date(Date.now() + 60_000),
      config.get<string>('ADMIN_JWT_SECRET'),
    );
    await request(app.getHttpServer())
      .get(`/settings/privacy/export/download?token=${early}`)
      .expect(404);
    await fulfil.fulfil(req.id);
  });

  it('a request stays pending while WAWU ID cannot send it and is marked failed after a day', async () => {
    await prisma.dataExportRequest.deleteMany({
      where: { userWawuId: USER, status: 'pending' },
    });
    const req = await ask();
    const down = new ConfigService({
      WAWU_ID_BASE_URL: 'http://localhost:1',
      WAWU_ID_INTERNAL_SERVICE_KEY: SERVICE_KEY,
      ADMIN_JWT_SECRET: config.get<string>('ADMIN_JWT_SECRET'),
    });
    const flaky = new DataExportFulfilmentService(
      prisma,
      new DataExportMailer(down),
      down,
    );

    expect(await flaky.fulfil(req.id)).toBe(false);
    expect(
      (
        await prisma.dataExportRequest.findUniqueOrThrow({
          where: { id: req.id },
        })
      ).status,
    ).toBe('pending');
    // Later, with WAWU ID back, the same request is sent.
    expect(await fulfil.fulfil(req.id)).toBe(true);

    const stale = await prisma.dataExportRequest.create({
      data: {
        userWawuId: USER,
        requestedAt: new Date(Date.now() - 25 * 3_600_000),
      },
    });
    requestIds.push(stale.id);
    expect(await flaky.fulfil(stale.id)).toBe(false);
    expect(
      (
        await prisma.dataExportRequest.findUniqueOrThrow({
          where: { id: stale.id },
        })
      ).status,
    ).toBe('failed');
  });

  it('the sweep emails every pending request once', async () => {
    await prisma.dataExportRequest.deleteMany({
      where: { userWawuId: { in: [USER, OTHER] }, status: 'pending' },
    });
    const a = await ask();
    const before = (await outbox()).length;
    expect(await fulfil.sweep()).toBeGreaterThanOrEqual(1);
    expect(
      (
        await prisma.dataExportRequest.findUniqueOrThrow({
          where: { id: a.id },
        })
      ).status,
    ).toBe('sent');
    expect(await fulfil.sweep()).toBe(0);
    expect((await outbox()).length).toBeGreaterThan(before);
  });

  const fulfilWorker = () =>
    new DataExportFulfilmentService(
      prisma,
      new DataExportMailer(config),
      config,
    );
  const mailsToUser = async () =>
    (await outbox()).filter((m) => m.userId === USER).length;
  const post = () =>
    request(app.getHttpServer())
      .post('/settings/privacy/export')
      .set('Authorization', `Bearer ${token}`)
      .send({});

  it('a user who asks four times at once gets one request and one email, in 12 trials', async () => {
    for (let trial = 0; trial < 12; trial++) {
      await prisma.dataExportRequest.deleteMany({
        where: { userWawuId: USER },
      });
      const before = await mailsToUser();
      const res = await Promise.all([post(), post(), post(), post()]);
      res.forEach((r) => expect(r.status).toBe(201));
      const rowIds = new Set(
        res.map((r) => (r.body as { data: { id: string } }).data.id),
      );
      expect(rowIds.size).toBe(1);
      expect(
        await prisma.dataExportRequest.count({ where: { userWawuId: USER } }),
      ).toBe(1);
      await Promise.all([fulfil.sweep(), fulfil.sweep()]);
      expect((await mailsToUser()) - before).toBe(1);
    }
  }, 120_000);

  it('a request is emailed once however many workers race for it, in 12 trials', async () => {
    const workers = [fulfilWorker(), fulfilWorker(), fulfil];
    for (let trial = 0; trial < 12; trial++) {
      await prisma.dataExportRequest.deleteMany({
        where: { userWawuId: USER },
      });
      const rows = await Promise.all(
        [0, 1, 2, 3].map(() =>
          prisma.dataExportRequest.create({ data: { userWawuId: USER } }),
        ),
      );
      rows.forEach((r) => requestIds.push(r.id));
      const before = await mailsToUser();
      await Promise.all([
        workers[0].sweep(),
        workers[1].sweep(),
        workers[2].sweep(),
        ...rows.map((r) => workers[0].fulfil(r.id)),
        ...rows.map((r) => workers[1].fulfil(r.id)),
      ]);
      expect((await mailsToUser()) - before).toBe(4);
      const states = await prisma.dataExportRequest.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      expect(states.map((r) => r.status)).toEqual([
        'sent',
        'sent',
        'sent',
        'sent',
      ]);
    }
  }, 180_000);

  it('a request whose email fails is not lost and is sent on the next try', async () => {
    const req = await ask();
    const down = new ConfigService({
      WAWU_ID_BASE_URL: 'http://localhost:1',
      WAWU_ID_INTERNAL_SERVICE_KEY: SERVICE_KEY,
      ADMIN_JWT_SECRET: config.get<string>('ADMIN_JWT_SECRET'),
    });
    const flaky = new DataExportFulfilmentService(
      prisma,
      new DataExportMailer(down),
      down,
    );
    expect(await flaky.fulfil(req.id)).toBe(false);
    expect(
      (
        await prisma.dataExportRequest.findUniqueOrThrow({
          where: { id: req.id },
        })
      ).status,
    ).toBe('pending');
    expect(await fulfil.fulfil(req.id)).toBe(true);
  });

  it('a user cannot ask for their data more than 3 times in 24 hours, even in a burst, and gets 429 in the usual error shape', async () => {
    // Three requests, each emailed, so none is "pending" any more.
    for (let i = 0; i < 3; i++) {
      const r = await ask();
      expect(await fulfil.fulfil(r.id)).toBe(true);
    }
    const refused = await post();
    expect(refused.status).toBe(429);
    const body = refused.body as {
      statusCode: number;
      message: string;
      data: unknown;
    };
    expect(body.data).toBeNull();
    expect(body.message).toMatch(/3 times a day/);
    expect(body.message).not.toMatch(/\u2014/);

    // One listening server for the whole burst: supertest would otherwise
    // open 40 throwaway ones at once.
    const server = app.getHttpServer() as import('http').Server;
    if (!server.listening) {
      await new Promise<void>((resolve) => server.listen(0, resolve));
    }
    const burst = await Promise.all(Array.from({ length: 40 }, () => post()));
    expect(burst.every((r) => r.status === 429)).toBe(true);
    expect(
      await prisma.dataExportRequest.count({ where: { userWawuId: USER } }),
    ).toBe(3);
  });

  it('a user who made 3 requests a day ago can ask again, and one account hitting the limit does not block another', async () => {
    for (let i = 0; i < 3; i++) {
      await prisma.dataExportRequest.create({
        data: {
          userWawuId: USER,
          status: 'sent',
          requestedAt: new Date(Date.now() - (25 + i) * 3_600_000),
        },
      });
    }
    await post().expect(201);
    // Fill OTHER's window directly; USER is untouched by it.
    for (let i = 0; i < 3; i++) {
      await prisma.dataExportRequest.create({
        data: { userWawuId: OTHER, status: 'sent' },
      });
    }
    await post().expect(201);
  });
});
