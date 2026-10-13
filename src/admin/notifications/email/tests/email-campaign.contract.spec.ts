/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../../common/prisma/prisma.module';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../../auth/admin-auth.module';
import { AdminNotificationsModule } from '../../admin-notifications.module';
import { EmailSendingService } from '../email-sending.service';
import { signUnsubscribeToken } from '../email-unsubscribe';

/**
 * EMAIL-01 against a real database and a local stand-in for Resend's
 * POST /emails (never Resend itself). Proves: the missing-key 409, the roles,
 * a CSV becoming a campaign, the send (once each, headers, unsubscribe link),
 * suppression after an unsubscribe, the once-only claim, and the retry.
 */

const SECRET = 'email-campaign-access-secret-0123456789abcdef';
const ID = (n: number) => `e1a10000-0000-4000-8000-00000000000${n}`;
const ADMINS = [
  {
    id: ID(1),
    email: 'em01-super@admin.test.wawu.dev',
    role: 'superadmin' as const,
  },
  {
    id: ID(2),
    email: 'em01-reviewer@admin.test.wawu.dev',
    role: 'reviewer' as const,
  },
  {
    id: ID(3),
    email: 'em01-support@admin.test.wawu.dev',
    role: 'support' as const,
  },
];
const PASSWORD = 'email-campaign-contract-password';
const DOMAIN = '@em01.test.wawu.dev';

interface Captured {
  headers: IncomingMessage['headers'];
  body: {
    from: string;
    to: string[];
    subject: string;
    html: string;
    text: string;
    headers: Record<string, string>;
  };
}

describe('EMAIL-01 email campaigns', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sending: EmailSendingService;
  let standIn: Server;
  let captured: Captured[] = [];
  /** Statuses the stand-in answers with, one per request, then 200. */
  let script: number[] = [];
  const tokens: Record<string, string> = {};
  const envBefore: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const P = '/api/hub/admin/notifications/email';

  async function sweep() {
    await prisma.emailCampaign.deleteMany({
      where: { createdBy: { in: ADMINS.map((a) => a.id) } },
    });
    await prisma.emailTemplate.deleteMany({
      where: { createdBy: { in: ADMINS.map((a) => a.id) } },
    });
    await prisma.emailSuppression.deleteMany({
      where: { email: { endsWith: DOMAIN } },
    });
    await prisma.waitlistRegistration.deleteMany({
      where: { email: { endsWith: DOMAIN } },
    });
  }

  beforeAll(async () => {
    for (const k of [
      'ADMIN_JWT_SECRET',
      'ADMIN_JWT_REFRESH_SECRET',
      'RESEND_API_KEY',
      'RESEND_BASE_URL',
    ]) {
      envBefore[k] = process.env[k];
    }
    process.env.ADMIN_JWT_SECRET = SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = `${SECRET}-refresh`;
    delete process.env.RESEND_API_KEY;

    standIn = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const status = script.shift() ?? 200;
        if (status === 200) {
          captured.push({ headers: req.headers, body: JSON.parse(raw) });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: `stand-in-${captured.length}` }));
        } else {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              message: status === 422 ? 'Invalid `to` field.' : 'Try later.',
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => standIn.listen(0, '127.0.0.1', r));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminNotificationsModule,
        WawuAuthModule,
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
    prisma = app.get(PrismaService);
    sending = app.get(EmailSendingService);
    sending.retrySleep = async () => undefined;

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({
      where: {
        OR: [
          { id: { in: ADMINS.map((a) => a.id) } },
          { email: { in: ADMINS.map((a) => a.email) } },
        ],
      },
    });
    await prisma.adminUser.createMany({
      data: ADMINS.map((a) => ({
        id: a.id,
        email: a.email,
        passwordHash,
        name: a.role,
        role: a.role,
      })),
    });
    for (const a of ADMINS) {
      const res = await http()
        .post('/api/hub/admin/auth/login')
        .send({ email: a.email, password: PASSWORD })
        .expect(200);
      tokens[a.role] = res.body.data.accessToken as string;
    }
    await sweep();
  }, 60_000);

  afterAll(async () => {
    await sweep();
    await prisma.adminUser.deleteMany({
      where: { id: { in: ADMINS.map((a) => a.id) } },
    });
    await app.close();
    await new Promise((r) => standIn.close(r));
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    captured = [];
    script = [];
    await prisma.emailSuppression.deleteMany({
      where: { email: { endsWith: DOMAIN } },
    });
  });

  async function newTemplate(over: Record<string, unknown> = {}) {
    const res = await http()
      .post(`${P}/templates`)
      .set(auth('superadmin'))
      .send({
        name: 'Join link',
        subject: 'Hi {{first_name}}, your WAWU invite',
        previewText: 'Register now',
        body: 'Hello {{first_name}},\n\n[Join WAWU]({{join_link}})',
        ...over,
      })
      .expect(200);
    return res.body.data as { id: string; version: number };
  }

  async function csvCampaign(templateId: string, csv: string, limit?: number) {
    const req = http()
      .post(`${P}/campaigns/csv`)
      .set(auth('superadmin'))
      .field('templateId', templateId);
    if (limit) req.field('limit', String(limit));
    const res = await req
      .attach('file', Buffer.from(csv), 'people.csv')
      .expect(200);
    return res.body.data as Record<string, number | string>;
  }

  async function untilSent(id: string) {
    for (let i = 0; i < 100; i++) {
      const res = await http()
        .get(`${P}/campaigns/${id}`)
        .set(auth('superadmin'))
        .expect(200);
      if (res.body.data.status === 'sent')
        return res.body.data as Record<string, number | string>;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the campaign did not finish');
  }

  const five = [
    'email,first_name',
    ...[1, 2, 3, 4, 5].map((n) => `p${n}${DOMAIN},Person${n}`),
  ].join('\n');

  it('keeps support and finance out, and sending to superadmin', async () => {
    await http().get(`${P}/templates`).set(auth('support')).expect(403);
    await http().get(`${P}/templates`).expect(401);
    const t = await newTemplate();
    const c = await csvCampaign(t.id, five);
    await http()
      .post(`${P}/campaigns/${c.id}/start`)
      .set(auth('reviewer'))
      .expect(403);
    await http()
      .post(`${P}/test-send`)
      .set(auth('reviewer'))
      .send({ to: `a${DOMAIN}`, subject: 's', body: 'b' })
      .expect(403);
  });

  it('answers 409 and sends nothing while RESEND_API_KEY is unset', async () => {
    const t = await newTemplate();
    const c = await csvCampaign(t.id, five);
    const res = await http()
      .post(`${P}/campaigns/${c.id}/start`)
      .set(auth('superadmin'))
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('RESEND_API_KEY is not set');
    const test = await http()
      .post(`${P}/test-send`)
      .set(auth('superadmin'))
      .send({ to: `a${DOMAIN}`, subject: 's', body: 'b' })
      .expect(409);
    expect(JSON.stringify(test.body)).toContain('RESEND_API_KEY is not set');
    expect(captured).toHaveLength(0);
    const after = await prisma.emailCampaign.findUniqueOrThrow({
      where: { id: c.id as string },
    });
    expect(after.status).toBe('ready');
  });

  it('saves a template, previews it, and refuses an em-dash', async () => {
    const t = await newTemplate();
    const upd = await http()
      .patch(`${P}/templates/${t.id}`)
      .set(auth('reviewer'))
      .send({
        name: 'Join link',
        subject: 'New {{first_name}}',
        body: 'Body',
        version: 1,
      })
      .expect(200);
    expect(upd.body.data.version).toBe(2);
    await http()
      .patch(`${P}/templates/${t.id}`)
      .set(auth('reviewer'))
      .send({ name: 'x', subject: 's', body: 'b', version: 1 })
      .expect(409);
    const pre = await http()
      .post(`${P}/preview`)
      .set(auth('reviewer'))
      .send({
        subject: 'Hi {{first_name}}',
        body: '[Go]({{join_link}})',
        firstName: 'Ada',
      })
      .expect(200);
    expect(pre.body.data.subject).toBe('Hi Ada');
    expect(pre.body.data.html).toContain('https://wawuafrica.com/join');
    await http()
      .post(`${P}/templates`)
      .set(auth('superadmin'))
      .send({ name: 'x', subject: 'a — b', body: 'b' })
      .expect(400);
  });

  it('builds a campaign from a CSV: bad rows, repeats, suppressed people and the limit', async () => {
    await prisma.emailSuppression.create({
      data: { email: `p2${DOMAIN}`, reason: 'unsubscribed' },
    });
    const t = await newTemplate();
    const csv = `${five}\nnot-an-email,X\nP1${DOMAIN},Again`;
    const full = await csvCampaign(t.id, csv);
    expect(full).toMatchObject({
      status: 'ready',
      invalidCount: 1,
      duplicateCount: 1,
      totalCount: 5,
      queuedCount: 4,
      skippedCount: 1,
      unsubscribedCount: 1,
    });
    const limited = await csvCampaign(t.id, five, 2);
    expect(limited).toMatchObject({ queuedCount: 2, skippedCount: 1 });
    await http()
      .post(`${P}/campaigns/csv`)
      .set(auth('superadmin'))
      .field('templateId', t.id)
      .attach('file', Buffer.from('name\nAda'), 'x.csv')
      .expect(400);
  });

  it('builds a campaign from /join registrants by status', async () => {
    const mk = (
      n: number,
      status: 'paid' | 'pending',
      optIn: boolean | null,
    ) => ({
      offerId: 'em01-test-offer',
      fullName: `Reg Person${n}`,
      phone: `+2348000${n}${Date.now() % 100000}`,
      email: `reg${n}${DOMAIN}`,
      consentAt: new Date(),
      reference: `wawu-join-${randomUUID().replace(/-/g, '')}`,
      status,
      amountKobo: 200000,
      updatesOptIn: optIn,
      ...(status === 'paid'
        ? {
            flutterwaveTxId: `em01-${randomUUID()}`,
            paidAt: new Date(),
            paidKobo: 200000,
          }
        : {}),
    });
    await prisma.waitlistRegistration.createMany({
      data: [
        mk(1, 'paid', true),
        mk(2, 'pending', false),
        mk(3, 'pending', true),
      ],
    });
    const t = await newTemplate();
    const count = (filter: string) =>
      http()
        .get(`${P}/audiences/registrants?filter=${filter}`)
        .set(auth('superadmin'))
        .expect(200)
        .then((r) => r.body.data.matching as number);
    expect(await count('paid')).toBeGreaterThanOrEqual(1);
    expect(await count('not_paid')).toBeGreaterThanOrEqual(2);
    const res = await http()
      .post(`${P}/campaigns/registrants`)
      .set(auth('superadmin'))
      .send({ templateId: t.id, filter: 'opted_in', limit: 1 })
      .expect(200);
    expect(res.body.data.queuedCount).toBe(1);
  });

  describe('with a key', () => {
    beforeAll(() => {
      process.env.RESEND_API_KEY = 're_test_local_stand_in';
    });
    afterAll(() => {
      delete process.env.RESEND_API_KEY;
    });

    it('sends a test email to one address and marks it as a test', async () => {
      await http()
        .post(`${P}/test-send`)
        .set(auth('superadmin'))
        .send({
          to: `Me${DOMAIN}`,
          subject: 'Hi {{first_name}}',
          body: '[Go]({{join_link}})',
          firstName: 'Ada',
        })
        .expect(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].body.subject).toBe('[Test] Hi Ada');
      expect(captured[0].body.to).toEqual([`me${DOMAIN}`]);
      expect(captured[0].headers.authorization).toBe(
        'Bearer re_test_local_stand_in',
      );
    });

    it('sends each person once, with the unsubscribe link and headers, then skips an unsubscribed one', async () => {
      const t = await newTemplate();
      const c = await csvCampaign(t.id, five);
      const started = await http()
        .post(`${P}/campaigns/${c.id}/start`)
        .set(auth('superadmin'))
        .expect(200);
      expect(['sending', 'sent']).toContain(started.body.data.status);
      const done = await untilSent(c.id as string);
      expect(done).toMatchObject({
        sentCount: 5,
        failedCount: 0,
        skippedCount: 0,
        queuedCount: 0,
      });
      expect(captured).toHaveLength(5);
      expect(new Set(captured.map((m) => m.body.to[0])).size).toBe(5);
      const first = captured.find((m) => m.body.to[0] === `p1${DOMAIN}`)!;
      expect(first.body.from).toBe('WAWUAfrica <noreply@wawuafrica.com>');
      expect(first.body.subject).toBe('Hi Person1, your WAWU invite');
      expect(first.body.headers['List-Unsubscribe']).toMatch(
        /^<http.*\/api\/hub\/email\/unsubscribe\?t=.+>$/,
      );
      expect(first.body.headers['List-Unsubscribe-Post']).toBe(
        'List-Unsubscribe=One-Click',
      );
      expect(first.body.html).toContain('/api/hub/email/unsubscribe?t=');
      expect(first.body.text).toContain('Unsubscribe: http');
      await http()
        .post(`${P}/campaigns/${c.id}/start`)
        .set(auth('superadmin'))
        .expect(409);

      // A GET (a mail scanner opening the link) shows a confirmation and
      // leaves the address subscribed; only the POST suppresses it.
      const link = /unsubscribe\?t=([^"&\s]+)/.exec(first.body.html)![1];
      const url = `/api/hub/email/unsubscribe?t=${link}`;
      const ask = await http().get(url).expect(200);
      expect(ask.text).toContain(
        'Unsubscribe p***@em01.test.wawu.dev from WAWU emails?',
      );
      expect(ask.text).toContain('method="post"');
      expect(
        await prisma.emailSuppression.count({
          where: { email: `p1${DOMAIN}` },
        }),
      ).toBe(0);
      await http().get(url).expect(200);
      expect(
        await prisma.emailSuppression.count({
          where: { email: `p1${DOMAIN}` },
        }),
      ).toBe(0);
      const bye = await http().post(url).expect(200);
      expect(bye.text).toContain('You are unsubscribed.');
      expect(
        await prisma.emailSuppression.count({
          where: { email: `p1${DOMAIN}` },
        }),
      ).toBe(1);
      await http().post(url).expect(200);
      // The one-click POST a mail app sends suppresses too.
      await http()
        .post(
          `/api/hub/email/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(`p3${DOMAIN}`, SECRET))}`,
        )
        .type('form')
        .send('List-Unsubscribe=One-Click')
        .expect(200);
      await http().get('/api/hub/email/unsubscribe?t=bad.token').expect(400);
      await http().post('/api/hub/email/unsubscribe?t=bad.token').expect(400);
      expect(
        await prisma.emailSuppression.count({
          where: { email: { in: [`p1${DOMAIN}`, `p3${DOMAIN}`] } },
        }),
      ).toBe(2);

      captured = [];
      const again = await csvCampaign(t.id, five);
      expect(again).toMatchObject({
        queuedCount: 3,
        skippedCount: 2,
        unsubscribedCount: 2,
      });
      await http()
        .post(`${P}/campaigns/${again.id}/start`)
        .set(auth('superadmin'))
        .expect(200);
      const second = await untilSent(again.id as string);
      expect(second).toMatchObject({
        sentCount: 3,
        skippedCount: 2,
        unsubscribedCount: 2,
      });
      expect(captured.map((m) => m.body.to[0])).not.toContain(`p1${DOMAIN}`);
      const skipped = await http()
        .get(`${P}/campaigns/${again.id}/recipients?status=skipped`)
        .set(auth('superadmin'))
        .expect(200);
      expect(skipped.body.data).toHaveLength(2);
    });

    it('skips someone who unsubscribes after the campaign was built but before their turn', async () => {
      const t = await newTemplate();
      const c = await csvCampaign(t.id, five);
      await prisma.emailSuppression.create({
        data: { email: `p4${DOMAIN}`, reason: 'unsubscribed' },
      });
      await http()
        .post(`${P}/campaigns/${c.id}/start`)
        .set(auth('superadmin'))
        .expect(200);
      const done = await untilSent(c.id as string);
      expect(done).toMatchObject({ sentCount: 4, skippedCount: 1 });
      expect(captured.map((m) => m.body.to[0])).not.toContain(`p4${DOMAIN}`);
    });

    it('claims a recipient before sending: three workers on one row send one email', async () => {
      const t = await newTemplate();
      const c = await csvCampaign(t.id, `email\nsolo${DOMAIN}`);
      const r = await prisma.emailRecipient.findFirstOrThrow({
        where: { campaignId: c.id as string },
      });
      const outcomes = await Promise.all(
        [1, 2, 3].map(() => sending.processRecipient(c.id as string, r.id)),
      );
      expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'not_claimed')).toHaveLength(2);
      expect(captured).toHaveLength(1);
      expect(await sending.processRecipient(c.id as string, r.id)).toBe(
        'not_claimed',
      );
      expect(captured).toHaveLength(1);
    });

    it('never resends a recipient that was claimed by a run that died', async () => {
      const t = await newTemplate();
      const c = await csvCampaign(t.id, `email\ndied${DOMAIN}\nlive${DOMAIN}`);
      const died = await prisma.emailRecipient.findFirstOrThrow({
        where: { campaignId: c.id as string, email: `died${DOMAIN}` },
      });
      await prisma.emailRecipient.update({
        where: { id: died.id },
        data: { claimedAt: new Date() },
      });
      await prisma.emailCampaign.update({
        where: { id: c.id as string },
        data: { status: 'sending' },
      });
      await sending.run(c.id as string);
      expect(captured.map((m) => m.body.to[0])).toEqual([`live${DOMAIN}`]);
      const after = await prisma.emailRecipient.findUniqueOrThrow({
        where: { id: died.id },
      });
      expect(after.status).toBe('failed');
      expect(after.error).toContain('Not sent again');
    });

    it('retries a transient failure once and does not retry a refusal', async () => {
      const t = await newTemplate();
      const c = await csvCampaign(t.id, `email\nretry${DOMAIN}`);
      script = [503, 429];
      await http()
        .post(`${P}/campaigns/${c.id}/start`)
        .set(auth('superadmin'))
        .expect(200);
      expect(await untilSent(c.id as string)).toMatchObject({
        sentCount: 1,
        failedCount: 0,
      });
      expect(captured).toHaveLength(1);

      captured = [];
      const bad = await csvCampaign(t.id, `email\nrefused${DOMAIN}`);
      script = [422];
      await http()
        .post(`${P}/campaigns/${bad.id}/start`)
        .set(auth('superadmin'))
        .expect(200);
      const done = await untilSent(bad.id as string);
      expect(done).toMatchObject({ sentCount: 0, failedCount: 1 });
      expect(captured).toHaveLength(0);
      const rows = await http()
        .get(`${P}/campaigns/${bad.id}/recipients?status=failed`)
        .set(auth('superadmin'))
        .expect(200);
      expect(rows.body.data[0].error).toContain('Invalid');
    });
  });
});
