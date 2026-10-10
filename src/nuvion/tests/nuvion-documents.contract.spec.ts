import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  ConsoleLogger,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  DocumentsNuvion,
  type HeldEntity,
  ulid,
} from '../../../test/nuvion/documents-standin';
import { envelope, NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { WawuIdDouble } from '../../../test/nuvion/wawu-id-double';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NO_WALLET_MESSAGE } from '../../money/gate/wallet-gate';
import { MoneyModule } from '../../money/money.module';
import { WalletOpeningService } from '../../money/opening/wallet-opening.service';
import type { WalletView } from '../../money/money-view.type';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { NuvionDocumentsArea } from '../areas/documents';
import { NuvionDocumentsHandler } from '../handlers/documents.handler';
import { NuvionOpeningHandler } from '../handlers/opening.handler';
import { DocumentsFlow } from '../documents/documents-flow';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import { DocumentUploadSlots } from '../documents/documents-slots';
import { NuvionDocumentsModule } from '../documents/documents.module';
import { IdentityHasher } from '../../money/identity/identity-config';
import type {
  IdentityDocumentsView,
  IdentityLivenessView,
} from '../documents/documents-view.type';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * NUV-03: the ID document, the proof of address and the hosted selfie, then
 * the one submission for Nuvion's review, over HTTP, against a real
 * database, real RS256 tokens (the WAWU ID stand-in's JWKS), and the real
 * Nuvion client and adapter talking over a socket to a stateful stand-in
 * (test/nuvion/documents-standin.ts, on NUV-01's) built from the docs' own
 * examples: `POST /documents`, `POST /onboarding-submissions`, `GET
 * /entities/{id}` with its documents, and, from Nuvion's dashboard code,
 * the hosted selfie. Nothing leaves this machine (the outbound guard), and
 * every log line written during the file is captured: the last tests prove
 * no document content reached a log, an answer or a column.
 *
 * Every Nuvion timeout is 1.5 s; a "late" answer comes 2 s after the
 * request: Nuvion made the thing and the client never heard.
 */

jest.setTimeout(90_000);

const TIMEOUT_MS = 1_500;
const RESEND_SAFETY_MS = 2_000; // the client's own setting; documents wait only the call and its margin
const RESEND_AFTER_MS = TIMEOUT_MS + 15_000;
const MB = 1024 * 1024;

const ENV: Record<string, string | undefined> = {
  WALLET_PROVIDER: 'nuvion',
  NUVION_BASE_URL: 'https://api.nuvion.dev',
  NUVION_API_KEY: 'nv_test_sk_NUV03documentsKEY0000000000',
  NUVION_WEBHOOK_SECRET: 'whsec_nuv03_documents_0123456789',
  NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
  IDENTITY_HASH_KEY: 'nuv03-test-documents-hash-key-0123456789abcdef',
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: '',
};

// ---------------------------------------------------------------------------
// Every channel a log line can leave by, captured for the whole file.
// ---------------------------------------------------------------------------
const captured: string[] = [];
const restores: Array<() => void> = [];
function capture(target: object, method: string): void {
  const t = target as Record<string, (...a: unknown[]) => unknown>;
  const original = t[method];
  t[method] = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })))
        .join(' '),
    );
    return true;
  };
  restores.push(() => {
    t[method] = original;
  });
}
const answered: string[] = [];

function digits(n: number): string {
  let out = String(randomInt(1, 10));
  while (out.length < n) out += String(randomInt(0, 10));
  return out;
}

// ---------------------------------------------------------------------------
// Files. Only the framing matters to WAWU (Nuvion judges the content); each
// carries a unique plain-text marker so a scan can find any copy of it.
// ---------------------------------------------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const markers: string[] = [];
function marker(): string {
  const m = `NUV03DOC${randomUUID().replace(/-/g, '')}`;
  markers.push(m);
  return m;
}
function png(size = 400): Buffer {
  return Buffer.concat([
    PNG_SIG,
    Buffer.from(marker()),
    Buffer.alloc(Math.max(0, size - 40), 7),
  ]);
}
function jpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(marker()),
    Buffer.alloc(300, 9),
    Buffer.from([0xff, 0xd9]),
  ]);
}
function pdf(): Buffer {
  return Buffer.from(
    `%PDF-1.4\n% ${marker()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`,
  );
}

type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: { code: string; message: string; retryAfterSeconds?: number };
};
type Person = { id: string; auth: string; held: HeldEntity };

describe('NUV-03: documents, proof of address and the hosted selfie on Nuvion', () => {
  const logger = new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });
  const standin = new NuvionStandin();
  const nuvion = new DocumentsNuvion(standin);
  const wawuId = new WawuIdDouble();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let provider: NuvionWalletProvider;
  let handler: NuvionDocumentsHandler;
  let openingHandler: NuvionOpeningHandler;
  let slots: DocumentUploadSlots;
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const tmpBefore = readdirSync(tmpdir()).sort();

  const http = () => request(app.getHttpServer());
  const body = <T>(res: Response): Envelope<T> => {
    answered.push(res.text);
    return res.body as Envelope<T>;
  };

  function mintToken(sub: string): string {
    const privateKey = readFileSync(
      join(__dirname, '../../../mock-wawu-id/private.pem'),
      'utf8',
    );
    return jwt.sign(
      {
        sub,
        email: `nuv03-${sub}@example.com`,
        phone: `+23480${digits(8)}`,
        firstName: 'Ada',
        lastName: 'Documents',
        country: 'Nigeria',
        verificationTier: 'basic',
        trustScore: 0,
        status: 'active',
      },
      privateKey,
      { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
    );
  }

  /** A person whose opening is where NUV-02 leaves it: the entity made, documents needed. */
  async function opened(
    over: {
      status?: string;
      held?: Partial<HeldEntity>;
      decidedAt?: Date | null;
      correctedAt?: Date | null;
      documentStatus?: string | null;
      addressProofStatus?: string | null;
      noPerson?: boolean;
    } = {},
  ): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    const held = nuvion.addEntity({
      status: over.status ?? 'incomplete',
      ...over.held,
    });
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: id,
        entityId: held.id,
        personId: over.noPerson ? null : held.personId,
        status: over.status ?? 'incomplete',
        decidedAt: over.decidedAt ?? null,
        correctedAt: over.correctedAt ?? null,
        documentStatus: over.documentStatus ?? 'pending',
        addressProofStatus: over.addressProofStatus ?? 'pending',
      },
    });
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: id,
        state: 'review',
        bvnHash: `nuv03-bvn-${id}`,
        bvnVerifiedAt: new Date(),
        phone: `+23480${digits(8)}`,
        provider: 'nuvion',
      },
    });
    return { id, auth: `Bearer ${mintToken(id)}`, held };
  }

  /** A person with no opening started at all. */
  function stranger(): Person {
    const id = randomUUID();
    users.push(id);
    return {
      id,
      auth: `Bearer ${mintToken(id)}`,
      held: {} as unknown as HeldEntity,
    };
  }

  const send = (
    who: Person,
    kind: string | null,
    front: Buffer | null,
    back?: Buffer | null,
    extra: Record<string, string> = {},
  ) => {
    let r = http()
      .post('/api/hub/money/identity/documents')
      .set('Authorization', who.auth);
    if (kind !== null) r = r.field('kind', kind);
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    if (front) {
      r = r.attach('file', front, {
        filename: 'scan.bin',
        contentType: 'application/octet-stream',
      });
    }
    if (back) {
      r = r.attach('file_back', back, {
        filename: 'back.bin',
        contentType: 'application/octet-stream',
      });
    }
    return r;
  };
  const view = async (who: Person): Promise<IdentityDocumentsView> =>
    body<IdentityDocumentsView>(
      await http()
        .get('/api/hub/money/identity/documents')
        .set('Authorization', who.auth)
        .expect(200),
    ).data!;
  const liveness = async (who: Person): Promise<IdentityLivenessView> =>
    body<IdentityLivenessView>(
      await http()
        .get('/api/hub/money/identity/liveness')
        .set('Authorization', who.auth)
        .expect(200),
    ).data!;
  const startLiveness = (who: Person, payload: Record<string, unknown> = {}) =>
    http()
      .post('/api/hub/money/identity/liveness')
      .set('Authorization', who.auth)
      .send(payload);
  const wallet = async (who: Person) =>
    body<WalletView>(
      await http()
        .get('/api/hub/money/wallet')
        .set('Authorization', who.auth)
        .expect(200),
    ).data!;
  const entityRow = (who: Person) =>
    prisma.nuvionEntity.findUniqueOrThrow({ where: { wawuUserId: who.id } });
  const docRow = (who: Person, kind: string) =>
    prisma.nuvionDocument.findUnique({
      where: { wawuUserId_kind: { wawuUserId: who.id, kind } },
    });
  const onboarding = (who: Person) =>
    prisma.nuvionOnboarding.findUnique({ where: { wawuUserId: who.id } });
  const openingRow = (who: Person) =>
    prisma.fintavaWalletOpening.findUniqueOrThrow({
      where: { wawuUserId: who.id },
    });
  const sent = (method: string, path: string | RegExp) =>
    standin.seen.filter(
      (s) =>
        s.method === method &&
        (typeof path === 'string' ? s.path === path : path.test(s.path)),
    );
  const uploads = () => sent('POST', '/documents');
  const submissions = () => sent('POST', '/onboarding-submissions');
  const sessionStarts = () => sent('POST', '/kyc/liveness/sessions');
  const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
  const age = (who: Person, kind: string, msAgo: number) =>
    prisma.nuvionDocument.update({
      where: { wawuUserId_kind: { wawuUserId: who.id, kind } },
      data: { attemptStartedAt: new Date(Date.now() - msAgo) },
    });
  const ageSubmission = (who: Person, msAgo: number) =>
    prisma.nuvionOnboarding.update({
      where: { wawuUserId: who.id },
      data: { submitRequestedAt: new Date(Date.now() - msAgo) },
    });
  /** The opening was sent `ms` ago: the documents and the submission are that old. */
  const makeOld = async (who: Person, ms: number) => {
    const at = new Date(Date.now() - ms);
    await prisma.nuvionOnboarding.updateMany({
      where: { wawuUserId: who.id },
      data: { submittedAt: at, submitRequestedAt: at },
    });
    await prisma.nuvionDocument.updateMany({
      where: { wawuUserId: who.id },
      data: { uploadedAt: at, attemptStartedAt: at },
    });
  };
  const settings = () =>
    provider.client.settings as {
      hostedLiveness?: boolean;
      livenessRedirectOrigins?: readonly string[];
    };
  const forgetRefusal = () => {
    (
      provider.documents as unknown as { livenessRefusedAt: number | null }
    ).livenessRefusedAt = null;
  };
  /** The entity's `entities.updated` delivery, as the dispatcher hands it to the handler. */
  const delivery = (e: HeldEntity) => ({
    id: randomUUID(),
    eventId: ulid('01EVT'),
    event: 'entities.updated',
    resourceId: e.id,
    entityId: null,
    data: { id: e.id, type: 'individual', status: e.status },
    receivedAt: new Date(),
    attempts: 1,
  });

  beforeAll(async () => {
    capture(process.stdout, 'write');
    capture(process.stderr, 'write');
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
      capture(console, m);
    guard = guardOutbound();
    await standin.start();
    await wawuId.start();
    ENV.WAWU_ID_JWKS_URL = wawuId.jwksUrl;
    ENV.WAWU_ID_BASE_URL = wawuId.baseUrl;
    for (const [k, v] of Object.entries(ENV)) {
      previous[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    provider = new NuvionWalletProvider(
      new NuvionClient(
        standin.settings({
          readTimeoutMs: TIMEOUT_MS,
          moneyTimeoutMs: TIMEOUT_MS,
          checkTimeoutMs: TIMEOUT_MS,
          resendSafetyMs: RESEND_SAFETY_MS,
          hostedLiveness: false,
          livenessRedirectOrigins: [],
        }),
        ENV.NUVION_API_KEY!,
      ),
    );
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        NuvionWebhookModule,
        // Mounted by MoneyModule once SHARED-CHANGES NUV-03 #1 is applied.
        NuvionDocumentsModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(provider)
      .setLogger(logger)
      .compile();
    app = moduleRef.createNestApplication({ logger });
    app.useLogger(logger);
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    handler = moduleRef.get(NuvionDocumentsHandler);
    openingHandler = moduleRef.get(NuvionOpeningHandler);
    slots = moduleRef.get(DocumentUploadSlots);
  });

  beforeEach(() => {
    standin.reset();
    nuvion.reset();
    nuvion.install();
    settings().hostedLiveness = false;
    settings().livenessRedirectOrigins = [];
    forgetRefusal();
    slots.max = 4;
    slots.waitMs = 5_000;
  });

  afterAll(async () => {
    if (prisma) {
      const where = { wawuUserId: { in: users } };
      await prisma.nuvionDocument.deleteMany({ where });
      await prisma.nuvionOnboarding.deleteMany({ where });
      await prisma.fintavaWallet.deleteMany({ where });
      await prisma.fintavaWalletOpening.deleteMany({ where });
      await prisma.nuvionEntity.deleteMany({ where });
    }
    if (app) await app.close();
    await standin.stop();
    await wawuId.stop();
    guard.restore();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const restore of restores.reverse()) restore();
  });

  // =========================================================================
  describe('a person uploads an ID front and back and a proof of address', () => {
    it('each is forwarded once to Nuvion, linked to their person, and the answer is the documents view', async () => {
      const who = await opened();
      const front = png();
      const back = jpegAsPng();
      const res = await send(who, 'identity', front, back).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const first = body<IdentityDocumentsView>(res).data!;
      expect(first).toMatchObject({
        required: true,
        open: true,
        submitted: false,
        selfie: 'not_used',
        waitingFor: ['proof_of_address'],
        maxBytes: 10 * MB,
        acceptedTypes: ['application/pdf', 'image/jpeg', 'image/png'],
      });
      expect(first.documents).toEqual([
        {
          kind: 'identity',
          state: 'uploaded',
          sides: ['front', 'back'],
          uploadedAt: expect.any(String) as string,
        },
        {
          kind: 'proof_of_address',
          state: 'missing',
          sides: [],
          uploadedAt: null,
        },
      ]);

      expect(uploads()).toHaveLength(1);
      const req = uploads()[0];
      expect(req.headers.authorization).toBe(`Bearer ${ENV.NUVION_API_KEY}`);
      expect(req.body).toEqual({
        entity_id: who.held.id,
        key: 'identity',
        description: 'Identity document',
        file: front.toString('base64'),
        file_back: back.toString('base64'),
        meta: { file_type: 'image/png' },
        link_to_identity: { person_id: who.held.personId },
      });
      expect(submissions()).toHaveLength(0);

      const proof = pdf();
      const second = body<IdentityDocumentsView>(
        await send(who, 'proof_of_address', proof).expect(200),
      ).data!;
      expect(uploads()).toHaveLength(2);
      expect(uploads()[1].body).toEqual({
        entity_id: who.held.id,
        key: 'proof_of_address',
        description: 'Proof of address',
        file: proof.toString('base64'),
        meta: { file_type: 'application/pdf' },
        link_to_identity: { person_id: who.held.personId },
      });
      expect(second.documents.map((d) => d.state)).toEqual([
        'uploaded',
        'uploaded',
      ]);
      expect(second.submitted).toBe(true);
      expect(second.open).toBe(false);
      expect(second.waitingFor).toEqual([]);

      // What WAWU keeps: the kind, the sides, the state, Nuvion's id, the time.
      const identity = await docRow(who, 'identity');
      expect(identity).toMatchObject({
        state: 'uploaded',
        sides: ['front', 'back'],
        entityId: who.held.id,
        nuvionDocumentId: nuvion.docs(who.held.id, 'identity')[0].id,
        attempts: 1,
      });
      expect(identity?.uploadedAt).toBeInstanceOf(Date);
    });

    it('a JPEG and a PDF front are sent with the type read from the bytes, not the type the client named', async () => {
      const who = await opened();
      await send(who, 'identity', jpeg()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(
        (uploads()[0].body as { meta: { file_type: string } }).meta.file_type,
      ).toBe('image/jpeg');
      expect(
        (uploads()[1].body as { meta: { file_type: string } }).meta.file_type,
      ).toBe('application/pdf');
    });

    it('a file of exactly 10 MB goes; the answer to a big upload is still the small view', async () => {
      const who = await opened();
      const big = Buffer.concat([
        PNG_SIG,
        Buffer.alloc(10 * MB - PNG_SIG.length, 3),
      ]);
      expect(big.length).toBe(10 * MB);
      const res = await send(who, 'identity', big).expect(200);
      expect(res.text.length).toBeLessThan(2_000);
      expect(uploads()).toHaveLength(1);
      expect((uploads()[0].body as { file: string }).file.length).toBe(
        Math.ceil((10 * MB) / 3) * 4,
      );
    });

    it('the opening goes through the real open route and reads checking once both are in', async () => {
      const who = await opened();
      expect((await wallet(who)).review?.stage).toBe('needs_documents');
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      const after = await wallet(who);
      expect(after.state).toBe('opening');
      expect(after.review?.stage).toBe('checking');
      expect(await openingRow(who)).toMatchObject({ state: 'open' });
      expect(await entityRow(who)).toMatchObject({ status: 'pending' });
      expect((await view(who)).submitted).toBe(true);
    });
  });

  // =========================================================================
  describe('a file over 10 MB or of another type answers before any call to Nuvion', () => {
    it('over 10 MB: 422 document_file_invalid, nothing sent, and the same for the back', async () => {
      const who = await opened();
      const tooBig = Buffer.concat([
        PNG_SIG,
        Buffer.alloc(10 * MB - PNG_SIG.length + 1, 3),
      ]);
      for (const res of [
        await send(who, 'identity', tooBig).expect(422),
        await send(who, 'identity', png(), tooBig).expect(422),
      ]) {
        const b = body(res);
        expect(b.reason?.code).toBe('document_file_invalid');
        expect(b.reason?.message).toBe(
          'That file is larger than 10 MB. Choose a smaller one.',
        );
        expect(b.data).toBeNull();
      }
      expect(standin.seen).toEqual([]);
      expect(await docRow(who, 'identity')).toBeNull();
    });

    it.each([
      ['a GIF', () => Buffer.from('GIF89a' + 'x'.repeat(200))],
      [
        'HTML',
        () => Buffer.from('<html><body>hi</body></html>' + ' '.repeat(100)),
      ],
      [
        'a ZIP',
        () => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 1)]),
      ],
      ['plain text', () => Buffer.from('my utility bill '.repeat(30))],
      [
        'a PDF cut short (no end marker)',
        () => Buffer.from('%PDF-1.4\n' + 'x'.repeat(5_000)),
      ],
      ['a bare PNG signature cut to 4 bytes', () => PNG_SIG.subarray(0, 4)],
    ])('%s: 422 document_file_invalid, nothing sent', async (_name, make) => {
      const who = await opened();
      const res = await send(who, 'identity', make()).expect(422);
      expect(body(res).reason).toMatchObject({
        code: 'document_file_invalid',
        message: 'Upload a PDF, JPG or PNG file.',
      });
      expect(standin.seen).toEqual([]);
    });

    it('an empty file: 422; the two sides of another type: 422; a back that is not a file type we take: 422', async () => {
      const who = await opened();
      const empty = body(
        await send(who, 'identity', Buffer.alloc(0)).expect(422),
      );
      expect(empty.reason).toMatchObject({
        code: 'document_file_invalid',
        message: 'That file is empty. Choose another.',
      });
      const mixed = body(await send(who, 'identity', png(), pdf()).expect(422));
      expect(mixed.reason).toMatchObject({
        code: 'document_file_invalid',
        message: 'Use the same file type for both sides.',
      });
      const junk = body(
        await send(who, 'identity', png(), Buffer.from('x'.repeat(100))).expect(
          422,
        ),
      );
      expect(junk.reason?.code).toBe('document_file_invalid');
      expect(standin.seen).toEqual([]);
    });

    it('a request that is not a clean upload: 400 document_request_invalid with a code, nothing sent', async () => {
      const who = await opened();
      const cases: Array<[string, Response]> = [
        ['no kind', await send(who, null, png())],
        ['an unknown kind', await send(who, 'passport', png())],
        ['no file', await send(who, 'identity', null)],
        [
          'a back for a proof of address',
          await send(who, 'proof_of_address', pdf(), pdf()),
        ],
        [
          'a lone back as the side',
          await send(who, 'identity', png(), null, { side: 'back' }),
        ],
        [
          'a field we do not read',
          await send(who, 'identity', png(), null, { note: 'hi' }),
        ],
      ];
      for (const [, res] of cases) {
        expect(res.status).toBe(400);
        expect(body(res).reason?.code).toBe('document_request_invalid');
        expect(body(res).data).toBeNull();
      }
      // A JSON body instead of a form.
      const json = await http()
        .post('/api/hub/money/identity/documents')
        .set('Authorization', who.auth)
        .send({ kind: 'identity' })
        .expect(400);
      expect(body(json).reason?.code).toBe('document_request_invalid');
      // `side=front` is harmless (the file is the front).
      await send(who, 'identity', png(), null, { side: 'front' }).expect(200);
      expect(uploads()).toHaveLength(1);
    });

    it('a third file part or an unexpected one is refused with a code', async () => {
      const who = await opened();
      const res = await http()
        .post('/api/hub/money/identity/documents')
        .set('Authorization', who.auth)
        .field('kind', 'identity')
        .attach('file', png(), { filename: 'a.bin' })
        .attach('extra', png(), { filename: 'b.bin' })
        .expect(400);
      expect(body(res).reason?.code).toBe('document_request_invalid');
      expect(standin.seen).toEqual([]);
    });

    it('an upload needs the token', async () => {
      await http()
        .post('/api/hub/money/identity/documents')
        .field('kind', 'identity')
        .attach('file', png(), { filename: 'a.bin' })
        .expect(401);
      await http().get('/api/hub/money/identity/documents').expect(401);
      await http().get('/api/hub/money/identity/liveness').expect(401);
      await http()
        .post('/api/hub/money/identity/liveness')
        .send({})
        .expect(401);
      expect(standin.seen).toEqual([]);
    });
  });

  /** The document routes alone, on a server whose provider is Fintava (reviews no documents). */
  async function bootFintava(): Promise<INestApplication<App>> {
    const m = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        NuvionDocumentsModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue({ name: 'fintava', configured: true })
      .compile();
    const a = m.createNestApplication({ logger });
    a.setGlobalPrefix('api/hub');
    a.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    a.useGlobalFilters(new AllExceptionsFilter());
    a.useGlobalInterceptors(new ResponseInterceptor());
    await a.init();
    await a.listen(0, '127.0.0.1');
    return a;
  }

  // =========================================================================
  describe('when both documents are accepted the opening is submitted for review exactly once', () => {
    it('the submission is one POST /onboarding-submissions for the child entity, after the second document', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      expect(submissions()).toHaveLength(0);
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
      expect(submissions()[0].body).toEqual({ entity_id: who.held.id });
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(1);
      expect(await onboarding(who)).toMatchObject({
        entityId: who.held.id,
        submitAttempts: 1,
        submittedAt: expect.any(Date) as Date,
      });
    });

    it('the first upload sent twice, one after the other: the second is the answer the first got, one document (V8)', async () => {
      const who = await opened();
      const id = png();
      const a = body<IdentityDocumentsView>(
        await send(who, 'identity', id).expect(200),
      ).data!;
      const b = body<IdentityDocumentsView>(
        await send(who, 'identity', id).expect(200),
      ).data!;
      expect(b).toEqual(a);
      expect(uploads()).toHaveLength(1);
      expect(submissions()).toHaveLength(0);
    });

    it('the last upload sent twice, one after the other: one document, one submission, and the second is told the opening is sent (V8)', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      const proof = pdf();
      const a = body<IdentityDocumentsView>(
        await send(who, 'proof_of_address', proof).expect(200),
      ).data!;
      expect(a.submitted).toBe(true);
      // The opening is with Nuvion's review, so no file is compared with a
      // fingerprint any more (it was cleared): the same file again is the
      // same as any other, a refused upload, and nothing is sent.
      const calls = standin.seen.length;
      const b = await send(who, 'proof_of_address', proof).expect(409);
      expect(body(b).reason?.code).toBe('documents_closed');
      expect(standin.seen).toHaveLength(calls);
      expect(uploads()).toHaveLength(2);
      expect(submissions()).toHaveLength(1);
    });

    it('the last upload sent twice at the same moment: one document, one submission (V8)', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      nuvion.uploadDelayMs = 400;
      const proof = pdf();
      const [a, b] = await Promise.all([
        send(who, 'proof_of_address', proof),
        send(who, 'proof_of_address', proof),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(
        sent('POST', '/documents').filter(
          (r) => (r.body as { key: string }).key === 'proof_of_address',
        ),
      ).toHaveLength(1);
      expect(submissions()).toHaveLength(1);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(1);
      expect((await view(who)).submitted).toBe(true);
    });

    it('two different files for one kind at the same moment: one goes, the other is told to wait, and Nuvion gets one call', async () => {
      const who = await opened();
      nuvion.uploadDelayMs = 500;
      const [a, b] = await Promise.all([
        send(who, 'identity', png()),
        send(who, 'identity', png()),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const lost = a.status === 409 ? a : b;
      expect(body(lost).reason?.code).toBe('document_in_progress');
      expect(body(lost).reason?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(uploads()).toHaveLength(1);
      expect(nuvion.docs(who.held.id, 'identity')).toHaveLength(1);
    });

    it('both documents at the same moment, and the same ones again at once: one submission', async () => {
      const who = await opened();
      nuvion.uploadDelayMs = 300;
      const id = png();
      const proof = pdf();
      const all = await Promise.all([
        send(who, 'identity', id),
        send(who, 'proof_of_address', proof),
        send(who, 'identity', id),
        send(who, 'proof_of_address', proof),
      ]);
      expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(uploads()).toHaveLength(2);
      expect(submissions()).toHaveLength(1);
    });

    it('five GETs of the documents view at once, with everything in and the submission due, send it once', async () => {
      const who = await opened();
      // Two documents in; the submission's answer was lost before the claim
      // lapsed: nothing is sent by a read, however many.
      await send(who, 'identity', png()).expect(200);
      nuvion.submitMode = 'nothing_then_500';
      await send(who, 'proof_of_address', pdf()).expect(200);
      const before = submissions().length;
      expect(before).toBe(1);
      nuvion.submitMode = 'ok';
      await Promise.all(Array.from({ length: 5 }, () => view(who)));
      expect(submissions()).toHaveLength(before);
    });

    it('any file after the opening was sent is refused with documents_closed and nothing is sent, the same file included (its fingerprint is gone)', async () => {
      const who = await opened();
      const id = png();
      await send(who, 'identity', id).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(
        (
          await prisma.nuvionDocument.findMany({
            where: { wawuUserId: who.id },
          })
        ).map((r) => r.fingerprint),
      ).toEqual([null, null]);
      const calls = standin.seen.length;
      const refused = body(await send(who, 'identity', png()).expect(409));
      expect(refused.reason?.code).toBe('documents_closed');
      expect(refused.reason?.message).toBe(
        'Your wallet is not taking documents right now. Check where your opening stands.',
      );
      expect(standin.seen).toHaveLength(calls);
      const same = body(await send(who, 'identity', id).expect(409));
      expect(same.reason?.code).toBe('documents_closed');
      expect(standin.seen).toHaveLength(calls);
      expect((await view(who)).submitted).toBe(true);
    });

    it('a person whose submission stands cannot upload even when the entity still reads incomplete (a stale write put the old word back, U2); nothing is sent', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
      // A stale delivery wrote the old word back: the entity reads
      // `incomplete` again while the submission stands.
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: { status: 'incomplete' },
      });
      const calls = standin.seen.length;
      const refused = body(await send(who, 'identity', png()).expect(409));
      expect(refused.reason?.code).toBe('documents_closed');
      expect(standin.seen).toHaveLength(calls);
      expect(submissions()).toHaveLength(1);
    });

    it('a different file for a kind already in replaces it while the opening still takes documents: one more call, the submission waits', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      const second = png();
      const res = body<IdentityDocumentsView>(
        await send(who, 'identity', second).expect(200),
      ).data!;
      expect(uploads()).toHaveLength(2);
      expect(res.documents[0].state).toBe('uploaded');
      expect(res.waitingFor).toEqual(['proof_of_address']);
      expect(await docRow(who, 'identity')).toMatchObject({
        attempts: 2,
        state: 'uploaded',
        nuvionDocumentId: nuvion.docs(who.held.id, 'identity')[1].id,
      });
      expect(submissions()).toHaveLength(0);
    });

    it('a submission whose answer was lost: nothing is sent again at once; once the window passes Nuvion is asked first, and if it already has it, none is made', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      nuvion.submitMode = 'made_then_500';
      const res = await send(who, 'proof_of_address', pdf()).expect(200);
      // The upload is in; the submission's answer was lost: the opening shows
      // it as not sent yet, and the claim stands.
      expect(body<IdentityDocumentsView>(res).data?.submitted).toBe(false);
      expect(submissions()).toHaveLength(1);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(1);
      nuvion.submitMode = 'ok';
      await view(who);
      await view(who);
      expect(submissions()).toHaveLength(1);

      await ageSubmission(who, RESEND_AFTER_MS + 500);
      const after = await view(who);
      // Nuvion has it (the entity is past incomplete): marked, not sent again.
      expect(after.submitted).toBe(true);
      expect(submissions()).toHaveLength(1);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(1);
      expect(sent('GET', /^\/entities\//).length).toBeGreaterThan(0);
      expect((await wallet(who)).review?.stage).toBe('checking');
    });

    it('an entity Nuvion still shows as rejected is not taken for a submission that landed', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      nuvion.submitMode = 'nothing_then_500';
      await send(who, 'proof_of_address', pdf()).expect(200);
      nuvion.submitMode = 'ok';
      // Nuvion never moved the entity back to incomplete after a correction.
      nuvion.entities.get(who.held.id)!.status = 'rejected';
      await ageSubmission(who, RESEND_AFTER_MS + 500);
      const after = await view(who);
      expect(after.submitted).toBe(false);
      expect((await onboarding(who))?.submittedAt).toBeNull();
      expect((await entityRow(who)).status).toBe('incomplete');
      // The same through a delivery.
      const r = await handler.handle(
        delivery(nuvion.entities.get(who.held.id)!),
      );
      expect(r.outcome).toBe('done');
      expect((await onboarding(who))?.submittedAt).toBeNull();
    });

    it('a submission that never reached Nuvion is sent again once, after the window, behind a new claim', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      nuvion.submitMode = 'nothing_then_500';
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(0);
      nuvion.submitMode = 'ok';
      await view(who);
      expect(submissions()).toHaveLength(1); // inside the window
      await ageSubmission(who, RESEND_AFTER_MS + 500);
      const after = await view(who);
      expect(after.submitted).toBe(true);
      expect(submissions()).toHaveLength(2);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(1);
      expect(await onboarding(who)).toMatchObject({ submitAttempts: 2 });
    });

    it('Nuvion refusing the submission: nothing was made, the claim goes, it is not sent again for a minute, and a changed document lifts that', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      nuvion.submitMode = { refuse: 'error_kyc_documents_incomplete' };
      const res = await send(who, 'proof_of_address', pdf()).expect(200);
      expect(body<IdentityDocumentsView>(res).data?.submitted).toBe(false);
      expect(submissions()).toHaveLength(1);
      expect((await onboarding(who))?.submitRequestedAt).toBeNull();
      expect((await onboarding(who))?.submitRefusedAt).toBeInstanceOf(Date);
      nuvion.submitMode = 'ok';
      // Looking again at once sends nothing (no loop on a refusal).
      expect((await view(who)).submitted).toBe(false);
      expect(submissions()).toHaveLength(1);
      // A minute on, the next look sends it.
      await prisma.nuvionOnboarding.update({
        where: { wawuUserId: who.id },
        data: { submitRefusedAt: new Date(Date.now() - 61_000) },
      });
      expect((await view(who)).submitted).toBe(true);
      expect(submissions()).toHaveLength(2);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(1);
    });

    it('a changed document lifts the back-off at once', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      nuvion.submitMode = { refuse: 'error_kyc_documents_incomplete' };
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
      nuvion.submitMode = 'ok';
      const res = await send(who, 'proof_of_address', pdf()).expect(200);
      expect(body<IdentityDocumentsView>(res).data?.submitted).toBe(true);
      expect(submissions()).toHaveLength(2);
    });
  });

  // =========================================================================
  describe('nobody reads, replaces or submits another person’s documents, and no opening means the existing no-wallet answer', () => {
    it('with no opening started every document and selfie route answers 409 wallet_not_open, the same sentence as the wallet gate, and nothing is sent', async () => {
      const who = stranger();
      const answers = [
        await http()
          .get('/api/hub/money/identity/documents')
          .set('Authorization', who.auth)
          .expect(409),
        await send(who, 'identity', png()).expect(409),
        await http()
          .get('/api/hub/money/identity/liveness')
          .set('Authorization', who.auth)
          .expect(409),
        await startLiveness(who).expect(409),
      ];
      for (const res of answers) {
        const b = body(res);
        expect(b.reason).toEqual({
          code: 'wallet_not_open',
          message: NO_WALLET_MESSAGE,
        });
        expect(b.data).toBeNull();
      }
      const gate = await http()
        .get('/api/hub/money/wallet/balance')
        .set('Authorization', who.auth)
        .expect(409);
      expect(body(gate).reason).toEqual(body(answers[0]).reason);
      expect(standin.seen).toEqual([]);
      expect(await docRow(who, 'identity')).toBeNull();
    });

    it('two people: each reads and changes only their own rows, whatever is in the request', async () => {
      const a = await opened();
      const b = await opened();
      await send(a, 'identity', png()).expect(200);
      const seenByB = await view(b);
      expect(seenByB.documents.map((d) => d.state)).toEqual([
        'missing',
        'missing',
      ]);
      // B names A's entity and person in the form: ignored, B's own are used.
      await http()
        .post('/api/hub/money/identity/documents')
        .set('Authorization', b.auth)
        .field('kind', 'identity')
        .field('entityId', a.held.id)
        .attach('file', png(), { filename: 'x.bin' })
        .expect(400);
      await send(b, 'identity', png()).expect(200);
      const forB = uploads()[1].body as {
        entity_id: string;
        link_to_identity: { person_id: string };
      };
      expect(forB.entity_id).toBe(b.held.id);
      expect(forB.link_to_identity.person_id).toBe(b.held.personId);
      expect((await docRow(a, 'identity'))?.nuvionDocumentId).toBe(
        nuvion.docs(a.held.id, 'identity')[0].id,
      );
      expect(nuvion.docs(a.held.id)).toHaveLength(1);
      expect(nuvion.docs(b.held.id)).toHaveLength(1);
      // B completing theirs submits B's entity only.
      await send(b, 'proof_of_address', pdf()).expect(200);
      expect(
        submissions().map((s) => (s.body as { entity_id: string }).entity_id),
      ).toEqual([b.held.id]);
      expect((await entityRow(a)).status).toBe('incomplete');
      expect((await view(a)).submitted).toBe(false);
    });

    it('a person whose wallet is already open is told the documents are closed', async () => {
      const who = await opened();
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: who.id,
          customerId: `c-${who.id}`,
          walletId: `w-${who.id}`,
          accountNumber: digits(10),
          accountName: 'Ada Documents',
          provider: 'nuvion',
        },
      });
      const res = await send(who, 'identity', png()).expect(409);
      expect(body(res).reason?.code).toBe('documents_closed');
      expect((await view(who)).open).toBe(false);
      expect(standin.seen).toEqual([]);
    });

    it('an opening that is being checked, approved or stopped takes no new document', async () => {
      for (const status of ['pending', 'approved', 'failed', 'suspended']) {
        const who = await opened({ status, held: { status } });
        const res = await send(who, 'identity', png()).expect(409);
        expect(body(res).reason?.code).toBe('documents_closed');
        expect((await view(who)).open).toBe(false);
      }
      // A refusal nobody has corrected yet is closed too: send the details again first.
      const rejected = await opened({
        status: 'rejected',
        held: { status: 'rejected' },
        decidedAt: new Date(),
      });
      expect(
        body(await send(rejected, 'identity', png()).expect(409)).reason?.code,
      ).toBe('documents_closed');
      expect(standin.seen).toEqual([]);
    });
  });
  // =========================================================================
  describe('an upload whose answer was lost, or that Nuvion refused', () => {
    it('a late answer: 503 with nothing sure, the row is unknown, and the view says it is being confirmed', async () => {
      const who = await opened();
      nuvion.uploadMode = 'late';
      const first = await send(who, 'identity', png());
      expect(first.status).toBe(503);
      expect(body(first).reason).toMatchObject({
        code: 'provider_unreachable',
        message:
          'We could not confirm that upload yet. Check again in a moment before you send it again.',
      });
      expect(uploads()).toHaveLength(1);
      expect(await docRow(who, 'identity')).toMatchObject({
        state: 'unknown',
        attempts: 1,
      });
      expect(nuvion.docs(who.held.id, 'identity')).toHaveLength(1); // Nuvion made it
      expect((await view(who)).documents[0].state).toBe('confirming');
    });

    it('an upload Nuvion never got reads confirming inside the window and send_again after it, never confirming for ever; sending the same file again goes once (D3)', async () => {
      const who = await opened();
      const file = png();
      nuvion.uploadMode = 'nothing_then_500';
      await send(who, 'identity', file).expect(503);
      expect(nuvion.docs(who.held.id, 'identity')).toHaveLength(0);
      expect((await view(who)).documents[0].state).toBe('confirming');

      await age(who, 'identity', RESEND_AFTER_MS + 500);
      const after = await view(who);
      expect(after.documents[0]).toEqual({
        kind: 'identity',
        state: 'send_again',
        sides: [],
        uploadedAt: null,
      });
      expect(after.waitingFor).toEqual(['identity', 'proof_of_address']);
      expect(after.open).toBe(true);
      // The view asked Nuvion's list (a read) and sent no file.
      expect(uploads()).toHaveLength(1);
      expect(
        sent('GET', new RegExp(`^/entities/${who.held.id}$`)).length,
      ).toBeGreaterThanOrEqual(1);
      // The row is left as it was, so the upload route still looks first.
      expect(await docRow(who, 'identity')).toMatchObject({ state: 'unknown' });

      nuvion.uploadMode = 'ok';
      const again = await send(who, 'identity', file).expect(200);
      expect(body<IdentityDocumentsView>(again).data?.documents[0].state).toBe(
        'uploaded',
      );
      expect(uploads()).toHaveLength(2);
      expect(nuvion.docs(who.held.id, 'identity')).toHaveLength(1);
      expect(await docRow(who, 'identity')).toMatchObject({
        state: 'uploaded',
        attempts: 2,
      });
      // And once the second document is in, the opening is sent once.
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
    });

    it('an upload Nuvion took reads uploaded from the view once the window has passed, and the same file is not sent again (D3, the stored one)', async () => {
      const who = await opened();
      const file = png();
      nuvion.uploadMode = 'late';
      await send(who, 'identity', file).expect(503);
      nuvion.uploadMode = 'ok';
      expect((await view(who)).documents[0].state).toBe('confirming');
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      const after = await view(who);
      expect(after.documents[0]).toMatchObject({
        state: 'uploaded',
        sides: ['front'],
      });
      expect(await docRow(who, 'identity')).toMatchObject({
        state: 'uploaded',
        nuvionDocumentId: nuvion.docs(who.held.id, 'identity')[0].id,
      });
      expect(uploads()).toHaveLength(1);
    });

    it('past the window with Nuvion unreadable the view says send_again and sends nothing; once it can be read the same file is looked for before it is sent', async () => {
      const who = await opened();
      const file = png();
      nuvion.uploadMode = 'late';
      await send(who, 'identity', file).expect(503);
      nuvion.uploadMode = 'ok';
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      standin.failNext('error_system_internal_error');
      const blind = await view(who);
      expect(blind.documents[0].state).toBe('send_again');
      expect(uploads()).toHaveLength(1);
      // Nuvion is readable again: it did take the file, so it is not sent.
      const res = await send(who, 'identity', file).expect(200);
      expect(body<IdentityDocumentsView>(res).data?.documents[0].state).toBe(
        'uploaded',
      );
      expect(uploads()).toHaveLength(1);
    });

    it('the same file again while the answer is unknown is not sent; a different file is told to wait with a retry time', async () => {
      const who = await opened();
      const file = png();
      nuvion.uploadMode = 'late';
      await send(who, 'identity', file).expect(503);
      nuvion.uploadMode = 'ok';
      const same = await send(who, 'identity', file).expect(200);
      expect(body<IdentityDocumentsView>(same).data?.documents[0].state).toBe(
        'confirming',
      );
      expect(uploads()).toHaveLength(1);
      const other = await send(who, 'identity', png()).expect(409);
      const b = body(other);
      expect(b.reason?.code).toBe('document_in_progress');
      expect(b.reason?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(b.reason?.retryAfterSeconds).toBeLessThanOrEqual(
        RESEND_AFTER_MS / 1000,
      );
      expect(uploads()).toHaveLength(1);
    });

    it('past the window Nuvion is asked first: if it made the document, it is adopted and the same file is not sent again', async () => {
      const who = await opened();
      const file = png();
      nuvion.uploadMode = 'late';
      await send(who, 'identity', file).expect(503);
      nuvion.uploadMode = 'ok';
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      const res = await send(who, 'identity', file).expect(200);
      expect(body<IdentityDocumentsView>(res).data?.documents[0]).toMatchObject(
        { state: 'uploaded', sides: ['front'] },
      );
      expect(uploads()).toHaveLength(1);
      expect(await docRow(who, 'identity')).toMatchObject({
        state: 'uploaded',
        nuvionDocumentId: nuvion.docs(who.held.id, 'identity')[0].id,
      });
    });

    it('past the window, a different file: the lost one is adopted, then the new one replaces it (two calls in all, never three)', async () => {
      const who = await opened();
      nuvion.uploadMode = 'late';
      await send(who, 'identity', png()).expect(503);
      nuvion.uploadMode = 'ok';
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      await send(who, 'identity', png()).expect(200);
      expect(uploads()).toHaveLength(2);
      expect(nuvion.docs(who.held.id, 'identity')).toHaveLength(2);
    });

    it('past the window, with nothing at Nuvion: the file goes once, behind a new attempt', async () => {
      const who = await opened();
      nuvion.uploadMode = 'nothing_then_500';
      await send(who, 'identity', png()).expect(503);
      expect(nuvion.docs(who.held.id, 'identity')).toHaveLength(0);
      nuvion.uploadMode = 'ok';
      const file = png();
      // The first row is unknown (a 500 may have made it): wait out the window.
      expect(await docRow(who, 'identity')).toMatchObject({ state: 'unknown' });
      await send(who, 'identity', file).expect(409);
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      await send(who, 'identity', file).expect(200);
      expect(uploads()).toHaveLength(2);
      expect(await docRow(who, 'identity')).toMatchObject({
        state: 'uploaded',
        attempts: 2,
      });
    });

    it('past the window and Nuvion cannot be read: nothing is sent, 503', async () => {
      const who = await opened();
      nuvion.uploadMode = 'late';
      await send(who, 'identity', png()).expect(503);
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      nuvion.uploadMode = 'ok';
      standin.failNext('error_system_internal_error');
      const res = await send(who, 'identity', png()).expect(503);
      expect(body(res).reason?.code).toBe('provider_unreachable');
      expect(uploads()).toHaveLength(1);
      expect(await docRow(who, 'identity')).toMatchObject({ state: 'unknown' });
    });

    it('a document a person already has on file is never taken for a later lost upload of theirs', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      const first = nuvion.docs(who.held.id, 'identity')[0];
      // A replacement whose answer is lost and which Nuvion never made.
      nuvion.uploadMode = 'nothing_then_500';
      await send(who, 'identity', png()).expect(503);
      nuvion.uploadMode = 'ok';
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      // The earlier document is within the clock-skew allowance of the lost
      // attempt: it must not be adopted for it. The new file is sent.
      const file = png();
      await send(who, 'identity', file).expect(200);
      expect(uploads()).toHaveLength(3);
      const row = await docRow(who, 'identity');
      expect(row?.nuvionDocumentId).not.toBe(first.id);
      expect(row?.knownDocumentIds).toEqual([
        first.id,
        nuvion.docs(who.held.id, 'identity')[1].id,
      ]);
    });

    it('a document Nuvion holds for the entity from long before the attempt is never taken for a lost upload (V12)', async () => {
      const who = await opened();
      const file = png();
      nuvion.uploadMode = 'nothing_then_500';
      await send(who, 'identity', file).expect(503);
      nuvion.uploadMode = 'ok';
      // Nuvion's list holds an identity document made an hour before this
      // attempt that this row never recorded (put there by someone else).
      const old = {
        id: ulid('01OLD'),
        key: 'identity',
        created: Date.now() - 60 * 60_000,
        fileType: 'image/png',
        hasBack: false,
        personId: who.held.personId,
        fileChars: 10,
      };
      nuvion.entities.get(who.held.id)!.documents.push(old);
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      // The view looks and does not adopt it.
      expect((await view(who)).documents[0].state).toBe('send_again');
      // The upload route looks and does not adopt it: the file goes.
      await send(who, 'identity', file).expect(200);
      expect(uploads()).toHaveLength(2);
      const row = await docRow(who, 'identity');
      expect(row?.nuvionDocumentId).not.toBe(old.id);
      expect(row?.knownDocumentIds).not.toContain(old.id);
    });

    it('a row left sending by a request that died is recovered after the window: the same file or another is looked for, then sent (V21)', async () => {
      for (const same of [true, false]) {
        const who = await opened();
        const file = png();
        nuvion.uploadMode = 'nothing_then_500';
        await send(who, 'identity', file).expect(503);
        nuvion.uploadMode = 'ok';
        // The request that held it was killed before it heard anything.
        await prisma.nuvionDocument.update({
          where: {
            wawuUserId_kind: { wawuUserId: who.id, kind: 'identity' },
          },
          data: { state: 'sending' },
        });
        // Inside the window it is still in progress.
        const wait = await send(who, 'identity', same ? file : png());
        expect(wait.status).toBe(same ? 200 : 409);
        await age(who, 'identity', RESEND_AFTER_MS + 500);
        const before = uploads().length;
        const res = await send(who, 'identity', same ? file : png()).expect(
          200,
        );
        expect(body<IdentityDocumentsView>(res).data?.documents[0].state).toBe(
          'uploaded',
        );
        expect(uploads()).toHaveLength(before + 1);
        expect(await docRow(who, 'identity')).toMatchObject({
          state: 'uploaded',
          attempts: 2,
        });
      }
    });

    it('a document recorded for an earlier entity is not the answer for the entity the person has now (V25)', async () => {
      const who = await opened();
      const file = png();
      await send(who, 'identity', file).expect(200);
      expect(uploads()).toHaveLength(1);
      // The person\u2019s entity is another one now (a new opening after a rollback).
      const second = nuvion.addEntity();
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: { entityId: second.id, personId: second.personId },
      });
      await send(who, 'identity', file).expect(200);
      expect(uploads()).toHaveLength(2);
      expect((uploads()[1].body as { entity_id: string }).entity_id).toBe(
        second.id,
      );
      expect(nuvion.docs(second.id, 'identity')).toHaveLength(1);
      expect(await docRow(who, 'identity')).toMatchObject({
        entityId: second.id,
        state: 'uploaded',
      });
    });

    it('a lost upload is never taken for a document of the other kind, or for another person\u2019s', async () => {
      const a = await opened();
      const b = await opened();
      await send(a, 'proof_of_address', pdf()).expect(200);
      await send(b, 'identity', png()).expect(200);
      nuvion.uploadMode = 'nothing_then_500';
      await send(a, 'identity', png()).expect(503);
      nuvion.uploadMode = 'ok';
      await age(a, 'identity', RESEND_AFTER_MS + 500);
      await send(a, 'identity', png()).expect(200);
      expect(nuvion.docs(a.held.id, 'identity')).toHaveLength(1);
      expect(uploads()).toHaveLength(4);
      expect((await docRow(a, 'identity'))?.nuvionDocumentId).toBe(
        nuvion.docs(a.held.id, 'identity')[0].id,
      );
      expect((await docRow(b, 'identity'))?.nuvionDocumentId).toBe(
        nuvion.docs(b.held.id, 'identity')[0].id,
      );
    });

    it('Nuvion refusing the file: 422 document_not_accepted, nothing kept, the state says send another, and the corrected file goes', async () => {
      const who = await opened();
      nuvion.uploadMode = { refuse: 'error_kyc_document_quality_insufficient' };
      const res = await send(who, 'identity', png()).expect(422);
      expect(body(res).reason).toEqual({
        code: 'document_not_accepted',
        message:
          'We could not accept that file. Check that it is clear and complete, then try again.',
      });
      expect(uploads()).toHaveLength(1);
      const state = (await view(who)).documents[0];
      expect(state).toEqual({
        kind: 'identity',
        state: 'not_accepted',
        sides: [],
        uploadedAt: null,
      });
      expect(await docRow(who, 'identity')).toMatchObject({
        state: 'failed',
        fingerprint: null,
        nuvionDocumentId: null,
      });
      nuvion.uploadMode = 'ok';
      await send(who, 'identity', png()).expect(200);
      expect(uploads()).toHaveLength(2);
      expect((await view(who)).documents[0].state).toBe('uploaded');
    });

    it.each([
      ['error_kyc_under_compliance_review', 409, 'identity_under_review'],
      [
        'error_entity_person_document_link_mismatch',
        422,
        'document_not_accepted',
      ],
      ['error_kyc_document_expired', 422, 'document_not_accepted'],
      ['error_validation_file_empty', 422, 'document_not_accepted'],
    ])('Nuvion says %s: %i %s', async (type, status, code) => {
      const who = await opened();
      nuvion.uploadMode = { refuse: type };
      const res = await send(who, 'identity', png());
      expect(res.status).toBe(status);
      expect(body(res).reason?.code).toBe(code);
      expect(body(res).data).toBeNull();
    });

    it('Nuvion rate limiting us or being down for a moment: 503 with a wait, nothing made, the state is still "missing" and the same file may be sent again at once', async () => {
      const who = await opened();
      standin.rateLimitNext(7);
      const res = await send(who, 'identity', png()).expect(503);
      expect(body(res).reason).toMatchObject({
        code: 'provider_unreachable',
        retryAfterSeconds: 7,
      });
      expect((await view(who)).documents[0].state).toBe('missing');
      expect(await docRow(who, 'identity')).toMatchObject({ state: 'failed' });
      const file = png();
      await send(who, 'identity', file).expect(200);
      expect(uploads()).toHaveLength(2);
    });

    it('an answer that does not name the document sent is not proof: the row is unknown, not uploaded', async () => {
      const who = await opened();
      standin.next(() => ({
        status: 201,
        body: envelope({
          document: { id: ulid('01DOC'), key: 'proof_of_address' },
        }),
      }));
      const res = await send(who, 'identity', png()).expect(503);
      expect(body(res).reason?.code).toBe('provider_unreachable');
      expect(await docRow(who, 'identity')).toMatchObject({ state: 'unknown' });
    });

    it('the person with no person id on file: it is read from Nuvion once and kept, then the document is linked to it', async () => {
      const who = await opened({ noPerson: true });
      await send(who, 'identity', png()).expect(200);
      const read = sent('GET', /^\/entities\//);
      expect(read.length).toBeGreaterThan(0);
      expect(
        (uploads()[0].body as { link_to_identity: { person_id: string } })
          .link_to_identity.person_id,
      ).toBe(who.held.personId);
      expect((await entityRow(who)).personId).toBe(who.held.personId);
    });
  });

  // =========================================================================
  describe('limits on uploads', () => {
    it('the ninth upload request in ten minutes is 429 document_rate_limited before anything is sent', async () => {
      const who = await opened();
      const file = png();
      for (let i = 0; i < 8; i += 1)
        await send(who, 'identity', file).expect(200);
      expect(uploads()).toHaveLength(1); // the same file: one call
      const res = await send(who, 'identity', file).expect(429);
      expect(body(res).reason?.code).toBe('document_rate_limited');
      expect(body(res).reason?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(uploads()).toHaveLength(1);
      // Someone else is not held up by it.
      const other = await opened();
      await send(other, 'identity', png()).expect(200);
    });

    it('with every place taken a further upload waits, then is 503 document_busy with a retry time, and nothing is sent for it', async () => {
      slots.max = 1;
      slots.waitMs = 300;
      const a = await opened();
      const b = await opened();
      nuvion.uploadDelayMs = 900;
      const [one, two] = await Promise.all([
        send(a, 'identity', png()),
        (async () => {
          await sleep(100);
          return send(b, 'identity', png());
        })(),
      ]);
      expect(one.status).toBe(200);
      expect(two.status).toBe(503);
      expect(body(two).reason).toMatchObject({
        code: 'document_busy',
        retryAfterSeconds: 1,
      });
      expect(uploads()).toHaveLength(1);
      expect(slots.peak).toBeGreaterThanOrEqual(1);
      // The place came back.
      nuvion.uploadDelayMs = 0;
      await send(b, 'identity', png()).expect(200);
    });
  });
  // =========================================================================
  describe('the hosted selfie', () => {
    const RETURN = 'https://wawuafrica.example/return';

    it('off by default: the selfie is not in use, nothing is asked of Nuvion, and the opening is not held for one', async () => {
      const who = await opened();
      expect(await liveness(who)).toEqual({
        enabled: false,
        state: 'not_in_use',
        url: null,
        startedAt: null,
        canStart: false,
      });
      const res = await startLiveness(who).expect(409);
      expect(body(res).reason).toEqual({
        code: 'selfie_not_available',
        message: 'A selfie is not needed for this wallet.',
      });
      expect(sessionStarts()).toHaveLength(0);
      expect(provider.capabilities.hostedLiveness).toBe(false);
      await send(who, 'identity', png()).expect(200);
      const v = body<IdentityDocumentsView>(
        await send(who, 'proof_of_address', pdf()).expect(200),
      ).data!;
      expect(v.selfie).toBe('not_used');
      expect(v.submitted).toBe(true);
    });

    describe('switched on', () => {
      beforeEach(() => {
        settings().hostedLiveness = true;
        // The server lists where the selfie page may send a person back to.
        settings().livenessRedirectOrigins = [
          'https://wawuafrica.example/return',
        ];
      });

      it('a person starts it, is given the secure page, comes back, and the opening reads the result: pending, passed', async () => {
        const who = await opened();
        expect(provider.capabilities.hostedLiveness).toBe(true);
        expect(await liveness(who)).toMatchObject({
          enabled: true,
          state: 'not_started',
          canStart: true,
          url: null,
        });
        const started = await startLiveness(who, {
          redirectUrl: RETURN,
        }).expect(200);
        expect(started.headers['cache-control']).toBe('no-store');
        const s = body<IdentityLivenessView>(started).data!;
        expect(s).toMatchObject({
          enabled: true,
          state: 'pending',
          canStart: false,
          url: expect.stringMatching(
            /^https:\/\/verify\.example\.invalid\//,
          ) as string,
        });
        // The call for the child entity, with the way back; the session saved on the entity.
        expect(sessionStarts()).toHaveLength(1);
        expect(sessionStarts()[0].body).toEqual({
          entity_id: who.held.id,
          redirect_url: RETURN,
        });
        const session = [...nuvion.sessions.values()][0];
        expect(nuvion.entities.get(who.held.id)?.meta).toEqual({
          liveness_check_id: session.id,
        });
        expect(await onboarding(who)).toMatchObject({
          livenessSessionId: session.id,
          livenessState: 'pending',
          livenessLinkedAt: expect.any(Date) as Date,
          livenessSessions: 1,
        });

        // Back from the page: the capture is done, the check is not.
        session.captureStatus = 'completed';
        expect(await liveness(who)).toMatchObject({ state: 'pending' });
        // Passed.
        session.verificationStatus = 'approved';
        const passed = await liveness(who);
        expect(passed).toMatchObject({ state: 'passed', url: null });
        expect((await onboarding(who))?.livenessState).toBe('passed');
        // The result read carries the child entity.
        const reads = sent('GET', /^\/kyc\/liveness\/sessions\//);
        expect(reads.length).toBeGreaterThanOrEqual(2);
        expect(reads[0].query.entity_id).toBe(who.held.id);
      });

      it('starting it again while one is running answers that one: one session at Nuvion, the same page', async () => {
        const who = await opened();
        const a = body<IdentityLivenessView>(
          await startLiveness(who).expect(200),
        ).data!;
        const b = body<IdentityLivenessView>(
          await startLiveness(who).expect(200),
        ).data!;
        expect(sessionStarts()).toHaveLength(1);
        expect(b.state).toBe('pending');
        expect(b.url).toBe(a.url);
      });

      it('two starts at the same moment make one session', async () => {
        const who = await opened();
        const [a, b] = await Promise.all([
          startLiveness(who),
          startLiveness(who),
        ]);
        expect([200, 409]).toEqual(expect.arrayContaining([a.status]));
        expect([200, 409]).toEqual(expect.arrayContaining([b.status]));
        expect(
          Math.max(a.status === 200 ? 1 : 0, b.status === 200 ? 1 : 0),
        ).toBe(1);
        expect(sessionStarts()).toHaveLength(1);
        for (const r of [a, b]) {
          if (r.status === 409) {
            expect(body(r).reason?.code).toBe('document_in_progress');
          }
        }
      });

      it('a selfie Nuvion did not approve can be started again, and the second session replaces the first', async () => {
        const who = await opened();
        await startLiveness(who).expect(200);
        const first = [...nuvion.sessions.values()][0];
        first.captureStatus = 'completed';
        first.verificationStatus = 'not-approved';
        expect(await liveness(who)).toMatchObject({
          state: 'not_passed',
          canStart: true,
          url: null,
        });
        await startLiveness(who).expect(200);
        expect(sessionStarts()).toHaveLength(2);
        const second = [...nuvion.sessions.values()][1];
        expect(nuvion.entities.get(who.held.id)?.meta).toEqual({
          liveness_check_id: second.id,
        });
        second.captureStatus = 'completed';
        second.verificationStatus = 'approved';
        expect((await liveness(who)).state).toBe('passed');
        expect(await onboarding(who)).toMatchObject({
          livenessSessionId: second.id,
          livenessSessions: 2,
        });
      });

      it('a capture that errored counts as not passed', async () => {
        const who = await opened();
        await startLiveness(who).expect(200);
        [...nuvion.sessions.values()][0].captureStatus = 'image-error';
        expect((await liveness(who)).state).toBe('not_passed');
      });

      it('a session pending past its window reads expired and may be started again', async () => {
        const who = await opened();
        await startLiveness(who).expect(200);
        await prisma.nuvionOnboarding.update({
          where: { wawuUserId: who.id },
          data: { livenessStartedAt: new Date(Date.now() - 31 * 60_000) },
        });
        expect(await liveness(who)).toMatchObject({
          state: 'expired',
          canStart: true,
          url: null,
        });
        await startLiveness(who).expect(200);
        expect(sessionStarts()).toHaveLength(2);
      });

      it('documents first, then the selfie: the opening is held for it, and sent once when it passes', async () => {
        const who = await opened();
        await send(who, 'identity', png()).expect(200);
        const held = body<IdentityDocumentsView>(
          await send(who, 'proof_of_address', pdf()).expect(200),
        ).data!;
        expect(held).toMatchObject({
          selfie: 'needed',
          submitted: false,
          waitingFor: ['selfie'],
        });
        expect(submissions()).toHaveLength(0);
        await startLiveness(who).expect(200);
        const session = [...nuvion.sessions.values()][0];
        session.captureStatus = 'completed';
        session.verificationStatus = 'approved';
        await liveness(who);
        expect(submissions()).toHaveLength(1);
        expect((await view(who)).submitted).toBe(true);
        await liveness(who);
        await view(who);
        expect(submissions()).toHaveLength(1);
        expect((await wallet(who)).review?.stage).toBe('checking');
      });

      it('the selfie first, then the documents: the last document sends the opening', async () => {
        const who = await opened();
        await startLiveness(who).expect(200);
        const session = [...nuvion.sessions.values()][0];
        session.captureStatus = 'completed';
        session.verificationStatus = 'approved';
        await liveness(who);
        await send(who, 'identity', png()).expect(200);
        expect(submissions()).toHaveLength(0);
        const done = body<IdentityDocumentsView>(
          await send(who, 'proof_of_address', pdf()).expect(200),
        ).data!;
        expect(done).toMatchObject({ selfie: 'done', submitted: true });
        expect(submissions()).toHaveLength(1);
      });

      it('a pass that could not be saved on the entity does not count until it is, and the save is repeated', async () => {
        const who = await opened();
        nuvion.linkRefuse = { refuse: 'error_validation_error' };
        await send(who, 'identity', png()).expect(200);
        await send(who, 'proof_of_address', pdf()).expect(200);
        await startLiveness(who).expect(200);
        expect((await onboarding(who))?.livenessLinkedAt).toBeNull();
        const session = [...nuvion.sessions.values()][0];
        session.captureStatus = 'completed';
        session.verificationStatus = 'approved';
        expect((await liveness(who)).state).toBe('passed');
        expect(submissions()).toHaveLength(0);
        expect((await view(who)).selfie).toBe('needed');
        nuvion.linkRefuse = null;
        await liveness(who);
        expect((await onboarding(who))?.livenessLinkedAt).not.toBeNull();
        expect(submissions()).toHaveLength(1);
        expect(nuvion.entities.get(who.held.id)?.meta).toEqual({
          liveness_check_id: session.id,
        });
      });

      it('the way back must be an address the server lists, by origin AND path prefix; an empty list allows none (D2)', async () => {
        const who = await opened();
        const refused = {
          code: 'document_request_invalid',
          message:
            'The address to return to must be a secure web address we know.',
        };
        for (const redirectUrl of [
          'http://wawuafrica.example/return',
          'javascript:alert(1)',
          'https://user:pass@wawuafrica.example/return',
          'not a url',
          // Our origin, but not our path.
          'https://wawuafrica.example/',
          'https://wawuafrica.example/elsewhere',
          'https://wawuafrica.example/returned',
          'https://wawuafrica.example/return/../elsewhere',
          'https://wawuafrica.example/return/%2e%2e/elsewhere',
          // Our path, not our origin.
          'https://evil.example/return',
          'https://wawuafrica.example.evil.example/return',
          'https://wawuafrica.example@evil.example/return',
          'https://wawuafrica.example:8443/return',
        ]) {
          const res = await startLiveness(who, { redirectUrl }).expect(400);
          expect(body(res).reason).toEqual(refused);
        }
        expect(sessionStarts()).toHaveLength(0);
        // An empty list allows no address at all (any https address used to pass).
        settings().livenessRedirectOrigins = [];
        for (const redirectUrl of [
          RETURN,
          'https://app.wawu.example/done',
          'https://anywhere.example/x',
        ]) {
          const res = await startLiveness(who, { redirectUrl }).expect(400);
          expect(body(res).reason).toEqual(refused);
        }
        expect(sessionStarts()).toHaveLength(0);
        // Origin and path prefix: the entry's own path, and anything under it.
        settings().livenessRedirectOrigins = ['https://app.wawu.example/open'];
        await startLiveness(who, {
          redirectUrl: 'https://app.wawu.example/open/done?x=1',
        }).expect(200);
        expect(sessionStarts()).toHaveLength(1);
        expect(
          (sessionStarts()[0].body as { redirect_url: string }).redirect_url,
        ).toBe('https://app.wawu.example/open/done?x=1');
        // A body field we do not read is the validation pipe's plain 400.
        await startLiveness(who, { note: 'hi' }).expect(400);
      });

      it('no return address: none is sent', async () => {
        const who = await opened();
        await startLiveness(who).expect(200);
        expect(sessionStarts()[0].body).toEqual({ entity_id: who.held.id });
      });

      it('once the opening has been sent or decided, no selfie can be started', async () => {
        const who = await opened({
          status: 'pending',
          held: { status: 'pending' },
        });
        const res = await startLiveness(who).expect(409);
        expect(body(res).reason?.code).toBe('documents_closed');
        expect(sessionStarts()).toHaveLength(0);
      });

      it('a person starts at most six sessions an hour', async () => {
        const who = await opened();
        for (let i = 0; i < 6; i += 1) {
          await startLiveness(who).expect(200);
          [...nuvion.sessions.values()][i].verificationStatus = 'not-approved';
        }
        const res = await startLiveness(who).expect(429);
        expect(body(res).reason?.code).toBe('document_rate_limited');
        expect(sessionStarts()).toHaveLength(6);
      });
    });

    describe('Nuvion says its selfie API is not there for us (R-39): off for everyone, loudly, and the opening goes on without it', () => {
      beforeEach(() => {
        settings().hostedLiveness = true;
        settings().livenessRedirectOrigins = [
          'https://wawuafrica.example/return',
        ];
      });

      it.each([
        [
          'permission denied',
          { refuse: 'error_auth_permission_denied', status: 403 },
        ],
        [
          'administrator permission required',
          { refuse: 'error_auth_elevated_permission_required', status: 403 },
        ],
        [
          'no such endpoint',
          { refuse: 'error_endpoint_not_found', status: 404 },
        ],
      ])(
        '%s: selfie_not_available, the capability goes off for everyone, the documents alone send the opening, and no row of the person says so',
        async (_name, refuse) => {
          const who = await opened();
          const other = await opened();
          await send(who, 'identity', png()).expect(200);
          const held = body<IdentityDocumentsView>(
            await send(who, 'proof_of_address', pdf()).expect(200),
          ).data!;
          expect(held.waitingFor).toEqual(['selfie']);
          expect(submissions()).toHaveLength(0);

          nuvion.sessionMode = refuse;
          const before = captured.length;
          const res = await startLiveness(who).expect(409);
          expect(body(res).reason).toEqual({
            code: 'selfie_not_available',
            message: 'The selfie check is not available right now.',
          });
          expect(provider.capabilities.hostedLiveness).toBe(false);
          // Not a row of one person: there is no such column to set.
          const row = await onboarding(who);
          expect(row).not.toHaveProperty('livenessRefusedAt');
          expect(row).toMatchObject({ livenessSessionId: null });
          // Loud: one error line, no person in it.
          const loud = captured
            .slice(before)
            .filter((l) => /OFF FOR EVERYONE/.test(l));
          expect(loud).toHaveLength(1);
          expect(loud[0]).toContain(refuse.refuse);
          expect(loud[0]).not.toContain(who.id);
          expect(loud[0]).not.toContain(who.held.id);
          // R-39: the opening goes on without a selfie, for this person...
          expect(submissions()).toHaveLength(1);
          expect((await view(who)).submitted).toBe(true);
          expect(await liveness(who)).toMatchObject({ enabled: false });
          // ...and for everyone: the other person is not asked either.
          expect(await liveness(other)).toMatchObject({
            enabled: false,
            state: 'not_in_use',
          });
        },
      );

      it('after one such answer Nuvion is not asked again for anyone, until the hour has passed', async () => {
        const first = await opened();
        nuvion.sessionMode = {
          refuse: 'error_auth_permission_denied',
          status: 403,
        };
        await startLiveness(first).expect(409);
        expect(sessionStarts()).toHaveLength(1);
        nuvion.sessionMode = 'ok';
        const second = await opened();
        await send(second, 'identity', png()).expect(200);
        const v = body<IdentityDocumentsView>(
          await send(second, 'proof_of_address', pdf()).expect(200),
        ).data!;
        // Not held for a selfie, and not asked.
        expect(v).toMatchObject({ selfie: 'not_used', submitted: true });
        expect((await startLiveness(second).expect(409)).status).toBe(409);
        expect(sessionStarts()).toHaveLength(1);

        // An hour on, Nuvion is believed again.
        const area = provider.documents;
        const t0 = Date.now();
        area.now = () => t0 + 61 * 60_000;
        try {
          expect(provider.capabilities.hostedLiveness).toBe(true);
          const third = await opened();
          await startLiveness(third).expect(200);
          expect(sessionStarts()).toHaveLength(2);
        } finally {
          area.now = () => Date.now();
        }
      });

      it('a return address Nuvion will not take is that person\u2019s plain 400: the selfie stays on for everyone and stays required of them (D2, X1)', async () => {
        const attacker = await opened();
        const stranger1 = await opened();
        await send(attacker, 'identity', png()).expect(200);
        await send(attacker, 'proof_of_address', pdf()).expect(200);
        nuvion.sessionRefuseIf = (b) =>
          /refuse-me/.test(b.redirect_url ?? '')
            ? { refuse: 'error_validation_error', status: 422 }
            : null;
        settings().livenessRedirectOrigins = [
          'https://wawuafrica.example/return',
        ];
        const res = await startLiveness(attacker, {
          redirectUrl: 'https://wawuafrica.example/return/refuse-me',
        }).expect(400);
        expect(body(res).reason).toEqual({
          code: 'document_request_invalid',
          message:
            'The address to return to must be a secure web address we know.',
        });
        // Nothing was switched off, for anyone.
        expect(provider.capabilities.hostedLiveness).toBe(true);
        expect(await liveness(stranger1)).toMatchObject({
          enabled: true,
          state: 'not_started',
          canStart: true,
        });
        // The refused person did not skip it: the documents wait for it.
        const v = await view(attacker);
        expect(v).toMatchObject({
          submitted: false,
          selfie: 'needed',
          waitingFor: ['selfie'],
        });
        expect(submissions()).toHaveLength(0);
        expect(await liveness(attacker)).toMatchObject({
          enabled: true,
          canStart: true,
        });
        // The next person starts as normal, and so can the refused one with a good address.
        await startLiveness(stranger1, {
          redirectUrl: 'https://wawuafrica.example/return',
        }).expect(200);
        await startLiveness(attacker, {
          redirectUrl: 'https://wawuafrica.example/return/ok',
        }).expect(200);
        expect(submissions()).toHaveLength(0);
      });

      it.each([
        ['identity_refused', 'error_kyc_identity_verification_failed', 422],
        ['an entity not incomplete', 'error_entity_status_not_incomplete', 400],
        ['a suspended account', 'error_account_suspended', 403],
        ['a missing record', 'error_resource_not_found', 404],
        ['bad credentials', 'error_auth_credentials_invalid', 401],
        ['no access to the entity', 'error_entity_user_has_no_access', 403],
        ['a value not supported', 'error_validation_value_not_supported', 422],
        ['a rate limit', 'error_auth_rate_limit_exceeded', 429],
      ])(
        'Nuvion refusing one person\u2019s entity (%s): 503 for that person to wait out, the step stays required of them, and nobody else is touched (D2, X2)',
        async (_name, refuse, status) => {
          const stuck = await opened();
          const other = await opened();
          await send(stuck, 'identity', png()).expect(200);
          await send(stuck, 'proof_of_address', pdf()).expect(200);
          nuvion.sessionRefuseIf = (b) =>
            b.entity_id === stuck.held.id ? { refuse, status } : null;

          const res = await startLiveness(stuck).expect(503);
          expect(body(res).reason).toMatchObject({
            code: 'provider_unreachable',
            message:
              'We could not start the selfie check right now. Try again in a moment.',
          });
          expect(body(res).reason?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
          // Still on, for them and for everyone.
          expect(provider.capabilities.hostedLiveness).toBe(true);
          const row = await onboarding(stuck);
          expect(row).not.toHaveProperty('livenessRefusedAt');
          expect(row?.livenessSessionId).toBeNull();
          // They did not get past it.
          expect(await view(stuck)).toMatchObject({
            submitted: false,
            selfie: 'needed',
            waitingFor: ['selfie'],
          });
          expect(await liveness(stuck)).toMatchObject({
            enabled: true,
            canStart: true,
          });
          expect(submissions()).toHaveLength(0);
          // Asked again, it is asked again (they may retry as often as the hour allows).
          await startLiveness(stuck).expect(503);
          expect(
            sessionStarts().filter(
              (r) =>
                r.body &&
                (r.body as { entity_id: string }).entity_id === stuck.held.id,
            ),
          ).toHaveLength(2);
          // The next person is not affected.
          expect(await liveness(other)).toMatchObject({
            enabled: true,
            state: 'not_started',
          });
          await startLiveness(other).expect(200);
        },
      );

      it('a session start whose answer was lost: no session recorded, 503, and the person may try again', async () => {
        const who = await opened();
        nuvion.sessionMode = 'nothing_then_500';
        const res = await startLiveness(who).expect(503);
        expect(body(res).reason?.code).toBe('provider_unreachable');
        expect(provider.capabilities.hostedLiveness).toBe(true);
        expect(await onboarding(who)).toMatchObject({
          livenessSessionId: null,
        });
        nuvion.sessionMode = 'ok';
        await startLiveness(who).expect(200);
      });

      it('a 500 that carries an endpoint-not-found type is a lost answer, not the API saying it does not exist', async () => {
        const who = await opened();
        nuvion.sessionMode = {
          refuse: 'error_endpoint_not_found',
          status: 500,
        };
        await startLiveness(who).expect(503);
        expect(provider.capabilities.hostedLiveness).toBe(true);
        expect(await liveness(who)).toMatchObject({ enabled: true });
      });
    });

    it('under the seam: the adapter answers not_supported with the selfie off, and works for a session with it on', async () => {
      const area = provider.documents;
      await expect(
        provider.startLivenessSession({ customerId: 'c1' }),
      ).rejects.toMatchObject({ kind: 'not_supported', recordMayExist: false });
      await expect(provider.getLivenessResult('s1')).rejects.toMatchObject({
        kind: 'not_supported',
      });
      expect(standin.seen).toEqual([]);
      settings().hostedLiveness = true;
      const who = await opened();
      const started = await provider.startLivenessSession({
        customerId: who.held.id,
        returnUrl: RETURN,
      });
      expect(started.url).toMatch(/^https:\/\//);
      expect(await provider.getLivenessResult(started.sessionId)).toEqual({
        state: 'pending',
        confidence: null,
      });
      const session = nuvion.sessions.get(started.sessionId)!;
      session.captureStatus = 'completed';
      session.verificationStatus = 'approved';
      expect((await provider.getLivenessResult(started.sessionId)).state).toBe(
        'passed',
      );
      session.verificationStatus = 'not-approved';
      expect((await provider.getLivenessResult(started.sessionId)).state).toBe(
        'failed',
      );
      expect(area).toBeInstanceOf(NuvionDocumentsArea);
      // No selfie match against a BVN photo, ever.
      await expect(
        provider.matchSelfie({ bvn: '1', imageBase64: 'x' }),
      ).rejects.toMatchObject({ kind: 'not_supported' });
    });
  });
  // =========================================================================
  describe('D1: a document Nuvion refused is never sent again unchanged, whatever Nuvion answers a correction with', () => {
    /** The details a person sends again (the real route; the numbers are not re-sent for a document refusal). */
    const correctDetails = (who: Person) =>
      http()
        .post('/api/hub/money/wallet/open')
        .set('Authorization', who.auth)
        .send({
          bvn: digits(11),
          nin: digits(11),
          firstName: 'Ada',
          lastName: 'Documents',
          dateOfBirth: '1991-04-12',
          address: '14 Opebi Road',
          city: 'Ikeja',
          state: 'Lagos',
          postalCode: '100001',
          gender: 'female',
          idType: 'international_passport',
          idNumber: `A${digits(8)}`,
          proofOfAddressType: 'utility_bill',
        });
    /** Nuvion's review refuses one document; its `entities.updated` is handled in the production order (NUV-02, then NUV-03). */
    const refuse = async (
      who: Person,
      kind: 'identity' | 'proof_of_address',
      only: 'opening' | 'both' = 'both',
    ) => {
      const held = nuvion.entities.get(who.held.id)!;
      held.status = 'rejected';
      held.updated = Date.now();
      if (kind === 'identity') held.documentStatus = 'rejected';
      else held.addressProofStatus = 'rejected';
      expect((await openingHandler.handle(delivery(held))).outcome).toBe(
        'done',
      );
      if (only === 'both') await handler.handle(delivery(held));
      return held;
    };
    const states = (v: IdentityDocumentsView) =>
      v.documents.map((d) => d.state);

    it.each([
      ['identity', true, 'incomplete', 'id_document_not_verified'],
      ['identity', true, null, 'id_document_not_verified'],
      ['identity', false, 'incomplete', 'id_document_not_verified'],
      ['identity', false, null, 'id_document_not_verified'],
      ['proof_of_address', true, 'incomplete', 'proof_of_address_not_verified'],
      ['proof_of_address', true, null, 'proof_of_address_not_verified'],
      [
        'proof_of_address',
        false,
        'incomplete',
        'proof_of_address_not_verified',
      ],
      ['proof_of_address', false, null, 'proof_of_address_not_verified'],
    ] as const)(
      'the real sequence for %s: refuse, correct, Nuvion answers the correction (documents back at pending: %s, entity moved to %s), read the view: a new file is asked for and the opening is not sent again',
      async (kind, resetWords, statusTo, reasonCode) => {
        const other = kind === 'identity' ? 'proof_of_address' : 'identity';
        const who = await opened();
        const idFile = png();
        const poaFile = pdf();
        await send(who, 'identity', idFile).expect(200);
        await send(who, 'proof_of_address', poaFile).expect(200);
        expect(submissions()).toHaveLength(1);
        nuvion.onCorrection = { resetDocumentWords: resetWords, statusTo };
        nuvion.submitAcceptsRejected = true;

        // Nuvion refuses it.
        const held = await refuse(who, kind);
        const review = (await wallet(who)).review!;
        expect(review.stage).toBe('rejected');
        expect(review.reasons.map((r) => r.code)).toEqual([reasonCode]);
        expect((await docRow(who, kind))?.reviewRefusedAt).toBeInstanceOf(Date);
        expect((await docRow(who, other))?.reviewRefusedAt).toBeNull();
        const refused = await view(who);
        expect(refused.open).toBe(false);
        expect(refused.documents.find((d) => d.kind === kind)?.state).toBe(
          'needs_new',
        );

        // The person corrects their details (the real route); Nuvion answers
        // the correction as it is set to.
        await correctDetails(who).expect(200);
        const entity = await entityRow(who);
        expect(entity.correctedAt).toBeInstanceOf(Date);
        const word =
          kind === 'identity'
            ? entity.documentStatus
            : entity.addressProofStatus;
        // What the stored word is now: the answer's, so the entity alone
        // would call the file good again.
        expect(word).toBe(resetWords ? 'pending' : 'rejected');
        expect((await wallet(who)).review?.stage).toBe('needs_documents');

        // The first read after the correction: the refused file is not good
        // again, the opening is not sent, and the person is asked for a new one.
        const subsBefore = submissions().length;
        const v = await view(who);
        expect(states(v)).toEqual(
          kind === 'identity'
            ? ['needs_new', 'uploaded']
            : ['uploaded', 'needs_new'],
        );
        expect(v).toMatchObject({
          open: true,
          submitted: false,
          waitingFor: [kind],
        });
        expect(submissions()).toHaveLength(subsBefore);
        // Asking again, and Nuvion telling us again, change nothing.
        await view(who);
        await handler.handle(delivery(held));
        await openingHandler.handle(delivery(held));
        expect(submissions()).toHaveLength(subsBefore);
        expect(uploads()).toHaveLength(2);

        // A new file re-opens it: one more upload, one more submission.
        const res = body<IdentityDocumentsView>(
          await send(who, kind, kind === 'identity' ? png() : pdf()).expect(
            200,
          ),
        ).data!;
        expect(uploads()).toHaveLength(3);
        expect(res.submitted).toBe(true);
        expect(states(res)).toEqual(['uploaded', 'uploaded']);
        expect(submissions()).toHaveLength(subsBefore + 1);
        expect((await docRow(who, kind))?.reviewRefusedAt).toBeNull();
        expect((await wallet(who)).review?.stage).toBe('checking');
        // And the word Nuvion may still carry for the old file does not
        // refuse the new one (it was sent after the decision).
        await handler.handle(delivery(held));
        await openingHandler.handle(delivery(held));
        expect((await docRow(who, kind))?.reviewRefusedAt).toBeNull();
        expect(submissions()).toHaveLength(subsBefore + 1);
        // The unchanged document stood the whole time.
        void idFile;
        void poaFile;
      },
    );

    it('a second refusal, of the replacement, is a new refusal: the new file reads needs_new, nothing is sent with it, and a third file re-opens it', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      nuvion.onCorrection = {
        resetDocumentWords: true,
        statusTo: 'incomplete',
      };

      // First round: refused, corrected, replaced and sent again.
      await refuse(who, 'identity');
      await correctDetails(who).expect(200);
      await send(who, 'identity', png()).expect(200);
      expect(submissions()).toHaveLength(2);
      const replaced = await docRow(who, 'identity');
      expect(replaced?.reviewRefusedAt).toBeNull();
      expect((await wallet(who)).review?.stage).toBe('checking');

      // Second round: Nuvion refuses the replacement too.
      await refuse(who, 'identity');
      expect((await wallet(who)).review?.stage).toBe('rejected');
      const second = await docRow(who, 'identity');
      expect(second?.reviewRefusedAt).toBeInstanceOf(Date);
      expect(second?.reviewRefusedAt!.getTime()).toBeGreaterThan(
        replaced!.uploadedAt!.getTime() - 1,
      );
      await correctDetails(who).expect(200);
      const v = await view(who);
      expect(states(v)).toEqual(['needs_new', 'uploaded']);
      expect(v).toMatchObject({ open: true, waitingFor: ['identity'] });
      expect(submissions()).toHaveLength(2);

      // A third file re-opens it, once.
      await send(who, 'identity', png()).expect(200);
      expect(submissions()).toHaveLength(3);
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeNull();
    });

    it('the delivery that records the refusal puts it on the document row at once (NUV-02\u2019s handler, before anything reads the view)', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeNull();
      await refuse(who, 'identity', 'opening');
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeInstanceOf(
        Date,
      );
      expect(
        (await docRow(who, 'proof_of_address'))?.reviewRefusedAt,
      ).toBeNull();
    });

    it('the correction itself puts a refusal it finds on the row before the answer overwrites the word', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      await makeOld(who, 60_000);
      // The entity row reads refused with nothing yet on the document row
      // (a record written by an older reader).
      const held = nuvion.entities.get(who.held.id)!;
      held.status = 'rejected';
      held.documentStatus = 'rejected';
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: {
          status: 'rejected',
          decidedAt: new Date(Date.now() - 20_000),
          documentStatus: 'rejected',
        },
      });
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: who.id },
        data: { state: 'review' },
      });
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeNull();
      nuvion.onCorrection = {
        resetDocumentWords: true,
        statusTo: 'incomplete',
      };
      await correctDetails(who).expect(200);
      expect((await entityRow(who)).documentStatus).toBe('pending');
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeInstanceOf(
        Date,
      );
      expect(states(await view(who))).toEqual(['needs_new', 'uploaded']);
      expect(submissions()).toHaveLength(1);
    });

    it('reading the documents puts a refusal it finds on the row, in every stage', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      await makeOld(who, 60_000);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: {
          status: 'rejected',
          decidedAt: new Date(Date.now() - 20_000),
          documentStatus: 'rejected',
        },
      });
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeNull();
      // The stage is `rejected` (not taking documents): the read still notes it.
      expect(states(await view(who))).toEqual(['needs_new', 'uploaded']);
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeInstanceOf(
        Date,
      );
    });

    it('a file sent after the decision is not about the old refusal, and a refusal of the numbers marks no document', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      const held = nuvion.entities.get(who.held.id)!;
      held.status = 'rejected';
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: { bvnStatus: 'rejected' },
      });
      await openingHandler.handle(delivery(held));
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeNull();
      expect(
        (await docRow(who, 'proof_of_address'))?.reviewRefusedAt,
      ).toBeNull();
      // An old decision with a refused word, and an upload made after it.
      const decided = new Date(Date.now() - 60_000);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: { decidedAt: decided, documentStatus: 'rejected' },
      });
      await prisma.nuvionDocument.update({
        where: { wawuUserId_kind: { wawuUserId: who.id, kind: 'identity' } },
        data: { uploadedAt: new Date() },
      });
      await handler.handle(delivery(held));
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeNull();
    });
  });

  // =========================================================================
  describe('after a refusal: corrected details start the review again from the documents', () => {
    it('a refusal about the numbers: the documents stand, and once the details are corrected the opening is sent again, once', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);

      // Nuvion rejects (the BVN), the delivery records it, the person corrects.
      await makeOld(who, 60_000);
      const held = nuvion.entities.get(who.held.id)!;
      held.status = 'rejected';
      const decided = new Date(Date.now() - 20_000);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: { status: 'rejected', decidedAt: decided, bvnStatus: 'rejected' },
      });
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: who.id },
        data: { state: 'review' },
      });
      expect((await wallet(who)).review?.stage).toBe('rejected');
      const refused = await send(who, 'identity', png()).expect(409);
      expect(body(refused).reason?.code).toBe('documents_closed');

      // Corrected (PATCH sent by the opening, NUV-02) and Nuvion moves it back to incomplete.
      held.status = 'incomplete';
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: {
          status: 'incomplete',
          correctedAt: new Date(decided.getTime() + 10_000),
        },
      });
      expect((await wallet(who)).review?.stage).toBe('needs_documents');
      const reading = await view(who);
      // Both documents still stand: reading the view sends the opening again.
      expect(reading.submitted).toBe(true);
      expect(submissions()).toHaveLength(2);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(2);
      expect((await view(who)).submitted).toBe(true);
      expect(submissions()).toHaveLength(2);
      expect((await wallet(who)).review?.stage).toBe('checking');
    });

    it('a refusal about a document: it reads "needs_new", the other stands, and replacing it sends the opening again once', async () => {
      const who = await opened();
      const idFile = png();
      await send(who, 'identity', idFile).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      await makeOld(who, 60_000);
      const held = nuvion.entities.get(who.held.id)!;
      held.status = 'rejected';
      const decided = new Date(Date.now() - 20_000);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: {
          status: 'rejected',
          decidedAt: decided,
          documentStatus: 'rejected',
        },
      });
      held.status = 'incomplete';
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: {
          status: 'incomplete',
          correctedAt: new Date(decided.getTime() + 10_000),
        },
      });
      const v = await view(who);
      expect(v.documents.map((d) => d.state)).toEqual([
        'needs_new',
        'uploaded',
      ]);
      expect(v).toMatchObject({
        open: true,
        submitted: false,
        waitingFor: ['identity'],
      });
      expect(submissions()).toHaveLength(1);

      const res = body<IdentityDocumentsView>(
        await send(who, 'identity', idFile).expect(200),
      ).data!;
      // Even the same bytes: Nuvion refused that document, so it is sent again.
      expect(uploads()).toHaveLength(3);
      expect(res.submitted).toBe(true);
      expect(res.documents.map((d) => d.state)).toEqual([
        'uploaded',
        'uploaded',
      ]);
      expect(submissions()).toHaveLength(2);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(2);
    });
  });

  // =========================================================================
  describe('a submission recorded late never overwrites a decision recorded first', () => {
    it('markSubmitted after the entity was approved (or refused) by a delivery leaves the word, the decision time and the opening as they are (V11)', async () => {
      for (const decision of ['approved', 'rejected']) {
        const who = await opened();
        await send(who, 'identity', png()).expect(200);
        await send(who, 'proof_of_address', pdf()).expect(200);
        // A delivery recorded the decision before this flow heard its answer.
        const decidedAt = new Date(Date.now() - 5_000);
        await prisma.nuvionEntity.update({
          where: { wawuUserId: who.id },
          data: { status: decision, decidedAt },
        });
        await prisma.fintavaWalletOpening.update({
          where: { wawuUserId: who.id },
          data: { state: decision === 'approved' ? 'open' : 'review' },
        });
        await prisma.nuvionOnboarding.update({
          where: { wawuUserId: who.id },
          data: { submittedAt: null },
        });
        await new DocumentsFlow(prisma, provider).markSubmitted(
          who.id,
          'pending',
        );
        expect(await entityRow(who)).toMatchObject({
          status: decision,
          decidedAt,
        });
        expect(await openingRow(who)).toMatchObject({
          state: decision === 'approved' ? 'open' : 'review',
        });
        // It did record that Nuvion has the submission.
        expect((await onboarding(who))?.submittedAt).toBeInstanceOf(Date);
      }
    });
  });

  // =========================================================================
  describe('Nuvion’s entities.updated delivery heals what a lost answer left', () => {
    it('a submission whose answer was lost, then the delivery: marked sent, the opening reads checking, and nothing is sent', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      nuvion.submitMode = 'made_then_500';
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect((await entityRow(who)).status).toBe('incomplete');
      expect(submissions()).toHaveLength(1);

      const held = nuvion.entities.get(who.held.id)!;
      expect(held.status).toBe('pending');
      const r = await handler.handle(delivery(held));
      expect(r.outcome).toBe('done');
      expect(submissions()).toHaveLength(1);
      expect(await onboarding(who)).toMatchObject({
        submittedAt: expect.any(Date) as Date,
      });
      expect((await entityRow(who)).status).toBe('pending');
      expect(await openingRow(who)).toMatchObject({ state: 'open' });
      expect((await wallet(who)).review?.stage).toBe('checking');
      // Twice: the same.
      expect((await handler.handle(delivery(held))).outcome).toBe('done');
      expect(submissions()).toHaveLength(1);
    });

    it('an upload whose answer was lost, then a delivery long after: the document is found on Nuvion and recorded, never sent again', async () => {
      const who = await opened();
      nuvion.uploadMode = 'late';
      await send(who, 'identity', png()).expect(503);
      nuvion.uploadMode = 'ok';
      const held = nuvion.entities.get(who.held.id)!;
      // Inside the window the row is left alone.
      await handler.handle(delivery(held));
      expect((await docRow(who, 'identity'))?.state).toBe('unknown');
      await age(who, 'identity', RESEND_AFTER_MS + 500);
      const r = await handler.handle(delivery(held));
      expect(r.outcome).toBe('done');
      expect(await docRow(who, 'identity')).toMatchObject({
        state: 'uploaded',
        nuvionDocumentId: nuvion.docs(who.held.id, 'identity')[0].id,
      });
      expect(uploads()).toHaveLength(1);
      // The person's retry of the same file is the answer it already has.
      // (The file is gone from memory; a different one is a replacement.)
    });

    it('after a correction the delivery sends the opening again when the documents already stand', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      await makeOld(who, 60_000);
      const held = nuvion.entities.get(who.held.id)!;
      const decided = new Date(Date.now() - 20_000);
      held.status = 'incomplete';
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: {
          status: 'incomplete',
          decidedAt: decided,
          correctedAt: new Date(decided.getTime() + 10_000),
        },
      });
      const r = await handler.handle(delivery(held));
      expect(r.outcome).toBe('done');
      expect(submissions()).toHaveLength(2);
      expect(nuvion.entities.get(who.held.id)?.submissions).toBe(2);
    });

    it('an entity that is not an opening of ours is left alone; a server that does not run Nuvion keeps the delivery for one that does', async () => {
      const stray = nuvion.addEntity();
      expect((await handler.handle(delivery(stray))).outcome).toBe('done');
      expect(standin.seen).toEqual([]);
      // Rolled back to Fintava: the delivery waits for the server that runs Nuvion.
      const who = await opened();
      const onFintava = new NuvionDocumentsHandler(prisma, {
        get: () => ({ name: 'fintava' }),
      } as unknown as ModuleRef);
      const r = await onFintava.handle(
        delivery(nuvion.entities.get(who.held.id)!),
      );
      expect(r.outcome).toBe('wait');
      expect(standin.seen).toEqual([]);
    });

    it('Nuvion unreadable: the delivery waits, nothing is changed', async () => {
      const who = await opened();
      standin.failNext('error_system_internal_error');
      const r = await handler.handle(
        delivery(nuvion.entities.get(who.held.id)!),
      );
      expect(r.outcome).toBe('wait');
      expect(submissions()).toHaveLength(0);
    });

    it('a submission Nuvion refuses is left for the person: done, with a note and no sending loop', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      nuvion.submitMode = { refuse: 'error_kyc_documents_incomplete' };
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
      const r = await handler.handle(
        delivery(nuvion.entities.get(who.held.id)!),
      );
      expect(r.outcome).toBe('done');
      // A refused submission is not sent again by a delivery: no loop.
      expect(r.note).toContain('documents: waiting');
      expect(submissions()).toHaveLength(1);
      await prisma.nuvionOnboarding.update({
        where: { wawuUserId: who.id },
        data: { submitRefusedAt: new Date(Date.now() - 61_000) },
      });
      nuvion.submitMode = { refuse: 'error_kyc_documents_incomplete' };
      const again = await handler.handle(
        delivery(nuvion.entities.get(who.held.id)!),
      );
      expect(again.outcome).toBe('done');
      expect(again.note).toContain('document_not_accepted');
      expect(submissions()).toHaveLength(2);
    });
  });

  // =========================================================================
  describe('a wallet whose provider reviews no documents', () => {
    it('the routes exist and say nothing is needed; nothing is sent', async () => {
      const fintavaApp = await bootFintava();
      try {
        const who = stranger();
        const auth = who.auth;
        const get = await request(fintavaApp.getHttpServer())
          .get('/api/hub/money/identity/documents')
          .set('Authorization', auth)
          .expect(200);
        expect(
          (get.body as Envelope<IdentityDocumentsView>).data,
        ).toMatchObject({
          required: false,
          open: false,
          waitingFor: [],
          selfie: 'not_used',
        });
        const post = await request(fintavaApp.getHttpServer())
          .post('/api/hub/money/identity/documents')
          .set('Authorization', auth)
          .field('kind', 'identity')
          .attach('file', png(), { filename: 'a.bin' })
          .expect(409);
        expect((post.body as Envelope<never>).reason).toEqual({
          code: 'documents_closed',
          message: 'Your wallet does not need documents.',
        });
        const live = await request(fintavaApp.getHttpServer())
          .get('/api/hub/money/identity/liveness')
          .set('Authorization', auth)
          .expect(200);
        expect((live.body as Envelope<IdentityLivenessView>).data?.state).toBe(
          'not_in_use',
        );
        await request(fintavaApp.getHttpServer())
          .post('/api/hub/money/identity/liveness')
          .set('Authorization', auth)
          .send({})
          .expect(409);
        expect(standin.seen).toEqual([]);
      } finally {
        await fintavaApp.close();
      }
    });
  });

  // =========================================================================
  describe('NUV-02 G-497 / N17: the document, address and selfie steps are progress, so the expiry sweep leaves an opening being worked on', () => {
    const sweep = () =>
      moduleRef.get(WalletOpeningService, { strict: false }).expireIdleHolds();
    /** As if the person last did anything `days` ago: every time their opening and entity keep. */
    async function idle(who: Person, days = 15): Promise<void> {
      await prisma.$executeRaw`UPDATE "FintavaWalletOpening" SET "attemptStartedAt" = now() - make_interval(days => ${days}) WHERE "wawuUserId" = ${who.id}`;
      await prisma.$executeRaw`UPDATE "NuvionEntity" SET
        "progressAt" = NULL, "submittedAt" = NULL, "correctedAt" = NULL,
        "decidedAt" = CASE WHEN "decidedAt" IS NULL THEN NULL ELSE now() - make_interval(days => ${days}) END
        WHERE "wawuUserId" = ${who.id}`;
    }
    const state = async (who: Person) => (await openingRow(who)).state;

    it('control: an opening idle for 15 days with nothing done is expired by the sweep', async () => {
      const who = await opened();
      await idle(who);
      expect(await sweep()).toBeGreaterThanOrEqual(1);
      expect(await state(who)).toBe('expired');
    });

    it.each(['identity', 'proof_of_address'] as const)(
      'an upload of %s after 15 idle days is progress: the sweep leaves the opening, and 15 days after that one it is idle again',
      async (kind) => {
        const who = await opened();
        await idle(who);
        expect((await entityRow(who)).progressAt).toBeNull();
        await send(who, kind, kind === 'identity' ? png() : pdf()).expect(200);
        const worked = await entityRow(who);
        expect(worked.progressAt).toBeInstanceOf(Date);
        // Progress is written when the upload is accepted for sending and
        // again when Nuvion has the file: the last is not before the
        // document's own time.
        expect(worked.progressAt!.getTime()).toBeGreaterThanOrEqual(
          (await docRow(who, kind))!.uploadedAt!.getTime(),
        );
        await sweep();
        expect(await state(who)).toBe('review');
        expect((await wallet(who)).review?.stage).toBe('needs_documents');
        // The last thing done is what counts: 15 days after it, the hold runs out.
        await prisma.$executeRaw`UPDATE "NuvionEntity" SET "progressAt" = now() - interval '15 days' WHERE "wawuUserId" = ${who.id}`;
        await sweep();
        expect(await state(who)).toBe('expired');
      },
    );

    it('an upload Nuvion refuses is still the person working on it: progress is recorded', async () => {
      const who = await opened();
      await idle(who);
      nuvion.uploadMode = { refuse: 'error_validation_error', status: 422 };
      expect((await send(who, 'identity', png())).status).not.toBe(200);
      expect((await entityRow(who)).progressAt).toBeInstanceOf(Date);
      await sweep();
      expect(await state(who)).toBe('review');
    });

    it('the submit call is progress and a submission: progressAt and submittedAt are set with the word, once', async () => {
      const who = await opened();
      await idle(who);
      await send(who, 'identity', png()).expect(200);
      const before = await entityRow(who);
      expect(before.submittedAt).toBeNull();
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
      const after = await entityRow(who);
      expect(after).toMatchObject({ status: 'pending' });
      expect(after.submittedAt).toBeInstanceOf(Date);
      expect(after.progressAt!.getTime()).toBeGreaterThanOrEqual(
        before.progressAt!.getTime(),
      );
      expect(after.submittedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      // Being checked, it never expires.
      await prisma.$executeRaw`UPDATE "NuvionEntity" SET "progressAt" = now() - interval '40 days' WHERE "wawuUserId" = ${who.id}`;
      await sweep();
      expect(await state(who)).toBe('open');
    });

    it('a submission recorded late never counts as a submission (the decision stands first): the entity keeps its submission time', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      const decidedAt = new Date(Date.now() - 5_000);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: { status: 'rejected', decidedAt, submittedAt: null },
      });
      await prisma.nuvionOnboarding.update({
        where: { wawuUserId: who.id },
        data: { submittedAt: null },
      });
      await new DocumentsFlow(prisma, provider).markSubmitted(
        who.id,
        'pending',
      );
      expect((await entityRow(who)).submittedAt).toBeNull();
    });

    describe('the selfie', () => {
      beforeEach(() => {
        settings().hostedLiveness = true;
        settings().livenessRedirectOrigins = [
          'https://wawuafrica.example/return',
        ];
      });

      it('starting it, and its coming back passed, are each progress', async () => {
        const who = await opened();
        await idle(who);
        await startLiveness(who, {
          redirectUrl: 'https://wawuafrica.example/return',
        }).expect(200);
        const started = (await entityRow(who)).progressAt;
        expect(started).toBeInstanceOf(Date);
        await sweep();
        expect(await state(who)).toBe('review');

        await prisma.$executeRaw`UPDATE "NuvionEntity" SET "progressAt" = now() - interval '15 days' WHERE "wawuUserId" = ${who.id}`;
        const session = [...nuvion.sessions.values()][0];
        session.captureStatus = 'completed';
        session.verificationStatus = 'approved';
        expect(await liveness(who)).toMatchObject({ state: 'passed' });
        const passed = (await entityRow(who)).progressAt!;
        expect(Date.now() - passed.getTime()).toBeLessThan(60_000);
        await sweep();
        expect(await state(who)).toBe('review');
        // Reading a result already passed is not new progress.
        await prisma.$executeRaw`UPDATE "NuvionEntity" SET "progressAt" = now() - interval '15 days' WHERE "wawuUserId" = ${who.id}`;
        await liveness(who);
        expect(
          Date.now() - (await entityRow(who)).progressAt!.getTime(),
        ).toBeGreaterThan(14 * 24 * 3600_000);
      });
    });
  });

  // =========================================================================
  describe('NUV-02 into NUV-03: starting again after an expiry still keeps the refusal of a document on its own row', () => {
    const sweep = () =>
      moduleRef.get(WalletOpeningService, { strict: false }).expireIdleHolds();
    const correctDetails = (who: Person) =>
      http()
        .post('/api/hub/money/wallet/open')
        .set('Authorization', who.auth)
        .send({
          bvn: digits(11),
          nin: digits(11),
          firstName: 'Ada',
          lastName: 'Documents',
          dateOfBirth: '1991-04-12',
          address: '14 Opebi Road',
          city: 'Ikeja',
          state: 'Lagos',
          postalCode: '100001',
          gender: 'female',
          idType: 'international_passport',
          idNumber: `A${digits(8)}`,
          proofOfAddressType: 'utility_bill',
        });

    it('refuse the ID, idle 15 days, expire, start again (the real route, Nuvion answers the correction with the checks back at pending): the refused file is asked for anew and the opening is not sent again', async () => {
      const who = await opened();
      await send(who, 'identity', png()).expect(200);
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
      nuvion.onCorrection = {
        resetDocumentWords: true,
        statusTo: 'incomplete',
      };
      nuvion.submitAcceptsRejected = true;

      const held = nuvion.entities.get(who.held.id)!;
      held.status = 'rejected';
      held.documentStatus = 'rejected';
      held.updated = Date.now();
      expect((await openingHandler.handle(delivery(held))).outcome).toBe(
        'done',
      );
      await handler.handle(delivery(held));
      expect((await wallet(who)).review?.stage).toBe('rejected');
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeInstanceOf(
        Date,
      );

      // Nothing from the person for 15 days: the hold runs out.
      await prisma.$executeRaw`UPDATE "FintavaWalletOpening" SET "attemptStartedAt" = now() - interval '15 days' WHERE "wawuUserId" = ${who.id}`;
      await prisma.$executeRaw`UPDATE "NuvionEntity" SET "progressAt" = now() - interval '15 days', "submittedAt" = now() - interval '15 days', "decidedAt" = now() - interval '15 days' WHERE "wawuUserId" = ${who.id}`;
      expect(await sweep()).toBeGreaterThanOrEqual(1);
      expect((await wallet(who)).review?.stage).toBe('expired');

      // Starting again corrects the same entity; the answer puts the
      // document check back at pending, and the refused file is still the
      // one that was refused.
      await correctDetails(who).expect(200);
      const entity = await entityRow(who);
      expect(entity.correctedAt).toBeInstanceOf(Date);
      expect(entity.documentStatus).toBe('pending');
      expect((await docRow(who, 'identity'))?.reviewRefusedAt).toBeInstanceOf(
        Date,
      );
      expect((await wallet(who)).review?.stage).toBe('needs_documents');
      const subsBefore = submissions().length;
      const v = await view(who);
      expect(v.documents.map((d) => d.state)).toEqual([
        'needs_new',
        'uploaded',
      ]);
      expect(v).toMatchObject({
        open: true,
        submitted: false,
        waitingFor: ['identity'],
      });
      expect(submissions()).toHaveLength(subsBefore);
      // Starting again was progress: the opening is not idle.
      await sweep();
      expect((await openingRow(who)).state).toBe('review');

      // A new file re-opens it: one more submission.
      const res = body<IdentityDocumentsView>(
        await send(who, 'identity', png()).expect(200),
      ).data!;
      expect(res.submitted).toBe(true);
      expect(submissions()).toHaveLength(subsBefore + 1);
    });
  });

  // =========================================================================
  describe('WAWU keeps no document content', () => {
    it('after every upload in this file, no table, log, answer or file on disk holds a document or any part of one', async () => {
      // One more person, with both documents carrying known markers.
      const who = await opened();
      const front = png();
      const back = png(500);
      const proof = pdf();
      await send(who, 'identity', front, back).expect(200);
      await send(who, 'proof_of_address', proof).expect(200);

      const needles: string[] = [];
      for (const m of markers) {
        needles.push(m);
        // The marker as it reads inside the base64 of a file, at each of the
        // three alignments it can start at.
        for (let pad = 0; pad < 3; pad += 1) {
          const b64 = Buffer.concat([Buffer.alloc(pad, 0x41), Buffer.from(m)])
            .toString('base64')
            .slice(Math.ceil((pad * 4) / 3) + 1, -4);
          needles.push(b64.slice(0, 24));
        }
        needles.push(Buffer.from(m).toString('hex').slice(0, 30));
      }
      for (const file of [front, back, proof]) {
        const b64 = file.toString('base64');
        needles.push(
          b64.slice(0, 40),
          b64.slice(b64.length >> 1, (b64.length >> 1) + 40),
        );
        needles.push(file.toString('hex').slice(0, 40));
      }
      const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      const patterns = needles.map((n) => `%${n}%`);
      const hits: string[] = [];
      for (const { table_name } of tables) {
        const [r] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "${table_name}" t WHERE row_to_json(t)::text LIKE ANY($1::text[])`,
          patterns,
        );
        if (Number(r.n) > 0) hits.push(table_name);
      }
      expect(hits).toEqual([]);

      // The two rows say what they should and nothing else.
      const row = await docRow(who, 'identity');
      expect(Object.keys(row ?? {}).sort()).toEqual(
        [
          'attemptStartedAt',
          'attempts',
          'createdAt',
          'entityId',
          'failure',
          'fingerprint',
          'kind',
          'knownDocumentIds',
          'nuvionDocumentId',
          'reviewRefusedAt',
          'sides',
          'state',
          'updatedAt',
          'uploadedAt',
          'wawuUserId',
        ].sort(),
      );
      // The opening was sent: no fingerprint is kept of either file.
      expect(row?.fingerprint).toBeNull();
      expect((await docRow(who, 'proof_of_address'))?.fingerprint).toBeNull();

      // The storage table, the temporary folder, the logs and every answer.
      expect(
        await prisma.storageObject.count({
          where: { wawuUserId: { in: users } },
        }),
      ).toBe(0);
      expect(readdirSync(tmpdir()).sort()).toEqual(tmpBefore);
      const logs = captured.join('\n');
      const replies = answered.join('\n');
      for (const n of needles) {
        expect(logs.includes(n)).toBe(false);
        expect(replies.includes(n)).toBe(false);
      }
      for (const file of [front, back, proof]) {
        expect(logs.includes(file.toString('base64'))).toBe(false);
      }
      expect(logs).not.toMatch(/Bearer\s+nv_/);
      expect(logs.includes(ENV.NUVION_API_KEY!)).toBe(false);
      expect(guard.violations).toEqual([]);
    });

    it('the fingerprint is an HMAC under IDENTITY_HASH_KEY, the same for the same file, no bare hash of the bytes, and cleared once the opening is submitted', async () => {
      const who = await opened();
      const front = png();
      const back = png(500);
      await send(who, 'identity', front, back).expect(200);
      const keyed = (f: Buffer, b: Buffer | null) =>
        createHmac('sha256', ENV.IDENTITY_HASH_KEY!)
          .update('document:')
          .update(`front:${f.length}:`)
          .update(f)
          .update(b === null ? 'back:none' : `back:${b.length}:`)
          .update(b ?? Buffer.alloc(0))
          .digest('hex');
      const stored = (await docRow(who, 'identity'))?.fingerprint;
      expect(stored).toBe(keyed(front, back));
      // Not the bare SHA-256 of anything a reader of the table could test a
      // file against: neither of the bytes, nor of the old labelled form.
      const bare = [
        createHash('sha256').update(front).digest('hex'),
        createHash('sha256').update(front).update(back).digest('hex'),
        createHash('sha256')
          .update('front:')
          .update(front)
          .update('\0back:')
          .update(back)
          .digest('hex'),
      ];
      expect(bare).not.toContain(stored);
      // The same file twice (the first not yet sent for review): the same
      // answer, one document.
      await send(who, 'identity', front, back).expect(200);
      expect(uploads()).toHaveLength(1);
      // Sent for review: the fingerprints go, both of them.
      await send(who, 'proof_of_address', pdf()).expect(200);
      expect(submissions()).toHaveLength(1);
      expect(
        (
          await prisma.nuvionDocument.findMany({
            where: { wawuUserId: who.id },
          })
        ).map((r) => r.fingerprint),
      ).toEqual([null, null]);
    });

    it('with IDENTITY_HASH_KEY unset no upload is taken: 503, nothing sent, nothing kept', async () => {
      const who = await opened();
      const hasher = moduleRef.get(IdentityHasher, { strict: false });
      Object.defineProperty(hasher, 'configured', {
        get: () => false,
        configurable: true,
      });
      try {
        const res = await send(who, 'identity', png()).expect(503);
        expect(body(res).reason?.code).toBe('provider_unreachable');
        expect(uploads()).toHaveLength(0);
        expect(await docRow(who, 'identity')).toBeNull();
      } finally {
        delete (hasher as unknown as Record<string, unknown>).configured;
      }
    });

    it('nothing left this machine', () => {
      expect(guard.violations).toEqual([]);
    });
  });
});

/** A second PNG-framed file (the back of an ID), distinct from the front. */
function jpegAsPng(): Buffer {
  return png(300);
}
