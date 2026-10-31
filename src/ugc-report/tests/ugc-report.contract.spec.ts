import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { CommentModule } from '../../comment/comment.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { CommunityMessageModule } from '../../community-message/community-message.module';
import { ChatModule } from '../../chat/chat.module';
import { UgcReportModule } from '../ugc-report.module';
import { UgcReportMailService } from '../ugc-report-mail.service';
import { UgcReportService } from '../ugc-report.service';

/**
 * REPORT-UGC. POST /reports for each kind, the repeat, the reporter's own filter, and the moderators' queue.
 * Real mock-wawu-id (RS256 tokens over JWKS), the real database, and the mock WAWU ID's mail relay for the support mail
 * (read back through its outbox). Fixtures are created here with a unique tag.
 */

const MOCK = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');
// The support mail goes to a mock WAWU ID of this suite's own (its own port and service key), so the suite can read what
// it was asked to send whatever key the shared mock was started with.
const MAIL_PORT = 11795;
const MAIL_MOCK = `http://127.0.0.1:${MAIL_PORT}`;
const SERVICE_KEY = 'ugc-report-test-key';
const USER = '00000000-0000-4000-8000-000000000001';
const CREATOR_A = '00000000-0000-4000-8000-000000000002';
const CREATOR_B = '00000000-0000-4000-8000-000000000003';
const TAG = `ugc-${Date.now()}`;
const ADMIN_SUPER_ID = 'ac100000-0000-4000-8000-000000000001';
const ADMIN_SUPPORT_ID = 'ac100000-0000-4000-8000-000000000002';
const ADMIN_FINANCE_ID = 'ac100000-0000-4000-8000-000000000003';
const ADMIN_PASSWORD = 'ugc-report-contract-password';
const SUPER_EMAIL = 'ugc-super@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'ugc-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'ugc-finance@admin.test.wawu.dev';

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${MOCK}/health`)).ok;
  } catch {
    return false;
  }
}
async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('REPORT-UGC contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mail: UgcReportMailService;
  let child: ChildProcess | undefined;
  let mailChild: ChildProcess | undefined;
  const envSnapshot: Record<string, string | undefined> = {};
  let tUser: string;
  let tA: string;
  let tB: string;
  let superToken: string;
  let supportToken: string;
  let financeToken: string;

  let pieceA: string;
  let pieceA2: string;
  let commentA: string;
  let roomId: string;
  let roomMsgA: string;
  let chatId: string;
  let chatMsgA: string;
  let chatMsgUser: string;
  let dmId: string;

  beforeAll(async () => {
    if (!(await up())) {
      child = spawn('node', ['mock-wawu-id/server.js'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      for (let i = 0; i < 60 && !(await up()); i++)
        await new Promise((r) => setTimeout(r, 250));
    }
    [tUser, tA, tB] = await Promise.all([
      login('user@test.wawu.dev'),
      login('creator-basic@test.wawu.dev'),
      login('creator-pro@test.wawu.dev'),
    ]);
    for (const key of [
      'UGC_REPORT_MAIL_RETRY_MS',
      'WAWU_ID_INTERNAL_SERVICE_KEY',
      'WAWU_ID_BASE_URL',
      'ADMIN_JWT_SECRET',
      'ADMIN_JWT_REFRESH_SECRET',
      'STORAGE_ENDPOINT',
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY',
      'STORAGE_BUCKET',
      'STORAGE_REGION',
    ]) {
      envSnapshot[key] = process.env[key];
    }
    process.env.UGC_REPORT_MAIL_RETRY_MS = '5';
    process.env.WAWU_ID_INTERNAL_SERVICE_KEY = SERVICE_KEY;
    mailChild = spawn('node', ['mock-wawu-id/server.js'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        MOCK_WAWU_ID_PORT: String(MAIL_PORT),
        WAWU_ID_INTERNAL_SERVICE_KEY: SERVICE_KEY,
      },
    });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${MAIL_MOCK}/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    process.env.WAWU_ID_BASE_URL = MAIL_MOCK;
    process.env.ADMIN_JWT_SECRET = 'ugc-report-access-secret-0123456789';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'ugc-report-refresh-secret-0123456789';
    process.env.STORAGE_ENDPOINT = 'https://bucket.example-storage.dev';
    process.env.STORAGE_ACCESS_KEY_ID = 'contract-test-key';
    process.env.STORAGE_SECRET_ACCESS_KEY = 'contract-test-secret';
    process.env.STORAGE_BUCKET = 'contract-test-bucket';
    process.env.STORAGE_REGION = 'auto';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        ContentPieceModule,
        CommentModule,
        CommunityMessageModule,
        ChatModule,
        AdminAuthModule,
        UgcReportModule,
      ],
    }).compile();
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
    await app.init();
    prisma = moduleRef.get(PrismaService);
    mail = moduleRef.get(UgcReportMailService);

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(ADMIN_PASSWORD);
    await prisma.adminUser.deleteMany({
      where: {
        id: { in: [ADMIN_SUPER_ID, ADMIN_SUPPORT_ID, ADMIN_FINANCE_ID] },
      },
    });
    await prisma.adminUser.createMany({
      data: [
        {
          id: ADMIN_SUPER_ID,
          email: SUPER_EMAIL,
          name: 'Ugc Super',
          role: 'superadmin',
          passwordHash,
        },
        {
          id: ADMIN_SUPPORT_ID,
          email: SUPPORT_EMAIL,
          name: 'Ugc Support',
          role: 'support',
          passwordHash,
        },
        {
          id: ADMIN_FINANCE_ID,
          email: FINANCE_EMAIL,
          name: 'Ugc Finance',
          role: 'finance',
          passwordHash,
        },
      ],
    });
    const adminLogin = async (email: string) =>
      (
        await request(app.getHttpServer())
          .post('/api/hub/admin/auth/login')
          .send({ email, password: ADMIN_PASSWORD })
          .expect(200)
      ).body.data.accessToken as string;
    [superToken, supportToken, financeToken] = await Promise.all([
      adminLogin(SUPER_EMAIL),
      adminLogin(SUPPORT_EMAIL),
      adminLogin(FINANCE_EMAIL),
    ]);

    const piece = (n: string, creator: string) =>
      prisma.contentPiece.create({
        data: {
          slug: `${TAG}-${n}`,
          creatorWawuId: creator,
          contentType: 'video',
          title: `Report fixture ${n} ${TAG}`,
          description: 'A fixture piece',
          category: 'fixture',
          accessType: 'paid',
          price: 100,
          previewAssetUrl: 'https://example.invalid/p.jpg',
          status: 'live',
        },
        select: { id: true },
      });
    pieceA = (await piece('a', CREATOR_A)).id;
    pieceA2 = (await piece('a2', CREATOR_A)).id;
    commentA = (
      await prisma.comment.create({
        data: {
          contentId: pieceA2,
          authorWawuId: CREATOR_A,
          text: `rude comment ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
    await prisma.contentPiece.update({
      where: { id: pieceA2 },
      data: { commentCount: 1 },
    });
    roomId = (
      await prisma.community.create({
        data: {
          name: `Room ${TAG}`,
          description: 'x',
          hostWawuId: CREATOR_B,
          kind: 'open',
        },
        select: { id: true },
      })
    ).id;
    await prisma.communityMembership.createMany({
      data: [
        { userWawuId: USER, communityId: roomId, status: 'joined' },
        { userWawuId: CREATOR_A, communityId: roomId, status: 'joined' },
      ],
    });
    roomMsgA = (
      await prisma.communityMessage.create({
        data: {
          communityId: roomId,
          senderWawuId: CREATOR_A,
          text: `room insult ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
    const [ua, ub] = [USER, CREATOR_A].sort();
    chatId = (
      await prisma.chatConversation.create({
        data: { userAWawuId: ua, userBWawuId: ub },
        select: { id: true },
      })
    ).id;
    chatMsgA = (
      await prisma.chatMessage.create({
        data: {
          conversationId: chatId,
          senderWawuId: CREATOR_A,
          kind: 'text',
          text: `chat insult ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
    chatMsgUser = (
      await prisma.chatMessage.create({
        data: {
          conversationId: chatId,
          senderWawuId: USER,
          kind: 'text',
          text: `my own ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
    dmId = (
      await prisma.directMessage.create({
        data: {
          creatorWawuId: CREATOR_A,
          senderWawuId: USER,
          text: `paid question ${TAG}`,
          amount: 200,
          deadlineAt: new Date(Date.now() + 86_400_000),
          flutterwaveTxRef: `${TAG}-dm`,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await mail.settled();
    await prisma.ugcReport.deleteMany({
      where: {
        reporterWawuId: { in: [USER, CREATOR_A, CREATOR_B] },
        OR: [
          {
            targetId: {
              in: [
                pieceA,
                pieceA2,
                commentA,
                roomMsgA,
                chatMsgA,
                chatMsgUser,
                dmId,
              ],
            },
          },
          { kind: 'profile' },
        ],
      },
    });
    await prisma.userSuspension.deleteMany({
      where: { wawuUserId: { in: [USER, CREATOR_A, CREATOR_B] } },
    });
    await prisma.adminOpsAudit.deleteMany({
      where: {
        resource: 'user_suspension',
        subjectWawuId: { in: [USER, CREATOR_A, CREATOR_B] },
      },
    });
    await prisma.dmReport.deleteMany({ where: { threadId: dmId } });
    await prisma.directMessage.deleteMany({ where: { id: dmId } });
    await prisma.chatConversation.deleteMany({ where: { id: chatId } });
    await prisma.community.deleteMany({ where: { id: roomId } });
    await prisma.comment.deleteMany({ where: { id: commentA } });
    await prisma.contentPiece.deleteMany({
      where: { id: { in: [pieceA, pieceA2] } },
    });
    await prisma.adminUser.deleteMany({
      where: {
        id: { in: [ADMIN_SUPER_ID, ADMIN_SUPPORT_ID, ADMIN_FINANCE_ID] },
      },
    });
    await app.close();
    if (child) child.kill();
    if (mailChild) mailChild.kill();
    // The suites share one process: leave the environment as it was found.
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const post = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/api/hub/reports')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('needs a signed-in person', async () => {
    await request(app.getHttpServer())
      .post('/api/hub/reports')
      .send({})
      .expect(401);
  });

  it('reports a piece, and a repeat answers the same report (no error, no second row, no second mail)', async () => {
    const first = await post(tUser, {
      kind: 'piece',
      targetId: pieceA,
      reason: 'spam',
      note: ' too many ads ',
    }).expect(200);
    expect(first.body.data).toMatchObject({
      kind: 'piece',
      targetId: pieceA,
      reason: 'spam',
      status: 'open',
      alreadyReported: false,
    });
    const again = await post(tUser, {
      kind: 'piece',
      targetId: pieceA,
      reason: 'hate',
    }).expect(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.data.reason).toBe('spam');
    expect(again.body.data.alreadyReported).toBe(true);
    expect(
      await prisma.ugcReport.count({
        where: { reporterWawuId: USER, kind: 'piece', targetId: pieceA },
      }),
    ).toBe(1);
    const row = await prisma.ugcReport.findUniqueOrThrow({
      where: { id: first.body.data.id },
    });
    expect(row.note).toBe('too many ads');
    expect(row.subjectWawuId).toBe(CREATOR_A);
  });

  it('reports a comment, a profile, a community message, a chat message and a paid question', async () => {
    await post(tUser, {
      kind: 'comment',
      targetId: commentA,
      reason: 'harassment',
    }).expect(200);
    await post(tUser, {
      kind: 'profile',
      targetId: CREATOR_A,
      reason: 'impersonation',
    }).expect(200);
    await post(tUser, {
      kind: 'community_message',
      targetId: roomMsgA,
      reason: 'hate',
    }).expect(200);
    await post(tUser, {
      kind: 'chat_message',
      targetId: chatMsgA,
      reason: 'sexual',
    }).expect(200);
    const dm = await post(tUser, {
      kind: 'direct_message',
      targetId: dmId,
      reason: 'illegal',
    }).expect(200);
    expect(dm.body.data.alreadyReported).toBe(false);
    // The paid question's own report row is written too, so the older route stays whole.
    expect(
      await prisma.dmReport.count({
        where: { threadId: dmId, reporterWawuId: USER },
      }),
    ).toBe(1);
    const subjects = await prisma.ugcReport.findMany({
      where: {
        reporterWawuId: USER,
        targetId: { in: [commentA, roomMsgA, chatMsgA, dmId] },
      },
      select: { subjectWawuId: true },
    });
    expect(subjects.every((s) => s.subjectWawuId === CREATOR_A)).toBe(true);
  });

  it('refuses a bad reason, a bad kind, an unknown item, your own thing, and a room or chat you are not in', async () => {
    await post(tUser, {
      kind: 'piece',
      targetId: pieceA2,
      reason: 'rude',
    }).expect(400);
    await post(tUser, {
      kind: 'photo',
      targetId: pieceA2,
      reason: 'spam',
    }).expect(400);
    await post(tUser, {
      kind: 'piece',
      targetId: pieceA2,
      reason: 'spam',
      extra: 1,
    }).expect(400);
    await post(tUser, {
      kind: 'piece',
      targetId: '10000000-0000-4000-8000-0000000000ff',
      reason: 'spam',
    }).expect(404);
    await post(tA, { kind: 'piece', targetId: pieceA2, reason: 'spam' }).expect(
      400,
    );
    await post(tA, {
      kind: 'profile',
      targetId: CREATOR_A,
      reason: 'spam',
    }).expect(400);
    await post(tUser, {
      kind: 'chat_message',
      targetId: chatMsgUser,
      reason: 'spam',
    }).expect(400);
    // CREATOR_B is the host of the room but not in the chat between USER and CREATOR_A.
    await post(tB, {
      kind: 'chat_message',
      targetId: chatMsgA,
      reason: 'spam',
    }).expect(404);
    await post(tB, {
      kind: 'direct_message',
      targetId: dmId,
      reason: 'spam',
    }).expect(403);
    // USER is a member of the room; a person who is not in it cannot report its messages.
    await prisma.communityMembership.deleteMany({
      where: { communityId: roomId, userWawuId: CREATOR_A },
    });
    await post(tA, {
      kind: 'community_message',
      targetId: roomMsgA,
      reason: 'spam',
    }).expect(404);
  });

  it('mails support for each new report, once, through WAWU ID, and records it', async () => {
    await mail.settled();
    const row = await prisma.ugcReport.findFirstOrThrow({
      where: { reporterWawuId: USER, kind: 'piece', targetId: pieceA },
    });
    expect(row.emailedAt).not.toBeNull();
    const res = await fetch(`${MAIL_MOCK}/internal/mail-outbox`, {
      headers: { 'X-Service-Key': SERVICE_KEY },
    });
    expect(res.ok).toBe(true);
    const outbox = (
      (await res.json()) as {
        data: Array<{ to: string; subject: string; text: string }>;
      }
    ).data;
    const mine = outbox.filter((m) => (m.text ?? '').includes(row.id));
    // Exactly one mail for the piece report, though the person reported it twice (the repeat sent nothing).
    expect(mine).toHaveLength(1);
    expect(mine[0].to).toBe('support@wawuafrica.com');
    expect(mine[0].subject).toBe('Report: Piece (Spam or a scam)');
    expect(mine[0].text).toContain(`Reported by: ${USER}`);
  });

  it('hides what the reporter reported, for the reporter only (comments, the feed, a room, a chat)', async () => {
    const get = (token: string, url: string) =>
      request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    const ids = (body: { data: Array<{ id: string }> }) =>
      body.data.map((i) => i.id);

    // The comment USER reported is gone for USER (and not counted), still there for CREATOR_B.
    const mine = (await get(tUser, `/api/hub/content/${pieceA2}/comments`))
      .body;
    expect(ids(mine)).not.toContain(commentA);
    expect(mine.pagination.total).toBe(0);
    expect(
      ids((await get(tB, `/api/hub/content/${pieceA2}/comments`)).body),
    ).toContain(commentA);

    // USER reported pieceA and CREATOR_A's profile: none of CREATOR_A's pieces is in USER's feed. CREATOR_B sees both.
    const userFeed = ids(
      (await get(tUser, '/api/hub/content?perPage=100&sort=recent')).body,
    );
    expect(userFeed).not.toContain(pieceA);
    expect(userFeed).not.toContain(pieceA2);
    expect(
      ids((await get(tB, '/api/hub/content?perPage=100&sort=recent')).body),
    ).toEqual(expect.arrayContaining([pieceA, pieceA2]));
    // The ranked feed (the app's default) leaves it out too.
    expect(
      ids((await get(tUser, '/api/hub/content?perPage=100&sort=top')).body),
    ).not.toContain(pieceA);

    // The room: USER no longer sees the message USER reported; the host still does.
    expect(
      ids(
        (
          await get(
            tUser,
            `/api/hub/communities/${roomId}/messages?perPage=100`,
          )
        ).body,
      ),
    ).not.toContain(roomMsgA);
    expect(
      ids(
        (await get(tB, `/api/hub/communities/${roomId}/messages?perPage=100`))
          .body,
      ),
    ).toContain(roomMsgA);

    // The chat: USER no longer sees the message USER reported; CREATOR_A still sees their own.
    const chatIds = (body: { data: { items: Array<{ id: string }> } }) =>
      body.data.items.map((i) => i.id);
    expect(
      chatIds((await get(tUser, `/api/hub/chats/${chatId}/messages`)).body),
    ).not.toContain(chatMsgA);
    expect(
      chatIds((await get(tUser, `/api/hub/chats/${chatId}/messages`)).body),
    ).toContain(chatMsgUser);
    expect(
      chatIds((await get(tA, `/api/hub/chats/${chatId}/messages`)).body),
    ).toContain(chatMsgA);
  });

  describe("the moderators' queue", () => {
    const adminGet = (token: string, q = '') =>
      request(app.getHttpServer())
        .get(`/api/hub/admin/reports${q}`)
        .set('Authorization', `Bearer ${token}`);
    const resolve = (token: string, id: string, body: object) =>
      request(app.getHttpServer())
        .post(`/api/hub/admin/reports/${id}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('is for admins only, and finance is refused', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/admin/reports')
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/hub/admin/reports')
        .set('Authorization', `Bearer ${tUser}`)
        .expect(401);
      await adminGet(financeToken).expect(403);
      await adminGet(supportToken).expect(200);
      const firstId = (
        await prisma.ugcReport.findFirstOrThrow({
          where: { reporterWawuId: USER, kind: 'piece', targetId: pieceA },
        })
      ).id;
      await resolve(supportToken, firstId, { action: 'dismiss' }).expect(403);
    });

    it('lists one row per reported item with the item, the reporter and the count', async () => {
      // CREATOR_B reports the same piece: the row stays one, the count is 2.
      await post(tB, {
        kind: 'piece',
        targetId: pieceA,
        reason: 'illegal',
        note: 'second',
      }).expect(200);
      await mail.settled();
      const res = await adminGet(superToken, '?kind=piece&perPage=100').expect(
        200,
      );
      const row = res.body.data.find(
        (r: { targetId: string }) => r.targetId === pieceA,
      );
      expect(row).toMatchObject({
        kind: 'piece',
        count: 2,
        reason: 'spam',
        reasonLabel: 'Spam or a scam',
        canTakeDown: true,
        emailed: true,
        reporter: { wawuId: USER },
        subject: { wawuId: CREATOR_A },
        item: { exists: true, status: 'live' },
      });
      expect(row.item.title).toContain('Report fixture a');
      expect(
        res.body.data.filter(
          (r: { targetId: string }) => r.targetId === pieceA,
        ),
      ).toHaveLength(1);
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it('dismisses a report (every open report on the item), and it leaves the open list', async () => {
      const id = (
        await prisma.ugcReport.findFirstOrThrow({
          where: {
            reporterWawuId: USER,
            kind: 'community_message',
            targetId: roomMsgA,
          },
        })
      ).id;
      const done = await resolve(superToken, id, {
        action: 'dismiss',
        note: 'fine',
      }).expect(200);
      expect(done.body.data).toMatchObject({
        status: 'dismissed',
        resolved: 1,
      });
      const row = await prisma.ugcReport.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        status: 'dismissed',
        resolvedByAdminId: ADMIN_SUPER_ID,
        resolution: 'fine',
      });
      const list = await adminGet(
        superToken,
        '?kind=community_message&perPage=100',
      ).expect(200);
      expect(
        list.body.data.map((r: { targetId: string }) => r.targetId),
      ).not.toContain(roomMsgA);
      // A second click answers the outcome it has, settling nothing more.
      const again = await resolve(superToken, id, {
        action: 'take_down',
        note: 'late',
      }).expect(200);
      expect(again.body.data).toMatchObject({
        status: 'dismissed',
        resolved: 0,
      });
    });

    it('takes a piece down through the existing content take-down, settling both reports', async () => {
      const id = (
        await prisma.ugcReport.findFirstOrThrow({
          where: { reporterWawuId: USER, kind: 'piece', targetId: pieceA },
        })
      ).id;
      await resolve(superToken, id, { action: 'take_down' }).expect(409);
      const done = await resolve(superToken, id, {
        action: 'take_down',
        note: 'Breaks the rules',
      }).expect(200);
      expect(done.body.data).toMatchObject({ status: 'actioned', resolved: 2 });
      expect(
        (await prisma.contentPiece.findUniqueOrThrow({ where: { id: pieceA } }))
          .status,
      ).toBe('removed');
      expect(
        await prisma.adminContentReview.count({ where: { contentId: pieceA } }),
      ).toBeGreaterThan(0);
      expect(
        await prisma.ugcReport.count({
          where: { targetId: pieceA, status: 'actioned' },
        }),
      ).toBe(2);
    });

    it('deletes a reported comment (and gives the count back), a chat message; refuses a profile and a paid question', async () => {
      const take = async (kind: string, targetId: string) => {
        const id = (
          await prisma.ugcReport.findFirstOrThrow({
            where: { reporterWawuId: USER, kind, targetId },
          })
        ).id;
        return resolve(superToken, id, {
          action: 'take_down',
          note: 'Removed',
        });
      };
      await take('comment', commentA).then((r) => expect(r.status).toBe(200));
      expect(await prisma.comment.count({ where: { id: commentA } })).toBe(0);
      expect(
        (
          await prisma.contentPiece.findUniqueOrThrow({
            where: { id: pieceA2 },
          })
        ).commentCount,
      ).toBe(0);
      await take('chat_message', chatMsgA).then((r) =>
        expect(r.status).toBe(200),
      );
      expect(await prisma.chatMessage.count({ where: { id: chatMsgA } })).toBe(
        0,
      );
      // USER-SUSPEND (R-121) changes this one assertion: `take_down` on a reported PROFILE used to answer 409 ("cannot be
      // taken down"); it now suspends the person (the profile row stays; nothing is deleted).
      await take('profile', CREATOR_A).then((r) => {
        expect(r.status).toBe(200);
        expect(r.body.data.suspended).toBe(true);
      });
      await take('direct_message', dmId).then((r) => {
        expect(r.status).toBe(409);
        expect(r.body.message).toContain('cannot be taken down');
      });
      expect(
        await prisma.userProfile.count({ where: { wawuUserId: CREATOR_A } }),
      ).toBe(1);
      // The paid question stays open until a moderator dismisses it; the profile report is settled.
      expect(
        await prisma.ugcReport.count({
          where: {
            reporterWawuId: USER,
            kind: { in: ['profile', 'direct_message'] },
            status: 'open',
          },
        }),
      ).toBe(1);
      // Leave the seeded creator as the spec found them.
      await prisma.userSuspension.deleteMany({
        where: { wawuUserId: CREATOR_A },
      });
    });
  });
});
