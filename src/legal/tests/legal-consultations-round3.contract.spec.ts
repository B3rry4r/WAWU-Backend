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
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import {
  adminFixtures,
  adminJwtSecrets,
  bearer,
  deleteAdminFixtures,
  loginAllAdmins,
  seedAdminFixtures,
  type AdminTokens,
} from '../../common/tests/admin-session.helper';
import { LegalModule } from '../legal.module';
import { LegalIntakeModule } from '../../legal-intake/legal-intake.module';
import { LegalAssistantAllowance } from '../../legal-intake/assistant/legal-assistant-allowance';
import { StorageService } from '../../storage/storage.service';

/**
 * LEGAL-03, fix round 3 (second verifier D2 to D5, lead ruling U2): a delivered
 * file is stored as its object key and signed fresh for its owner on every
 * read, file names are plain names, the app's booking needs a zone, the
 * service price floor and the unpriced-call guard are pinned, and the delivery
 * notification does not name the matter.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const ADMINS = adminFixtures('1e110005', 'legal-consult-r3');
const SECRETS = adminJwtSecrets('legal-consult-r3');

async function isMockUp(): Promise<boolean> {
  try {
    return (await fetch(`${MOCK_WAWU_ID_URL}/health`)).ok;
  } catch {
    return false;
  }
}

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const subOf = (token: string): string =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).sub;

describe('LEGAL-03 fix round 3 (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let allowance: LegalAssistantAllowance;
  let mock: ChildProcess | undefined;
  let tokens: AdminTokens;
  let userToken: string;
  let otherToken: string;
  let userId: string;
  let otherId: string;
  const envSnapshot: Record<string, string | undefined> = {};
  let optionRows: Awaited<
    ReturnType<PrismaService['legalConsultationOption']['findMany']>
  >;
  let createdIds: string[] = [];
  const signed: { key: string; ttl: number }[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = SECRETS.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = SECRETS.refresh;
    if (!(await isMockUp())) {
      mock = spawn('node', ['mock-wawu-id/server.js'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        detached: true,
      });
      mock.unref();
      for (let i = 0; i < 60 && !(await isMockUp()); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    userToken = await loginAs('user@test.wawu.dev');
    otherToken = await loginAs('creator-basic@test.wawu.dev');
    userId = subOf(userToken);
    otherId = subOf(otherToken);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        LegalModule,
        LegalIntakeModule,
      ],
    })
      // No bucket here: the fake signs a link that names the key, the
      // lifetime and a counter, as the real helper does for a key.
      .overrideProvider(StorageService)
      .useValue({
        signedReadUrl: (key: string, ttl = 900): Promise<string> => {
          signed.push({ key, ttl });
          if (key.startsWith('http')) return Promise.resolve(key);
          return Promise.resolve(
            `https://bucket.test/${key}?X-Amz-Expires=${ttl}&n=${signed.length}`,
          );
        },
      })
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
    await app.init();
    prisma = moduleRef.get(PrismaService);
    allowance = moduleRef.get(LegalAssistantAllowance);
    optionRows = await prisma.legalConsultationOption.findMany();
    await seedAdminFixtures(prisma, ADMINS);
    tokens = await loginAllAdmins(app, ADMINS);
  }, 40_000);

  afterEach(async () => {
    if (createdIds.length) {
      await prisma.legalDeliverable.deleteMany({
        where: { legalRequestId: { in: createdIds } },
      });
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: { in: createdIds } },
      });
      await prisma.adminOpsAudit.deleteMany({
        where: { resourceId: { in: createdIds } },
      });
      await prisma.legalRequest.deleteMany({
        where: { id: { in: createdIds } },
      });
      createdIds = [];
    }
    await prisma.notification.deleteMany({
      where: { userWawuId: { in: [userId, otherId] }, kind: 'legal_delivered' },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.legalConsultationOption.deleteMany({});
      for (const r of optionRows) {
        await prisma.legalConsultationOption.create({ data: r });
      }
      await prisma.adminOpsAudit.deleteMany({
        where: {
          resource: 'legal_price',
          actedByAdminId: { in: ADMINS.map((a) => a.id) },
        },
      });
      await deleteAdminFixtures(prisma, ADMINS);
    }
    if (app) await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function paidWork(wawuUserId = userId) {
    const row = await prisma.legalRequest.create({
      data: {
        wawuUserId,
        serviceCode: 'contract-review',
        serviceName: 'Contract review',
        category: 'Contracts',
        path: 'consultation',
        status: 'in_progress',
        servicePaidAt: new Date(),
      },
    });
    createdIds.push(row.id);
    return row;
  }

  const deliver = (id: string, body: unknown) =>
    http()
      .post(`/api/hub/legal/ops/requests/${id}/deliverables`)
      .set(bearer(tokens.support))
      .send(body as object);

  const KEY = 'legal/document/abc/11111111-2222-3333-4444-555555555555.pdf';
  const SEVEN_DAY_LINK = `https://bucket.test/${KEY}?X-Amz-Expires=604800&X-Amz-Signature=old`;

  /* ================================================================ */
  describe('D2: a delivered file is stored as its key and signed fresh on every read', () => {
    it('stores the key, not the link ops posted, and the audit row holds the key', async () => {
      const work = await paidWork();
      await deliver(work.id, {
        files: [{ fileName: 'a.pdf', url: SEVEN_DAY_LINK }],
      }).expect(200);
      const row = await prisma.legalDeliverable.findFirstOrThrow({
        where: { legalRequestId: work.id },
      });
      expect(row.url).toBe(KEY);
      const audit = await prisma.adminOpsAudit.findFirstOrThrow({
        where: { resourceId: work.id, action: 'legal_delivered' },
      });
      expect(JSON.stringify(audit.detail)).not.toContain('X-Amz');
    });

    it('signs a new 15 minute link on every list, after the ownership check', async () => {
      const work = await paidWork();
      await deliver(work.id, {
        files: [{ fileName: 'a.pdf', url: SEVEN_DAY_LINK }],
      }).expect(200);
      signed.length = 0;
      const one = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      const two = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      const a = one.body.data.items[0].url as string;
      const b = two.body.data.items[0].url as string;
      expect(a).toContain(KEY);
      expect(a).toContain('X-Amz-Expires=900');
      expect(a).not.toContain('X-Amz-Signature=old');
      expect(b).not.toBe(a);
      expect(signed).toEqual([
        { key: KEY, ttl: 900 },
        { key: KEY, ttl: 900 },
      ]);
    });

    it('signs nothing for a stranger, who is told 404', async () => {
      const work = await paidWork();
      await deliver(work.id, {
        files: [{ fileName: 'a.pdf', url: SEVEN_DAY_LINK }],
      }).expect(200);
      signed.length = 0;
      await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(otherToken))
        .expect(404);
      expect(signed).toHaveLength(0);
    });

    it('derives the key once, on read, from a row that holds only the old link', async () => {
      const work = await paidWork();
      await prisma.legalDeliverable.create({
        data: {
          legalRequestId: work.id,
          wawuUserId: userId,
          fileName: 'old.pdf',
          url: SEVEN_DAY_LINK,
        },
      });
      signed.length = 0;
      const res = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      expect(signed).toEqual([{ key: KEY, ttl: 900 }]);
      expect(res.body.data.items[0].url).toContain('X-Amz-Expires=900');
      expect(res.body.data.items[0].url).not.toContain('Signature=old');
    });

    it('does not post a file twice when it comes again as a new link for the same key', async () => {
      const work = await paidWork();
      await deliver(work.id, {
        files: [{ fileName: 'a.pdf', url: SEVEN_DAY_LINK }],
      }).expect(200);
      const again = await deliver(work.id, {
        files: [
          {
            fileName: 'a.pdf',
            url: `https://bucket.test/${KEY}?X-Amz-Expires=604800&X-Amz-Signature=new`,
          },
        ],
      }).expect(200);
      expect(again.body.data.items).toHaveLength(1);
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(1);
    });
  });

  /* ================================================================ */
  describe('D3: a file name is a plain name', () => {
    it.each([
      ['a slash', 'a/b.pdf'],
      ['a path up', '../../etc/passwd'],
      ['a backslash', 'a\\b.pdf'],
      ['a drive path', 'C:\\Windows\\x.exe'],
      ['a single dot', '.'],
      ['two dots', '..'],
      ['a right-to-left override', 'invoice\u202egnp.exe'],
      ['a left-to-right embedding', 'a\u202ab.pdf'],
      ['an isolate', 'a\u2066b.pdf'],
      ['a pop isolate', 'a\u2069b.pdf'],
      ['a line separator', 'a\u2028b.pdf'],
      ['a paragraph separator', 'a\u2029b.pdf'],
      ['a next line', 'a\u0085b.pdf'],
      ['a BOM at the start', '\ufeffa.pdf'],
      ['a BOM at the end', 'a.pdf\ufeff'],
      ['a BOM inside', 'a\ufeff.pdf'],
      ['a line separator at the end', 'a.pdf\u2028'],
      ['only zero-width spaces', '\u200b\u200b'],
      ['only a zero-width joiner', '\u200d'],
      ['only a word joiner', '\u2060\u2060'],
    ])(
      'refuses %s, naming fileName, and posts nothing',
      async (_l, fileName) => {
        const work = await paidWork();
        const res = await deliver(work.id, {
          files: [{ fileName, url: 'https://x.example/a.pdf' }],
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain('fileName');
        expect(
          await prisma.legalDeliverable.count({
            where: { legalRequestId: work.id },
          }),
        ).toBe(0);
      },
    );

    it.each([
      ['html', '<img src=x onerror=alert(1)>.pdf'],
      ['dots inside', 'v1.2.final.pdf'],
      ['a name that starts with a dot', '.hidden'],
      ['non-Latin text', 'Contrat \u00e9tabli.pdf'],
    ])('still allows %s', async (_l, fileName) => {
      const work = await paidWork();
      await deliver(work.id, {
        files: [{ fileName, url: 'https://x.example/a.pdf' }],
      }).expect(200);
    });
  });

  /* ================================================================ */
  describe('D4: the app booking needs a zone', () => {
    it.each([
      ['no zone', '2099-10-09T09:00:00'],
      ['no zone, minutes only', '2099-10-09T09:00'],
      ['no zone, with fraction', '2099-10-09T09:00:00.000'],
    ])(
      'refuses a time with %s, naming scheduledFor',
      async (_l, scheduledFor) => {
        const res = await http()
          .post(
            `/api/hub/legal/requests/${(await consultRequest()).id}/booking`,
          )
          .set(as(userToken))
          .send({ medium: 'zoom', scheduledFor })
          .expect(400);
        expect(JSON.stringify(res.body)).toContain('scheduledFor');
        expect(JSON.stringify(res.body)).toContain('Z or a +hh:mm offset');
      },
    );

    it('still takes the time the calendar gave, which ends in Z', async () => {
      await http()
        .put('/api/hub/legal/ops/prices/consultations/zoom')
        .set(bearer(tokens.finance))
        .send({ priceKobo: 1_500_000, minutes: 60 })
        .expect(200);
      const cal = await http()
        .get('/api/hub/legal/consultation/slots')
        .query({ medium: 'zoom' })
        .set(as(userToken))
        .expect(200);
      const startsAt = cal.body.data.days.at(-1).slots[0].startsAt as string;
      expect(startsAt.endsWith('Z')).toBe(true);
      await http()
        .post(`/api/hub/legal/requests/${(await consultRequest()).id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: startsAt })
        .expect(200);
    });
  });

  async function consultRequest() {
    const res = await http()
      .post('/api/hub/legal/requests')
      .set(as(userToken))
      .send({ serviceCode: 'contract-drafting' })
      .expect(201);
    createdIds.push(res.body.data.id);
    return res.body.data as { id: string };
  }

  /* ================================================================ */
  describe('D5: the service price floor and the unpriced call', () => {
    it.each([
      ['fifty kobo', 50],
      ['ninety-nine kobo', 99],
      ['zero', 0],
      ['minus one naira', -100],
      ['minus one million naira', -100_000_000],
    ])(
      'refuses a service price of %s and writes nothing',
      async (_l, priceKobo) => {
        const before = await prisma.legalServicePrice.findMany();
        await http()
          .put('/api/hub/legal/ops/prices/services/cac-registration')
          .set(bearer(tokens.finance))
          .send({ priceKobo })
          .expect(400);
        expect(await prisma.legalServicePrice.findMany()).toEqual(before);
      },
    );

    it('takes one naira, the floor', async () => {
      await http()
        .put('/api/hub/legal/ops/prices/services/cac-registration')
        .set(bearer(tokens.finance))
        .send({ priceKobo: 100 })
        .expect(200);
      await http()
        .put('/api/hub/legal/ops/prices/services/cac-registration')
        .set(bearer(tokens.finance))
        .send({ priceKobo: null })
        .expect(200);
    });

    const MEDIA = ['zoom', 'phone'] as const;
    it.each(MEDIA)(
      'does not offer or book a %s call that has a length and no price',
      async (medium) => {
        await prisma.legalConsultationOption.upsert({
          where: { medium },
          update: { enabled: true, priceKobo: null, minutes: 60 },
          create: { medium, enabled: true, priceKobo: null, minutes: 60 },
        });
        const opts = await http()
          .get('/api/hub/legal/consultation/options')
          .set(as(userToken))
          .expect(200);
        expect(JSON.stringify(opts.body.data).includes(`"${medium}"`)).toBe(
          false,
        );
        await http()
          .get('/api/hub/legal/consultation/slots')
          .query({ medium })
          .set(as(userToken))
          .expect(400);
        const req = await consultRequest();
        const day = new Date(Date.now() + 3 * 86_400_000);
        day.setUTCHours(9, 0, 0, 0);
        await http()
          .post(`/api/hub/legal/requests/${req.id}/booking`)
          .set(as(userToken))
          .send({ medium, scheduledFor: day.toISOString() })
          .expect(400);
        expect(
          (
            await prisma.legalRequest.findUniqueOrThrow({
              where: { id: req.id },
            })
          ).scheduledFor,
        ).toBeNull();
      },
    );

    it('does not offer a call that has a price and no length either', async () => {
      await prisma.legalConsultationOption.update({
        where: { medium: 'zoom' },
        data: { enabled: true, priceKobo: 1_500_000, minutes: null },
      });
      await http()
        .get('/api/hub/legal/consultation/slots')
        .query({ medium: 'zoom' })
        .set(as(userToken))
        .expect(400);
    });
  });

  /* ================================================================ */
  describe('U2: the delivery notification does not name the matter', () => {
    it.each([
      [1, 'Your consultant has sent you a document. It is in your legal chat.'],
      [
        2,
        'Your consultant has sent you 2 documents. They are in your legal chat.',
      ],
    ])('reads right for %s file(s)', async (n, text) => {
      const work = await paidWork();
      const files = Array.from({ length: n }, (_, i) => ({
        fileName: `f${i}.pdf`,
        url: `https://x.example/f${i}.pdf`,
      }));
      await deliver(work.id, { files }).expect(200);
      const note = await prisma.notification.findFirstOrThrow({
        where: { userWawuId: userId, kind: 'legal_delivered' },
      });
      expect(note.body).toBe(text);
      expect(note.body).not.toContain('Contract review');
      expect(note.body).not.toContain('—');
    });
  });
});
