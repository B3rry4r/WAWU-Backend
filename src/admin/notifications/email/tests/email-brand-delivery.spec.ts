/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { ConflictException, INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../../common/prisma/prisma.module';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EmailCampaignService } from '../email-campaign.service';
import { VOICES_NOT_LIVE } from '../email-config';
import { EmailEventsService } from '../email-events.service';
import { ResendClient, WawuIdMailRelay } from '../email-provider';
import {
  EmailSendingService,
  PAUSE_WORDS,
  nextUtcMidnight,
} from '../email-sending.service';
import { PublicEmailUnsubscribeController } from '../email-unsubscribe.controller';
import { signUnsubscribeToken } from '../email-unsubscribe';
import { svixSign } from '../email-webhook';
import { ResendWebhookController } from '../email-webhook.controller';
import { ResendWebhookGuard } from '../email-webhook.guard';

/**
 * EMAIL-03 against a real database, with stand-ins for every provider (a
 * spied fetch and a spied relay; nothing leaves the machine).
 */
const SECRET = 'email03-secret-0123456789abcdef0123456789';
const WH = `whsec_${Buffer.from('email03-webhook-key').toString('base64')}`;
const D = '@em03.test.wawu.dev';
const ADMIN = { id: 'em03-admin', email: `a${D}`, role: 'superadmin' } as never;

describe('EMAIL-03 delivery, brand, limits and audiences', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sending: EmailSendingService;
  let svc: EmailCampaignService;
  let relay: WawuIdMailRelay;
  const env: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());

  const sweep = async () => {
    await prisma.emailCampaign.deleteMany({
      where: { createdBy: 'em03-admin' },
    });
    await prisma.emailTemplate.deleteMany({
      where: { createdBy: 'em03-admin' },
    });
    await prisma.emailSuppression.deleteMany({
      where: { email: { endsWith: D } },
    });
    await prisma.emailBrandSuppression.deleteMany({
      where: { email: { endsWith: D } },
    });
    await prisma.emailEvent.deleteMany({
      where: { svixId: { startsWith: 'em03-' } },
    });
    await prisma.userSuspension.deleteMany({
      where: { wawuUserId: { startsWith: 'em03-' } },
    });
  };

  beforeAll(async () => {
    for (const k of [
      'ADMIN_JWT_SECRET',
      'RESEND_API_KEY',
      'RESEND_WEBHOOK_SECRET',
      'WAWU_ID_BASE_URL',
      'WAWU_ID_INTERNAL_SERVICE_KEY',
      'VOICES_API_BASE_URL',
      'VOICES_INTERNAL_SERVICE_KEY',
      'HUB_PUBLIC_URL',
    ])
      env[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = SECRET;
    process.env.WAWU_ID_BASE_URL = 'http://relay.invalid';
    process.env.WAWU_ID_INTERNAL_SERVICE_KEY = 'k';
    process.env.HUB_PUBLIC_URL = 'https://hub.example.test';
    delete process.env.RESEND_API_KEY;
    delete process.env.VOICES_API_BASE_URL;
    delete process.env.VOICES_INTERNAL_SERVICE_KEY;
    process.env.RESEND_WEBHOOK_SECRET = WH;
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
      ],
      controllers: [ResendWebhookController, PublicEmailUnsubscribeController],
      providers: [
        EmailSendingService,
        EmailCampaignService,
        EmailEventsService,
        ResendWebhookGuard,
        ResendClient,
        WawuIdMailRelay,
      ],
    }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/hub');
    await app.init();
    prisma = mod.get(PrismaService);
    sending = mod.get(EmailSendingService);
    svc = mod.get(EmailCampaignService);
    relay = mod.get(WawuIdMailRelay);
    sending.pacer = { acquire: async () => undefined } as never;
    sending.retrySleep = async () => undefined;
    await sweep();
  });
  afterAll(async () => {
    await sweep();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    process.env.RESEND_WEBHOOK_SECRET = WH;
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  async function campaign(emails: string[], brand: 'wmt' | 'voices' = 'wmt') {
    const c = await prisma.emailCampaign.create({
      data: {
        templateName: 't',
        subject: 'S',
        body: 'B',
        brand,
        audienceKind: 'csv',
        audienceNote: 'x',
        createdBy: 'em03-admin',
        status: 'sending',
        totalCount: emails.length,
        recipients: {
          create: emails.map((e, i) => ({
            email: `${e}${D}`,
            createdAt: new Date(Date.now() + i),
          })),
        },
      },
    });
    return c.id;
  }
  const post = (
    body: unknown,
    id: string,
    over: Record<string, string | null> = {},
  ) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = svixSign(WH, id, ts, raw);
    const h: Record<string, string | null> = {
      'svix-id': id,
      'svix-timestamp': ts,
      'svix-signature': sig,
      'content-type': 'application/json',
      ...over,
    };
    let r = http().post('/api/hub/webhooks/resend');
    for (const [k, v] of Object.entries(h)) if (v !== null) r = r.set(k, v);
    return r.send(raw);
  };
  const ev = (
    type: string,
    providerId: string,
    to: string,
    extra: object = {},
  ) => ({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: providerId, to: [to], ...extra },
  });
  const rec = (c: string, e: string) =>
    prisma.emailRecipient.findFirstOrThrow({
      where: { campaignId: c, email: `${e}${D}` },
    });

  // ── webhook ────────────────────────────────────────────────────────────────
  describe('POST /webhooks/resend', () => {
    it('401 and nothing written for unsigned, bad signature, old timestamp', async () => {
      const body = ev('email.delivered', 'p-x', `x${D}`);
      await post(body, 'em03-a', { 'svix-signature': null }).expect(401);
      await post(body, 'em03-b', { 'svix-signature': 'v1,AAAA' }).expect(401);
      const old = String(Math.floor(Date.now() / 1000) - 600);
      await post(body, 'em03-c', {
        'svix-timestamp': old,
        'svix-signature': svixSign(WH, 'em03-c', old, JSON.stringify(body)),
      }).expect(401);
      expect(
        await prisma.emailEvent.count({
          where: { svixId: { in: ['em03-a', 'em03-b', 'em03-c'] } },
        }),
      ).toBe(0);
    });

    it('503 and nothing written when the secret is unset', async () => {
      delete process.env.RESEND_WEBHOOK_SECRET;
      await post(ev('email.delivered', 'p-x', `x${D}`), 'em03-d').expect(503);
      expect(
        await prisma.emailEvent.count({ where: { svixId: 'em03-d' } }),
      ).toBe(0);
    });

    it('stores an event, marks the recipient, and a repeat svix-id changes nothing', async () => {
      const c = await campaign(['one']);
      await prisma.emailRecipient.updateMany({
        where: { campaignId: c },
        data: { status: 'sent', providerId: 'p-one' },
      });
      await post(ev('email.delivered', 'p-one', `one${D}`), 'em03-e').expect(
        200,
      );
      expect((await rec(c, 'one')).delivery).toBe('delivered');
      await prisma.emailRecipient.updateMany({
        where: { campaignId: c },
        data: { delivery: null },
      });
      const again = await post(
        ev('email.delivered', 'p-one', `one${D}`),
        'em03-e',
      ).expect(200);
      expect(again.body.data?.result ?? again.body.result).toBe('duplicate');
      expect((await rec(c, 'one')).delivery).toBeNull();
      expect(
        await prisma.emailEvent.count({ where: { svixId: 'em03-e' } }),
      ).toBe(1);
    });

    it('a stronger result is never overwritten by a weaker one, in any order', async () => {
      const c = await campaign(['ord']);
      await prisma.emailRecipient.updateMany({
        where: { campaignId: c },
        data: { status: 'sent', providerId: 'p-ord' },
      });
      const order = [
        'email.delivered',
        'email.delivery_delayed',
        'email.bounced',
        'email.delivered',
        'email.failed',
        'email.complained',
        'email.bounced',
        'email.delivered',
      ];
      const seen: Array<string | null> = [];
      let n = 0;
      for (const t of order) {
        await post(
          ev(t, 'p-ord', `ord${D}`, {
            bounce: { type: 'Transient', message: 'full' },
          }),
          `em03-o${n++}`,
        ).expect(200);
        seen.push((await rec(c, 'ord')).delivery);
      }
      expect(seen).toEqual([
        'delivered',
        'delivered',
        'bounced',
        'bounced',
        'bounced',
        'complained',
        'complained',
        'complained',
      ]);
      const v = await svc.detail(c);
      expect(v).toMatchObject({
        complainedCount: 1,
        deliveredCount: 0,
        bouncedCount: 0,
        sentCount: 1,
      });
    });

    it('failed beats delivered and delayed; delayed arrives first and is replaced', async () => {
      const c = await campaign(['fl']);
      await prisma.emailRecipient.updateMany({
        where: { campaignId: c },
        data: { status: 'sent', providerId: 'p-fl' },
      });
      await post(
        ev('email.delivery_delayed', 'p-fl', `fl${D}`),
        'em03-f1',
      ).expect(200);
      expect((await rec(c, 'fl')).delivery).toBe('delayed');
      await post(
        ev('email.failed', 'p-fl', `fl${D}`, {
          failed: { reason: 'Template error' },
        }),
        'em03-f2',
      ).expect(200);
      await post(ev('email.delivered', 'p-fl', `fl${D}`), 'em03-f3').expect(
        200,
      );
      const r = await rec(c, 'fl');
      expect(r.delivery).toBe('failed');
      expect(r.deliveryNote).toBe('Template error');
    });

    it('a permanent bounce and a complaint suppress the address, a transient bounce only notes', async () => {
      const c = await campaign(['perm', 'comp', 'soft']);
      for (const e of ['perm', 'comp', 'soft'])
        await prisma.emailRecipient.updateMany({
          where: { campaignId: c, email: `${e}${D}` },
          data: { status: 'sent', providerId: `p-${e}` },
        });
      await post(
        ev('email.bounced', 'p-perm', `perm${D}`, {
          bounce: { type: 'Permanent', message: 'Mailbox does not exist' },
        }),
        'em03-s1',
      ).expect(200);
      await post(
        ev('email.complained', 'p-comp', `comp${D}`),
        'em03-s2',
      ).expect(200);
      await post(
        ev('email.bounced', 'p-soft', `soft${D}`, {
          bounce: { type: 'Transient', message: 'Mailbox full' },
        }),
        'em03-s3',
      ).expect(200);
      const sup = async (e: string) =>
        (
          await prisma.emailSuppression.findUnique({
            where: { email: `${e}${D}` },
          })
        )?.reason ?? null;
      expect(await sup('perm')).toBe('bounced');
      expect(await sup('comp')).toBe('complained');
      expect(await sup('soft')).toBeNull();
      expect((await rec(c, 'soft')).deliveryNote).toBe('Mailbox full');
      expect((await rec(c, 'perm')).deliveryNote).toBe(
        'Mailbox does not exist',
      );
    });

    it('mail the Hub did not send is stored and ignored, except the suppression rule', async () => {
      await post(ev('email.delivered', 'p-otp', `otp${D}`), 'em03-u1').expect(
        200,
      );
      await post(
        ev('email.bounced', 'p-otp2', `otp2${D}`, {
          bounce: { type: 'Permanent' },
        }),
        'em03-u2',
      ).expect(200);
      expect(
        await prisma.emailEvent.count({
          where: { svixId: { in: ['em03-u1', 'em03-u2'] } },
        }),
      ).toBe(2);
      expect(
        await prisma.emailSuppression.findUnique({
          where: { email: `otp${D}` },
        }),
      ).toBeNull();
      expect(
        (
          await prisma.emailSuppression.findUnique({
            where: { email: `otp2${D}` },
          })
        )?.reason,
      ).toBe('bounced');
    });

    it('the recipients list filters by delivery', async () => {
      const c = await campaign(['d1', 'd2']);
      await prisma.emailRecipient.updateMany({
        where: { campaignId: c, email: `d1${D}` },
        data: { delivery: 'bounced', deliveryNote: 'gone' },
      });
      const rows = await svc.recipients(c, {
        page: 1,
        perPage: 20,
        delivery: 'bounced',
      } as never);
      expect(rows.items.map((r) => r.email)).toEqual([`d1${D}`]);
      expect(rows.items[0]).toMatchObject({
        delivery: 'bounced',
        deliveryNote: 'gone',
      });
    });
  });

  // ── unsubscribe ────────────────────────────────────────────────────────────
  describe('unsubscribe per brand', () => {
    it('an old token (no brand) writes EmailSuppression, as today', async () => {
      const t = signUnsubscribeToken(`old${D}`, SECRET);
      const page = await http()
        .get(`/api/hub/email/unsubscribe?t=${encodeURIComponent(t)}`)
        .expect(200);
      expect(page.text).toContain('WAWU emails');
      const done = await http()
        .post(`/api/hub/email/unsubscribe?t=${encodeURIComponent(t)}`)
        .expect(200);
      expect(done.text).toContain('You are unsubscribed.');
      expect(done.text).not.toContain('Voices');
      expect(
        (
          await prisma.emailSuppression.findUnique({
            where: { email: `old${D}` },
          })
        )?.reason,
      ).toBe('unsubscribed');
    });

    it('a voices token writes EmailBrandSuppression and says Voices', async () => {
      const t = signUnsubscribeToken(`vo${D}`, SECRET, 'voices');
      const page = await http()
        .get(`/api/hub/email/unsubscribe?t=${encodeURIComponent(t)}`)
        .expect(200);
      expect(page.text).toContain('Voices');
      const done = await http()
        .post(`/api/hub/email/unsubscribe?t=${encodeURIComponent(t)}`)
        .expect(200);
      expect(done.text).toContain('Voices');
      expect(
        await prisma.emailSuppression.findUnique({
          where: { email: `vo${D}` },
        }),
      ).toBeNull();
      expect(
        await prisma.emailBrandSuppression.findUnique({
          where: { email_brand: { email: `vo${D}`, brand: 'voices' } },
        }),
      ).not.toBeNull();
    });

    it('who is skipped: wmt skips every suppression row; voices only bounced, complained and its own', async () => {
      await prisma.emailSuppression.createMany({
        data: [
          { email: `un${D}`, reason: 'unsubscribed' },
          { email: `bo${D}`, reason: 'bounced' },
          { email: `co${D}`, reason: 'complained' },
        ],
      });
      await prisma.emailBrandSuppression.create({
        data: { email: `vu${D}`, brand: 'voices', reason: 'unsubscribed' },
      });
      const all = ['un', 'bo', 'co', 'vu', 'ok'].map((e) => `${e}${D}`);
      const skipped = async (brand: 'wmt' | 'voices') => {
        const out: string[] = [];
        for (const e of all)
          if (await sending.isSuppressed(e, brand)) out.push(e.split('@')[0]);
        return out;
      };
      expect(await skipped('wmt')).toEqual(['un', 'bo', 'co']);
      expect(await skipped('voices')).toEqual(['bo', 'co', 'vu']);
    });
  });

  // ── sending, the Voices sender, and the pause ──────────────────────────────
  describe('sending and the pause on limits', () => {
    const okRelay = () =>
      jest
        .spyOn(relay, 'send')
        .mockImplementation(async (m) => ({ ok: true, id: `id-${m.to}` }));

    it('a voices campaign goes to the relay as app: voices; a wmt one does not', async () => {
      const spy = okRelay();
      const v = await campaign(['va'], 'voices');
      await sending.run(v);
      const w = await campaign(['wa'], 'wmt');
      await sending.run(w);
      const [vm, wm] = spy.mock.calls.map((c) => c[0]);
      expect(vm.app).toBe('voices');
      expect(vm.from).toContain('Voices');
      expect(vm.html).toContain('logo-wordmark-white.png');
      expect('app' in wm).toBe(false);
      expect(vm.headers['List-Unsubscribe']).toContain('.voices');
    });

    it('429: nobody is failed, the recipient goes back to queued, pausedUntil is the next 00:00 UTC', async () => {
      const c = await campaign(['p1', 'p2', 'p3']);
      let calls = 0;
      jest
        .spyOn(relay, 'send')
        .mockImplementation(async () =>
          ++calls === 1
            ? { ok: true, id: 'id-1' }
            : { ok: false, transient: false, error: 'cap', pause: 'daily_cap' },
        );
      await sending.run(c);
      const rows = await prisma.emailRecipient.findMany({
        where: { campaignId: c },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.filter((r) => r.status === 'sent')).toHaveLength(1);
      const waiting = rows.filter((r) => r.status === 'queued');
      expect(waiting).toHaveLength(2);
      expect(waiting.every((r) => r.claimedAt === null)).toBe(true);
      const row = await prisma.emailCampaign.findUniqueOrThrow({
        where: { id: c },
      });
      expect(row.status).toBe('sending');
      expect(row.failedCount).toBe(0);
      expect(row.pausedUntil?.toISOString()).toBe(
        nextUtcMidnight(new Date()).toISOString(),
      );
      expect(row.pauseReason).toBe(PAUSE_WORDS.daily_cap);
      const view = await svc.detail(c);
      expect(view.pausedUntil).not.toBeNull();
      expect(view.failedCount).toBe(0);
    });

    it('monthly quota: no time, a reason; boot does not restart it; only a resume does', async () => {
      const c = await campaign(['m1', 'm2']);
      jest.spyOn(relay, 'send').mockResolvedValue({
        ok: false,
        transient: false,
        error: 'q',
        pause: 'provider_monthly_quota',
      });
      await sending.run(c);
      let row = await prisma.emailCampaign.findUniqueOrThrow({
        where: { id: c },
      });
      expect(row.pausedUntil).toBeNull();
      expect(row.pauseReason).toBe(PAUSE_WORDS.provider_monthly_quota);
      const start = jest
        .spyOn(sending, 'startRun')
        .mockImplementation(() => undefined);
      await sending.onApplicationBootstrap();
      expect(start).not.toHaveBeenCalledWith(c);
      start.mockRestore();
      okRelay();
      const view = await svc.resume(c);
      expect(view.pauseReason).toBeNull();
      for (
        let i = 0;
        i < 100 &&
        (await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c } }))
          .status !== 'sent';
        i++
      )
        await new Promise((r) => setTimeout(r, 50));
      row = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c } });
      expect(row).toMatchObject({
        status: 'sent',
        sentCount: 2,
        failedCount: 0,
        pausedUntil: null,
        pauseReason: null,
      });
      await expect(svc.resume(c)).rejects.toBeInstanceOf(ConflictException);
    });

    it('a daily pause whose time has passed resumes at boot', async () => {
      const c = await campaign(['b1']);
      await prisma.emailCampaign.update({
        where: { id: c },
        data: {
          pausedUntil: new Date(Date.now() - 1000),
          pauseReason: PAUSE_WORDS.daily_cap,
        },
      });
      const start = jest
        .spyOn(sending, 'startRun')
        .mockImplementation(() => undefined);
      await sending.onApplicationBootstrap();
      expect(start).toHaveBeenCalledWith(c);
      expect(
        (await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c } }))
          .pauseReason,
      ).toBeNull();
      start.mockRestore();
      await prisma.emailCampaign.update({
        where: { id: c },
        data: { status: 'sent' },
      });
    });
  });

  // ── audiences ──────────────────────────────────────────────────────────────
  describe('accounts and Voices audiences', () => {
    const tmpl = () =>
      prisma.emailTemplate.create({
        data: {
          name: 'n',
          subject: 's',
          body: 'b',
          createdBy: 'em03-admin',
          brand: 'voices',
        },
      });
    const list = (rows: object[]) =>
      jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              data: rows,
              nextCursor: null,
              total: rows.length,
            }),
            { status: 200 },
          ),
      );

    it('voices unset: available false with the sentence, and the create is a 409', async () => {
      const count = await svc.memberCount('voices', 'voices');
      expect(count).toEqual({
        matching: 0,
        willSend: 0,
        unsubscribed: 0,
        available: false,
        reason: VOICES_NOT_LIVE,
      });
      const t = await tmpl();
      await expect(
        svc.createFromMembers('voices', t.id, undefined, ADMIN),
      ).rejects.toMatchObject({ status: 409, message: VOICES_NOT_LIVE });
    });

    it('voices set: counts and builds a voices campaign, skipping the Voices unsubscribed', async () => {
      process.env.VOICES_API_BASE_URL = 'https://voices.test/api/v1/';
      process.env.VOICES_INTERNAL_SERVICE_KEY = 'vk';
      const spy = list([
        { email: `a${D}`, firstName: 'Ada' },
        { email: `b${D}`, firstName: null },
        { email: `a${D}`, firstName: 'Ada' },
        { email: 'nope', firstName: null },
      ]);
      await prisma.emailBrandSuppression.create({
        data: { email: `b${D}`, brand: 'voices', reason: 'unsubscribed' },
      });
      expect(await svc.memberCount('voices', 'voices')).toEqual({
        matching: 2,
        willSend: 1,
        unsubscribed: 1,
        available: true,
      });
      const url = (spy.mock.calls[0][0] as URL).toString();
      expect(url).toContain(
        'https://voices.test/api/v1/internal/mail/audience',
      );
      expect((spy.mock.calls[0][1] as RequestInit).headers).toEqual({
        'X-Service-Key': 'vk',
      });
      const t = await tmpl();
      const c = await svc.createFromMembers('voices', t.id, undefined, ADMIN);
      expect(c).toMatchObject({
        brand: 'voices',
        audienceKind: 'voices',
        audienceNote: 'Voices members',
        skippedCount: 1,
        duplicateCount: 1,
        invalidCount: 1,
      });
    });

    it('accounts: only WMT accounts (a Hub profile), not deleted, not suspended; a 404 says it is not there yet', async () => {
      const ids = [
        'em03-ok',
        'em03-noprofile',
        'em03-deleted',
        'em03-cancelled',
        'em03-sus',
      ];
      await prisma.userProfile.createMany({
        data: ['em03-ok', 'em03-deleted', 'em03-cancelled', 'em03-sus'].map(
          (wawuUserId) => ({ wawuUserId, accountType: 'user' as never }),
        ),
      });
      await prisma.accountDeletion.createMany({
        data: [
          {
            wawuUserId: 'em03-deleted',
            status: 'scheduled',
            purgeAfter: new Date(Date.now() + 86_400_000),
          },
          {
            wawuUserId: 'em03-cancelled',
            status: 'cancelled',
            purgeAfter: new Date(Date.now() + 86_400_000),
          },
        ],
      });
      await prisma.userSuspension.create({
        data: {
          wawuUserId: 'em03-sus',
          reason: 'spam',
          suspendedByAdminId: 'a',
          suspendedByAdminEmail: 'a@b.co',
          suspendedByAdminRole: 'superadmin',
        },
      });
      list(ids.map((id) => ({ id, email: `${id}${D}`, firstName: 'A' })));
      try {
        const spy = jest.mocked(global.fetch);
        expect(await svc.memberCount('accounts', 'wmt')).toEqual({
          matching: 2,
          willSend: 2,
          unsubscribed: 0,
          available: true,
        });
        const call = spy.mock.calls[0];
        expect((call[0] as URL).toString()).toContain(
          'http://relay.invalid/internal/mail/audience',
        );
        expect((call[1] as RequestInit).headers).toEqual({
          'X-Service-Key': 'k',
        });
        // ok + cancelled-deletion stay; no profile, deleted and suspended are out
        const t = await prisma.emailTemplate.create({
          data: { name: 'n', subject: 's', body: 'b', createdBy: 'em03-admin' },
        });
        const c = await svc.createFromMembers(
          'accounts',
          t.id,
          undefined,
          ADMIN,
        );
        const rows = await prisma.emailRecipient.findMany({
          where: { campaignId: c.id },
        });
        expect(rows.map((r) => r.email).sort()).toEqual([
          `em03-cancelled${D}`,
          `em03-ok${D}`,
        ]);
      } finally {
        await prisma.accountDeletion.deleteMany({
          where: { wawuUserId: { startsWith: 'em03-' } },
        });
        await prisma.userProfile.deleteMany({
          where: { wawuUserId: { startsWith: 'em03-' } },
        });
      }
      jest.restoreAllMocks();
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 404 }));
      expect(await svc.memberCount('accounts', 'wmt')).toMatchObject({
        available: false,
      });
    });
  });

  // ── fix round 2 ────────────────────────────────────────────────────────────
  describe('fix round 2', () => {
    it('a resume that arrives while the paused run is still unwinding still ends with every queued person sent once', async () => {
      const c = await campaign(Array.from({ length: 12 }, (_, i) => `rr${i}`));
      const sentTo: string[] = [];
      let calls = 0;
      let resumed: Promise<unknown> | null = null;
      jest.spyOn(relay, 'send').mockImplementation(async (m) => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            transient: false,
            error: 'cap',
            pause: 'daily_cap',
          };
        }
        // The other in-flight workers are slow, so the old run is still unwinding
        // when the resume arrives.
        await new Promise((r) => setTimeout(r, 150));
        if (calls <= 4 && !resumed) {
          const waitPause = async () => {
            for (let i = 0; i < 100; i++) {
              const row = await prisma.emailCampaign.findUniqueOrThrow({
                where: { id: c },
              });
              if (row.pauseReason) break;
              await new Promise((r) => setTimeout(r, 10));
            }
            return svc.resume(c);
          };
          resumed = waitPause();
        }
        sentTo.push(m.to);
        return { ok: true, id: `id-${m.to}` };
      });
      sending.startRun(c);
      for (let i = 0; i < 300; i++) {
        const row = await prisma.emailCampaign.findUniqueOrThrow({
          where: { id: c },
        });
        if (row.status === 'sent') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await (resumed as Promise<unknown> | null);
      const row = await prisma.emailCampaign.findUniqueOrThrow({
        where: { id: c },
      });
      expect(row).toMatchObject({
        status: 'sent',
        failedCount: 0,
        pauseReason: null,
        pausedUntil: null,
      });
      const rows = await prisma.emailRecipient.findMany({
        where: { campaignId: c },
      });
      expect(rows.filter((r) => r.status === 'sent')).toHaveLength(12);
      expect(new Set(sentTo).size).toBe(sentTo.length);
      expect(sentTo).toHaveLength(12);
    });

    it('a repeated cursor stops the walk at once and no campaign is made', async () => {
      process.env.VOICES_API_BASE_URL = 'https://voices.test/api/v1';
      process.env.VOICES_INTERNAL_SERVICE_KEY = 'vk';
      const spy = jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ email: `loop${D}`, firstName: null }],
              nextCursor: 'same',
              total: 5,
            }),
            { status: 200 },
          ),
      );
      const t = await prisma.emailTemplate.create({
        data: {
          name: 'n',
          subject: 's',
          body: 'b',
          createdBy: 'em03-admin',
          brand: 'voices',
        },
      });
      const before = await prisma.emailCampaign.count({
        where: { createdBy: 'em03-admin' },
      });
      await expect(
        svc.createFromMembers('voices', t.id, undefined, ADMIN),
      ).rejects.toMatchObject({ status: 409 });
      expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
      expect(
        await prisma.emailCampaign.count({
          where: { createdBy: 'em03-admin' },
        }),
      ).toBe(before);
      delete process.env.VOICES_API_BASE_URL;
      delete process.env.VOICES_INTERNAL_SERVICE_KEY;
    });

    it('the count uses the brand it is asked for; templates with no brand are wmt only', async () => {
      await prisma.emailSuppression.create({
        data: { email: `ub${D}`, reason: 'unsubscribed' },
      });
      await prisma.waitlistRegistration.deleteMany({
        where: { email: `ub${D}` },
      });
      const reg = await prisma.waitlistRegistration
        .create({ data: { email: `ub${D}`, fullName: 'U B' } as never })
        .catch(() => null);
      if (reg) {
        expect(
          (await svc.registrantCount('all', undefined, 'wmt')).unsubscribed,
        ).toBeGreaterThanOrEqual(1);
        const v = await svc.registrantCount('all', undefined, 'voices');
        const w = await svc.registrantCount('all', undefined, 'wmt');
        expect(v.unsubscribed).toBeLessThan(w.unsubscribed);
        await prisma.waitlistRegistration.deleteMany({
          where: { email: `ub${D}` },
        });
      }
      const vt = await prisma.emailTemplate.create({
        data: {
          name: 'v',
          subject: 's',
          body: 'b',
          createdBy: 'em03-admin',
          brand: 'voices',
        },
      });
      const nt = await prisma.emailTemplate.create({
        data: { name: 'n', subject: 's', body: 'b', createdBy: 'em03-admin' },
      });
      const none = (await svc.listTemplates()).map((x) => x.id);
      expect(none).toContain(nt.id);
      expect(none).not.toContain(vt.id);
    });
  });

  // ── a request without the new fields behaves as before ─────────────────────
  describe('old requests', () => {
    it('a template with no brand or button reads wmt with null button and builds a wmt campaign', async () => {
      const t = await svc.createTemplate(
        { name: 'n', subject: 's', body: 'b' },
        ADMIN,
      );
      expect(t).toMatchObject({
        brand: 'wmt',
        buttonText: null,
        buttonUrl: null,
      });
      const before = await svc.updateTemplate(t.id, {
        name: 'n2',
        subject: 's',
        body: 'b',
      });
      expect(before).toMatchObject({ brand: 'wmt', version: 2 });
      expect((await svc.listTemplates('wmt')).some((x) => x.id === t.id)).toBe(
        true,
      );
      expect(
        (await svc.listTemplates('voices')).some((x) => x.id === t.id),
      ).toBe(false);
      const p = svc.preview({ subject: 's', body: 'b' });
      expect(p).toMatchObject({
        brand: 'wmt',
        buttonText: null,
        buttonUrl: null,
      });
      await expect(
        svc.createTemplate(
          { name: 'n', subject: 's', body: 'b', buttonText: 'Go' },
          ADMIN,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('a template saves, keeps and clears its button; a campaign copies brand and button', async () => {
      const t = await svc.createTemplate(
        {
          name: 'n',
          subject: 's',
          body: 'b',
          brand: 'voices',
          buttonText: 'Go',
          buttonUrl: 'https://usevoices.com/x',
        } as never,
        ADMIN,
      );
      const kept = await svc.updateTemplate(t.id, {
        name: 'n',
        subject: 's',
        body: 'b2',
      });
      expect(kept).toMatchObject({ brand: 'voices', buttonText: 'Go' });
      await expect(
        svc.updateTemplate(t.id, {
          name: 'n',
          subject: 's',
          body: 'b',
          buttonText: null,
        }),
      ).rejects.toMatchObject({ status: 400 });
      const cleared = await svc.updateTemplate(t.id, {
        name: 'n',
        subject: 's',
        body: 'b',
        buttonText: null,
        buttonUrl: null,
      });
      expect(cleared).toMatchObject({
        buttonText: null,
        buttonUrl: null,
        brand: 'voices',
      });
    });
  });
});
