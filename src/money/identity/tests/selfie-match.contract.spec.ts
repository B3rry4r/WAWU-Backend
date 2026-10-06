import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  ConsoleLogger,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  BVN_200,
  type CannedAnswer,
  FintavaDouble,
  fintavaError,
  SELFIE_200,
  SELFIE_400,
  SELFIE_MATCHED,
  selfieAnswer,
  type SeenRequest,
} from '../../../../test/fintava/fintava-double';
import {
  SELFIE_MATCH_ANSWERS,
  SELFIE_NO_ANSWERS,
  SELFIE_UNREADABLE_ANSWERS,
} from '../../../../test/fintava/selfie-answers';
import {
  FIXTURES,
  fixture,
  jpegImage,
  pngImage,
  selfiePolyglots,
} from '../../../../test/fixtures/selfie/selfie-images';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FintavaClient } from '../../../fintava/fintava-client';
import { FintavaWalletProvider } from '../../../fintava/fintava-wallet-provider';
import { SELFIE_ANSWER_MAX_BYTES } from '../../../fintava/fintava-selfie-answer';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MoneyModule } from '../../money.module';
import {
  isSelfieImage,
  SELFIE_IMAGE_MAX_CHARS,
} from '../dto/identity-request.dto';
import { IdentityConfigError, IdentityHasher } from '../identity-config';
import type { SelfieMatchView } from '../identity-view.type';
import {
  SELFIE_NOT_MATCHED_MESSAGE,
  SelfieMatchService,
} from '../selfie-match.service';
import { WalletIdentityService } from '../wallet-identity.service';

/**
 * The selfie match to the BVN photo (task KYC-02) over HTTP: the real
 * MoneyModule, a real database, real RS256 tokens checked against the mock
 * WAWU ID's JWKS (WAWU_ID_JWKS_URL), and the real MONEY-06 Fintava client
 * talking over a socket to the local double (test/fintava/fintava-double.ts).
 * The double answers with the failed match the sandbox really sent
 * (`SELFIE_400`) and, for a pass, a made-up explicit `match: true` in
 * Fintava's envelope (`SELFIE_MATCHED`): no sandbox BVN is known to pass
 * (mobile repo `docs/fintava/sandbox/README.md`, question 11). The client
 * reads the answer by allowlist (round 3): every other answer, Fintava's
 * documented `{}` (`SELFIE_200`) and one that echoes the BVN, the photo and
 * the selfie back (`selfieAnswer`) included, carries no verdict and is never
 * a match. The selfies are real images (test/fixtures/selfie), never random
 * bytes between a valid start and end.
 *
 * Each person runs the BVN check (KYC-01) first, through its own route, as
 * the app does. Every log line the app writes during the whole file is
 * captured, and every answer kept: the last tests prove none of them, and no
 * column of any table, carries a selfie, the BVN photo or a full BVN.
 */

const KEY = 'live_test_selfie_0123456789FAKEKEY';
const HASH_KEY = 'k02-test-selfie-hash-key-0123456789abcdef';
const CHECK_TIMEOUT_MS = 300;

const ENV: Record<string, string> = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: KEY,
  FINTAVA_CHECK_TIMEOUT_MS: String(CHECK_TIMEOUT_MS),
  IDENTITY_HASH_KEY: HASH_KEY,
  BVN_CHECKS_PER_DAY: '',
  SELFIE_CHECKS_PER_DAY: '',
};

const ACCOUNT_PHONE = '+2348031234412';
const BVN_PHONE_SAME = '08031234412';

/** Made-up 11-digit numbers, so a leak names its source. */
const BVN = '22290000111';
const OTHER_BVN = '22290000222';
const NIN = '70290000999';

/** Every selfie sent in this file, so the final scans can look for each. */
const images: string[] = [];

/**
 * A real image (base64): a Pillow JPEG with a random id in a comment
 * segment (padded to `bytes` when given), or a PNG of random pixels. Each
 * differs from its first bytes on, so a leak names it.
 */
function selfie(kind: 'png' | 'jpeg' = 'jpeg', bytes?: number): string {
  const image = (kind === 'png' ? pngImage() : jpegImage(bytes)).toString(
    'base64',
  );
  images.push(image);
  return image;
}

/** The BVN record's photo Fintava's BVN check answers with (KYC-01's double). */
const BVN_PHOTO = BVN_200.data.image;
/** The photo the richer selfie answer echoes back. */
const ECHOED_PHOTO_PART = 'QkFTRTY0UEhPVE8QkFTRTY0UEhPVE8';

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
/** Every answer body the app sent, for the same proof. */
const answered: string[] = [];

function mintToken(sub: string, phone: string = ACCOUNT_PHONE): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `selfie-${sub}@test.wawu.dev`,
      phone,
      firstName: 'Selfie',
      lastName: 'Tester',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response): Envelope<T> => {
  answered.push(res.text);
  return res.body as Envelope<T>;
};

describe('Selfie match to the BVN photo (KYC-02) over HTTP', () => {
  const logger = new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fintava: FintavaClient;
  let identity: WalletIdentityService;
  const double = new FintavaDouble();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};

  type Person = { id: string; auth: string };
  function person(): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}` };
  }

  const http = () => request(app.getHttpServer());
  const match = (who: Person | null, payload: unknown) => {
    const req = http().post('/api/hub/money/identity/selfie');
    return (who ? req.set('Authorization', who.auth) : req).send(
      payload as object,
    );
  };
  const read = (who: Person | null) => {
    const req = http().get('/api/hub/money/identity/selfie');
    return who ? req.set('Authorization', who.auth) : req;
  };
  const selfieCalls = () =>
    double.seen.filter((s) => s.path === '/compliance/verify/bvn/selfie');
  function answerSelfie(answer: Parameters<FintavaDouble['on']>[2]): void {
    double.on('POST', '/compliance/verify/bvn/selfie', answer);
  }
  /** Echoes what was sent back inside a 2xx, with this verdict. */
  function answerEcho(verdict: Record<string, unknown>): void {
    answerSelfie((req: SeenRequest) => ({
      status: 200,
      body: selfieAnswer(req.body as { bvn: string; image: string }, verdict),
    }));
  }

  /** KYC-01's BVN check, passed, through its own route. */
  async function bvnChecked(who: Person, bvn = BVN): Promise<void> {
    double.on('GET', '/compliance/verify/bvn', {
      status: 200,
      body: { data: { ...BVN_200.data, phone_number1: BVN_PHONE_SAME } },
    });
    await http()
      .post('/api/hub/money/identity/bvn')
      .set('Authorization', who.auth)
      .send({ bvn, nin: NIN })
      .expect(200);
    double.reset();
  }

  const rows = (who: Person) =>
    prisma.selfieMatchAttempt.findMany({
      where: { wawuUserId: who.id },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    capture(process.stdout, 'write');
    capture(process.stderr, 'write');
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
      capture(console, m);

    await double.start();
    ENV.FINTAVA_BASE_URL = double.baseUrl;
    for (const [k, v] of Object.entries(ENV)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
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
    // One server for the whole file (FIX-02). Unlistened, supertest opens a
    // server per request and the first concurrent request to finish closes
    // it under the others, resetting any still queued (read ECONNRESET).
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    fintava = moduleRef.get(FintavaClient);
    identity = moduleRef.get(WalletIdentityService);
  });

  beforeEach(() => double.reset());

  afterAll(async () => {
    if (prisma) {
      const where = { wawuUserId: { in: users } };
      await prisma.selfieMatchAttempt.deleteMany({ where });
      await prisma.walletIdentity.deleteMany({ where });
      await prisma.bvnCheckAttempt.deleteMany({ where });
      await prisma.fintavaWallet.deleteMany({ where });
    }
    if (app) await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const restore of restores.reverse()) restore();
  });

  // -------------------------------------------------------------------------
  describe('a matching selfie passes', () => {
    it('answers when it matched and the matches left; stores matched and when (no score is read)', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      const image = selfie();
      const res = await match(user, { bvn: BVN, image }).expect(200);
      const out = body<SelfieMatchView>(res);
      expect(out.statusCode).toBe(200);
      expect(Object.keys(out.data!).sort()).toEqual([
        'checksLeft',
        'matchedAt',
      ]);
      expect(out.data!.checksLeft).toBe(2);
      expect(Date.parse(out.data!.matchedAt!)).not.toBeNaN();
      expect(res.headers['cache-control']).toBe('no-store');

      // One match, of this BVN and this image, with the key.
      expect(selfieCalls()).toHaveLength(1);
      expect(selfieCalls()[0].body).toEqual({ bvn: BVN, image });
      expect(selfieCalls()[0].headers.authorization).toBe(`Bearer ${KEY}`);

      const [row] = await rows(user);
      expect(row).toMatchObject({ outcome: 'matched', confidence: null });
      expect(row.settledAt).not.toBeNull();
      expect(Object.keys(row).sort()).toEqual([
        'bvnHash',
        'bvnVerifiedAt',
        'confidence',
        'createdAt',
        'id',
        'outcome',
        'settledAt',
        'wawuUserId',
      ]);
      // Tied to the BVN check it was compared against (defect 2).
      const check = await identity.currentBvnCheck(user.id);
      expect(row.bvnVerifiedAt).toEqual(check!.verifiedAt);
      expect(row.bvnHash).toBe(check!.bvnHash);

      expect(res.text).not.toContain(BVN);
      expect(res.text).not.toContain(image.slice(0, 40));

      const view = body<SelfieMatchView>(await read(user).expect(200)).data!;
      expect(view).toEqual(out.data);
    });

    it.each(SELFIE_MATCH_ANSWERS)(
      'only the exact shape passes: %s',
      async (_name, answer) => {
        const user = person();
        await bvnChecked(user);
        answerSelfie(answer);
        await match(user, { bvn: BVN, image: selfie('png') }).expect(200);
        const [row] = await rows(user);
        expect(row).toMatchObject({ outcome: 'matched', confidence: null });
        await expect(
          app.get(SelfieMatchService).selfieMatched(user.id),
        ).resolves.toBe(true);
      },
    );

    it.each(FIXTURES)(
      'a real %s (Pillow) is accepted and sent as it is',
      async (name) => {
        const user = person();
        await bvnChecked(user);
        answerSelfie({ status: 200, body: SELFIE_MATCHED });
        const image = fixture(name).toString('base64');
        images.push(image);
        await match(user, { bvn: BVN, image }).expect(200);
        expect(selfieCalls()).toHaveLength(1);
        expect((selfieCalls()[0].body as { image: string }).image).toBe(image);
      },
    );

    it('a matched selfie is not sent again (409 selfie_already_matched, nothing charged)', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(user, { bvn: BVN, image: selfie() }).expect(200);
      double.reset();
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      const res = await match(user, { bvn: BVN, image: selfie() }).expect(409);
      expect(body<null>(res).reason?.code).toBe('selfie_already_matched');
      expect(selfieCalls()).toHaveLength(0);
      expect(await rows(user)).toHaveLength(1);
    });

    it('a new BVN check needs a new selfie: the earlier match no longer counts', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(user, { bvn: BVN, image: selfie() }).expect(200);
      // A later BVN check that passes (the person changed their BVN).
      await new Promise((r) => setTimeout(r, 5));
      await bvnChecked(user, OTHER_BVN);
      const view = body<SelfieMatchView>(await read(user).expect(200)).data!;
      expect(view).toEqual({ matchedAt: null, checksLeft: 2 });
      // The old BVN is no longer the checked one; the new one can be matched.
      await match(user, { bvn: BVN, image: selfie() }).expect(409);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(user, { bvn: OTHER_BVN, image: selfie() }).expect(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('a selfie matched against one BVN never counts for another (defect 2)', () => {
    it('a BVN check for another BVN that passes between the comparison and the match does not inherit it', async () => {
      const user = person();
      await bvnChecked(user); // BVN A passes.
      const checkA = await identity.currentBvnCheck(user.id);
      // Fintava will say the selfie matches the photo of the BVN it is sent.
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      double.on('GET', '/compliance/verify/bvn', {
        status: 200,
        body: { data: { ...BVN_200.data, phone_number1: BVN_PHONE_SAME } },
      });

      // The race, made deterministic: the match has compared BVN A with the
      // passed check and is about to write its attempt row; at exactly that
      // moment a BVN check for BVN B passes for the same person (B's check
      // needs B's phone on the account: the SIM-swap case).
      const delegate = prisma.selfieMatchAttempt;
      const create = delegate.create.bind(delegate) as (
        a: unknown,
      ) => Promise<unknown>;
      let raced = false;
      const spy = jest.spyOn(delegate, 'create').mockImplementation(((
        args: unknown,
      ) => {
        if (raced) return create(args);
        raced = true;
        return (async () => {
          await http()
            .post('/api/hub/money/identity/bvn')
            .set('Authorization', user.auth)
            .send({ bvn: OTHER_BVN, nin: NIN })
            .expect(200);
          await new Promise((r) => setTimeout(r, 5));
          return create(args);
        })();
      }) as never);
      let res: Response;
      try {
        res = await match(user, { bvn: BVN, image: selfie() });
      } finally {
        spy.mockRestore();
      }
      expect(raced).toBe(true);

      // Fintava was asked about BVN A, and said it matched.
      expect(selfieCalls()).toHaveLength(1);
      expect((selfieCalls()[0].body as { bvn: string }).bvn).toBe(BVN);
      // The person's current check is now BVN B's.
      const checkB = await identity.currentBvnCheck(user.id);
      expect(checkB!.bvnHash).not.toBe(checkA!.bvnHash);
      await expect(identity.checkedBvn(user.id, OTHER_BVN)).resolves.toEqual(
        checkB,
      );

      // The match is recorded against A's check, and does not count for B.
      expect(res.status).toBe(409);
      expect(body<null>(res).reason?.code).toBe('bvn_not_checked');
      const [row] = await rows(user);
      expect(row.outcome).toBe('matched');
      expect(row.bvnVerifiedAt).toEqual(checkA!.verifiedAt);
      expect(row.bvnHash).toBe(checkA!.bvnHash);
      await expect(
        app.get(SelfieMatchService).selfieMatched(user.id),
      ).resolves.toBe(false);
      const view = body<SelfieMatchView>(await read(user).expect(200)).data!;
      expect(view).toEqual({ matchedAt: null, checksLeft: 2 });

      // B's own selfie can still be matched, and then counts.
      double.reset();
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(user, { bvn: OTHER_BVN, image: selfie() }).expect(200);
      await expect(
        app.get(SelfieMatchService).selfieMatched(user.id),
      ).resolves.toBe(true);
    });

    it('a matched row counts only when both its check time and its BVN hash are the current check’s', async () => {
      const user = person();
      await bvnChecked(user);
      const check = (await identity.currentBvnCheck(user.id))!;
      const later = new Date(Date.now() + 1_000);
      const matched = { wawuUserId: user.id, outcome: 'matched' };
      await prisma.selfieMatchAttempt.createMany({
        data: [
          // Written after the check, but tied to no check (a row from before
          // the columns existed): never a match.
          { ...matched, settledAt: later, createdAt: later },
          // The same check time, another BVN's hash.
          {
            ...matched,
            settledAt: later,
            bvnVerifiedAt: check.verifiedAt,
            bvnHash: 'another-bvn-hash',
          },
          // This BVN's hash, an earlier check of it.
          {
            ...matched,
            settledAt: later,
            bvnVerifiedAt: new Date(check.verifiedAt.getTime() - 60_000),
            bvnHash: check.bvnHash,
          },
          // Tied to this check, but not a match.
          {
            wawuUserId: user.id,
            outcome: 'not_matched',
            settledAt: later,
            bvnVerifiedAt: check.verifiedAt,
            bvnHash: check.bvnHash,
          },
        ],
      });
      await expect(
        app.get(SelfieMatchService).selfieMatched(user.id),
      ).resolves.toBe(false);
      expect(
        body<SelfieMatchView>(await read(user).expect(200)).data!.matchedAt,
      ).toBeNull();

      await prisma.selfieMatchAttempt.create({
        data: {
          ...matched,
          settledAt: later,
          bvnVerifiedAt: check.verifiedAt,
          bvnHash: check.bvnHash,
        },
      });
      await expect(
        app.get(SelfieMatchService).selfieMatched(user.id),
      ).resolves.toBe(true);
    });

    it('re-checking the same BVN needs a new selfie: the old match was tied to the old check', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(user, { bvn: BVN, image: selfie() }).expect(200);
      await new Promise((r) => setTimeout(r, 5));
      await bvnChecked(user, BVN);
      await expect(
        app.get(SelfieMatchService).selfieMatched(user.id),
      ).resolves.toBe(false);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(user, { bvn: BVN, image: selfie() }).expect(200);
    });

    it('the BVN-only lookup the selfie uses, and the BVN-and-NIN one account opening uses', async () => {
      const user = person();
      await bvnChecked(user);
      const check = await identity.currentBvnCheck(user.id);
      await expect(identity.checkedBvn(user.id, BVN)).resolves.toEqual(check);
      await expect(identity.checkedBvn(user.id, OTHER_BVN)).resolves.toBeNull();
      await expect(
        identity.matchesCheckedIdentity(user.id, BVN, NIN),
      ).resolves.toBe(true);
      await expect(
        identity.matchesCheckedIdentity(user.id, BVN, '70290000000'),
      ).resolves.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('a selfie of somebody else fails the match: A16', () => {
    it('the sandbox’s own failed match is 422 selfie_not_matched with A16’s words and the matches left', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 400, body: SELFIE_400 });
      const res = await match(user, { bvn: BVN, image: selfie() }).expect(422);
      expect(body<null>(res)).toEqual({
        statusCode: 422,
        message: SELFIE_NOT_MATCHED_MESSAGE,
        data: null,
        reason: {
          code: 'selfie_not_matched',
          message:
            "We couldn't match your face. It must match your BVN photo. Good light, no glasses or cap.",
          checksLeft: 2,
        },
      });
      expect(res.text).not.toMatch(/Request failed|404|Fintava/);
      const [row] = await rows(user);
      expect(row).toMatchObject({ outcome: 'not_matched', confidence: null });
      expect(row.settledAt).not.toBeNull();
      const view = body<SelfieMatchView>(await read(user).expect(200)).data!;
      expect(view).toEqual({ matchedAt: null, checksLeft: 2 });
    });

    it.each(SELFIE_NO_ANSWERS)(
      'an explicit "no" in a 200 is a failed match too: %s',
      async (_name, answer) => {
        const user = person();
        await bvnChecked(user);
        answerSelfie(answer);
        const res = await match(user, { bvn: BVN, image: selfie() }).expect(
          422,
        );
        expect(body<null>(res).reason?.code).toBe('selfie_not_matched');
        const [row] = await rows(user);
        expect(row).toMatchObject({ outcome: 'not_matched', confidence: null });
        await expect(
          app.get(SelfieMatchService).selfieMatched(user.id),
        ).resolves.toBe(false);
      },
    );

    // Verifier rounds 1 and 2 (defect 1, findings 1 and 2), and more: every
    // 2xx outside the exact shape made the route answer 200 in round 1, and
    // 2 dozen still did in round 2. Now each is 503, counted (it was
    // charged), and nothing counts as matched.
    it.each(SELFIE_UNREADABLE_ANSWERS)(
      'no verdict, 503, counted, never a match: %s',
      async (_name, answer: CannedAnswer) => {
        const user = person();
        await bvnChecked(user);
        answerSelfie(answer);
        const res = await match(user, { bvn: BVN, image: selfie() }).expect(
          503,
        );
        const out = body<null>(res);
        expect(out.data).toBeNull();
        expect(out.reason?.code).toBe('provider_unreachable');
        expect(selfieCalls()).toHaveLength(1);
        const [row] = await rows(user);
        expect(row.outcome).toBe('unavailable');
        await expect(
          app.get(SelfieMatchService).selfieMatched(user.id),
        ).resolves.toBe(false);
        const view = body<SelfieMatchView>(await read(user).expect(200)).data!;
        expect(view).toEqual({ matchedAt: null, checksLeft: 2 });
      },
    );

    it('an answer echoing the BVN, the photo and the selfie is no verdict, and none of it is stored or answered', async () => {
      const user = person();
      await bvnChecked(user);
      answerEcho({ match: true, confidence_value: 97.25 });
      const image = selfie();
      const res = await match(user, { bvn: BVN, image }).expect(503);
      expect(res.text).not.toContain(BVN);
      expect(res.text).not.toContain(image.slice(0, 40));
      expect(res.text).not.toContain(ECHOED_PHOTO_PART);
      const [row] = await rows(user);
      expect(row).toMatchObject({ outcome: 'unavailable', confidence: null });
    });

    it('nothing on the route says or suggests a liveness check', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 400, body: SELFIE_400 });
      const res = await match(user, { bvn: BVN, image: selfie() });
      for (const text of [res.text, ...answered]) {
        expect(text).not.toMatch(/liveness|blink|live person|alive/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('three a day per person (each match is charged, a failed one too)', () => {
    it('three failures answer 2, 1, 0 left; the fourth is 429 selfie_checks_exhausted and Fintava is not asked', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 400, body: SELFIE_400 });
      const left: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await match(user, { bvn: BVN, image: selfie() }).expect(
          422,
        );
        left.push(body<null>(res).reason!.checksLeft!);
      }
      expect(left).toEqual([2, 1, 0]);
      const res = await match(user, { bvn: BVN, image: selfie() }).expect(429);
      const out = body<null>(res);
      expect(out.reason).toEqual({
        code: 'selfie_checks_exhausted',
        message: 'You have used today’s selfie checks. Try again later.',
        retryAfterSeconds: expect.any(Number) as number,
      });
      expect(out.reason!.retryAfterSeconds).toBeGreaterThan(86_000);
      expect(out.reason!.retryAfterSeconds).toBeLessThanOrEqual(86_400);
      expect(selfieCalls()).toHaveLength(3);
      expect(await rows(user)).toHaveLength(3);
      const view = body<SelfieMatchView>(await read(user).expect(200)).data!;
      expect(view).toEqual({ matchedAt: null, checksLeft: 0 });

      // Somebody else is not affected.
      const other = person();
      await bvnChecked(other);
      answerSelfie({ status: 400, body: SELFIE_400 });
      await match(other, { bvn: BVN, image: selfie() }).expect(422);
      expect(selfieCalls()).toHaveLength(1);
    });

    it('the selfie limit and the BVN check limit are counted apart', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 400, body: SELFIE_400 });
      for (let i = 0; i < 3; i += 1) {
        await match(user, { bvn: BVN, image: selfie() }).expect(422);
      }
      expect((await identity.view(user.id)).checksLeft).toBe(2);
    });

    it('matches older than 24 hours no longer count', async () => {
      const user = person();
      await bvnChecked(user);
      await prisma.selfieMatchAttempt.createMany({
        data: [1, 2, 3].map(() => ({
          wawuUserId: user.id,
          outcome: 'not_matched',
          createdAt: new Date(Date.now() - 25 * 60 * 60_000),
        })),
      });
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(user, { bvn: BVN, image: selfie() }).expect(200);
    });

    it('10 matches sent at the same moment: no more than 3 reach Fintava', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 400, body: SELFIE_400, delayMs: 50 });
      const image = selfie();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => match(user, { bvn: BVN, image })),
      );
      const statuses = results.map((r) => r.status);
      for (const r of results) body(r);
      expect(statuses.every((s) => s === 422 || s === 429)).toBe(true);
      expect(statuses.filter((s) => s === 422).length).toBeLessThanOrEqual(3);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(
        7,
      );
      expect(selfieCalls().length).toBeLessThanOrEqual(3);
      expect(selfieCalls().length).toBe(
        statuses.filter((s) => s === 422).length,
      );
      expect((await rows(user)).length).toBeLessThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('refused before anything is charged', () => {
    it('without a passed BVN check, or with a BVN other than the one that passed: 409 bvn_not_checked', async () => {
      const none = person();
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      const one = await match(none, { bvn: BVN, image: selfie() }).expect(409);
      expect(body<null>(one).reason?.code).toBe('bvn_not_checked');

      const checked = person();
      await bvnChecked(checked);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      const two = await match(checked, {
        bvn: OTHER_BVN,
        image: selfie(),
      }).expect(409);
      expect(body<null>(two).reason?.code).toBe('bvn_not_checked');
      expect(two.text).not.toContain(OTHER_BVN);

      expect(selfieCalls()).toHaveLength(0);
      expect(await rows(none)).toHaveLength(0);
      expect(await rows(checked)).toHaveLength(0);
    });

    it('a person whose wallet is open: 409 wallet_already_open', async () => {
      const user = person();
      await bvnChecked(user);
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: user.id,
          customerId: randomUUID(),
          walletId: randomUUID(),
          accountNumber: `18${String(Date.now()).slice(-8)}`,
        },
      });
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      const res = await match(user, { bvn: BVN, image: selfie() }).expect(409);
      expect(body<null>(res).reason?.code).toBe('wallet_already_open');
      expect(selfieCalls()).toHaveLength(0);
    });

    it('a malformed BVN or image is a 400 that does not repeat it, and nothing is sent', async () => {
      const user = person();
      await bvnChecked(user);
      const good = selfie();
      const gif = Buffer.concat([
        Buffer.from('GIF89a'),
        randomBytes(3000),
      ]).toString('base64');
      const tiny = pngImage(8, 8).toString('base64');
      const huge = selfie('jpeg', 76_000);
      expect(huge.length).toBeGreaterThan(SELFIE_IMAGE_MAX_CHARS);
      images.push(gif, tiny);
      for (const payload of [
        { bvn: '2229000011', image: good },
        { bvn: 22290000111, image: good },
        { bvn: BVN },
        { bvn: BVN, image: '' },
        { bvn: BVN, image: `data:image/jpeg;base64,${good}` },
        { bvn: BVN, image: `${good.slice(0, 100)} ${good.slice(100)}` },
        { bvn: BVN, image: gif },
        { bvn: BVN, image: tiny },
        { bvn: BVN, image: huge },
        { bvn: BVN, image: 12345 },
        {},
      ]) {
        const res = await match(user, payload).expect(400);
        body(res);
        expect(res.text).not.toContain(good.slice(0, 40));
        expect(res.text).not.toContain(huge.slice(0, 40));
        expect(res.text).not.toContain('2229000011');
      }
      expect(selfieCalls()).toHaveLength(0);
      expect(await rows(user)).toHaveLength(0);
    });

    it('a body over the server’s JSON limit (100 KB) is refused without echoing it, and nothing is sent', async () => {
      const user = person();
      await bvnChecked(user);
      const tooBig = selfie('jpeg', 110_000);
      const res = await match(user, { bvn: BVN, image: tooBig });
      const out = body<null>(res);
      // The global body parser refuses it before the route runs. Today the
      // global filter answers that as a 500 for every route (src/common is
      // fenced: mobile repo SHARED-CHANGES, KYC-02 row, asks for a 413); the
      // DTO's own cap sits below the parser's, so the app never sends one.
      expect([413, 500]).toContain(res.status);
      expect(out.data).toBeNull();
      expect(res.text).not.toContain(tooBig.slice(0, 40));
      expect(selfieCalls()).toHaveLength(0);
      expect(await rows(user)).toHaveLength(0);
    });

    it('the image check accepts real JPEGs and PNGs of 1 KB up to the cap, and nothing else', () => {
      expect(isSelfieImage(selfie('jpeg'))).toBe(true);
      expect(isSelfieImage(selfie('png'))).toBe(true);
      const atCap = selfie('jpeg', (SELFIE_IMAGE_MAX_CHARS / 4) * 3);
      expect(atCap.length).toBe(SELFIE_IMAGE_MAX_CHARS);
      expect(isSelfieImage(atCap)).toBe(true);
      expect(isSelfieImage(`${atCap}AAAA`)).toBe(false);
      expect(isSelfieImage(pngImage(8, 8).toString('base64'))).toBe(false);
      expect(isSelfieImage(null)).toBe(false);
    });

    it('a file that is not a whole JPEG or PNG (a polyglot, a framed file, a cut one) is a 400 before anything is sent (defect 3)', async () => {
      const polyglots = selfiePolyglots();
      expect(polyglots.length).toBeGreaterThanOrEqual(25);
      for (const [name, bytes] of polyglots) {
        expect({ name, ok: isSelfieImage(bytes.toString('base64')) }).toEqual({
          name,
          ok: false,
        });
      }

      // Through the route: each is a 400 before Fintava is asked or charged.
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      for (const [name, bytes] of polyglots) {
        const image = bytes.toString('base64');
        images.push(image);
        const res = await match(user, { bvn: BVN, image });
        body(res);
        expect({ name, status: res.status }).toEqual({ name, status: 400 });
      }
      expect(selfieCalls()).toHaveLength(0);
      expect(await rows(user)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('Fintava not answering, or refusing the key', () => {
    it('a 5xx or a timeout is 503 provider_unreachable, and still counts (it may have been charged)', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 502, body: '<html>bad gateway</html>' });
      const one = await match(user, { bvn: BVN, image: selfie() }).expect(503);
      expect(body<null>(one).reason).toEqual({
        code: 'provider_unreachable',
        message:
          'We could not check your selfie right now. Try again in a moment.',
        retryAfterSeconds: 30,
      });
      double.reset();
      answerSelfie({
        status: 200,
        body: SELFIE_200,
        delayMs: CHECK_TIMEOUT_MS + 300,
      });
      await match(user, { bvn: BVN, image: selfie() }).expect(503);
      expect((await rows(user)).map((r) => r.outcome)).toEqual([
        'unavailable',
        'unavailable',
      ]);
      const view = body<SelfieMatchView>(await read(user).expect(200)).data!;
      expect(view).toEqual({ matchedAt: null, checksLeft: 1 });
    });

    it('an answer over the cap (5 MB around the accepted match, or a 401 over it) is 503, counted, never a match, and ends at once (verifier round 3, defect 2)', async () => {
      const user = person();
      await bvnChecked(user);
      // The accepted match with 5 MB of JSON whitespace inside: JSON.parse
      // reads it as the match, so only the cap stops it.
      const padded = `{${' '.repeat(5_000_000)}"data":{"match":true},"status":200}`;
      expect(JSON.parse(padded)).toEqual({
        data: { match: true },
        status: 200,
      });
      answerSelfie({ status: 200, body: padded });
      const started = Date.now();
      const res = await match(user, { bvn: BVN, image: selfie() }).expect(503);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(body<null>(res).reason?.code).toBe('provider_unreachable');
      // A refused key over the cap is not read either, so it counts.
      double.reset();
      answerSelfie({
        status: 401,
        body: fintavaError(401, `Invalid API key ${'x'.repeat(5_000)}`),
      });
      await match(user, { bvn: BVN, image: selfie() }).expect(503);
      expect((await rows(user)).map((r) => r.outcome)).toEqual([
        'unavailable',
        'unavailable',
      ]);
      await expect(
        app.get(SelfieMatchService).selfieMatched(user.id),
      ).resolves.toBe(false);
      const view = body<SelfieMatchView>(await read(user).expect(200)).data!;
      expect(view).toEqual({ matchedAt: null, checksLeft: 1 });
    });

    it('a key Fintava refuses is 503 and gives the match back (nothing reached the provider)', async () => {
      const user = person();
      await bvnChecked(user);
      answerSelfie({ status: 401, body: fintavaError(401, 'Invalid API key') });
      await match(user, { bvn: BVN, image: selfie() }).expect(503);
      expect(await rows(user)).toHaveLength(0);
    });

    it('without IDENTITY_HASH_KEY the match answers 503 and nothing is sent or counted', async () => {
      const hasher = new IdentityHasher(
        new ConfigService({ IDENTITY_HASH_KEY: '' }),
      );
      const provider = new FintavaWalletProvider(fintava);
      const bare = new SelfieMatchService(
        prisma,
        provider,
        hasher,
        new WalletIdentityService(prisma, provider, hasher),
      );
      const user = person();
      await expect(
        bare.match(user.id, { bvn: BVN, image: selfie() }),
      ).rejects.toMatchObject({ code: 'provider_unreachable' });
      expect(selfieCalls()).toHaveLength(0);
      expect(await rows(user)).toHaveLength(0);
    });

    it('a wrong SELFIE_CHECKS_PER_DAY stops the app at boot', () => {
      for (const bad of ['0', '51', '2.5', 'three']) {
        expect(
          () =>
            new IdentityHasher(
              new ConfigService({
                IDENTITY_HASH_KEY: HASH_KEY,
                SELFIE_CHECKS_PER_DAY: bad,
              }),
            ),
        ).toThrow(IdentityConfigError);
      }
      expect(
        new IdentityHasher(
          new ConfigService({
            IDENTITY_HASH_KEY: HASH_KEY,
            SELFIE_CHECKS_PER_DAY: '5',
          }),
        ).selfieChecksPerDay,
      ).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  describe('auth, and one person never reaches another’s identity', () => {
    it('both routes need a WAWU ID token; nothing goes to Fintava without one', async () => {
      await match(null, { bvn: BVN, image: selfie() }).expect(401);
      await read(null).expect(401);
      await match(
        { id: 'x', auth: 'Bearer not-a-token' },
        { bvn: BVN, image: selfie() },
      ).expect(401);
      expect(selfieCalls()).toHaveLength(0);
    });

    it('B cannot match against A’s BVN, aim a request at A, or see A’s result', async () => {
      const a = person();
      const b = person();
      await bvnChecked(a);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(a, { bvn: BVN, image: selfie() }).expect(200);
      double.reset();
      answerSelfie({ status: 200, body: SELFIE_MATCHED });

      // B has no BVN check: A's BVN does not let B in.
      const one = await match(b, { bvn: BVN, image: selfie() }).expect(409);
      expect(body<null>(one).reason?.code).toBe('bvn_not_checked');
      // A person cannot be named in the body.
      await match(b, { bvn: BVN, image: selfie(), wawuUserId: a.id }).expect(
        400,
      );
      // B's own BVN check, then A's BVN: still not B's.
      await bvnChecked(b, OTHER_BVN);
      answerSelfie({ status: 200, body: SELFIE_MATCHED });
      await match(b, { bvn: BVN, image: selfie() }).expect(409);
      expect(selfieCalls()).toHaveLength(0);

      // B reads B's own step only.
      expect(body<SelfieMatchView>(await read(b).expect(200)).data).toEqual({
        matchedAt: null,
        checksLeft: 3,
      });
      // A's result is untouched.
      const aView = body<SelfieMatchView>(await read(a).expect(200)).data!;
      expect(aView.matchedAt).not.toBeNull();
      expect(aView.checksLeft).toBe(2);
      expect(await rows(b)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // These run last: everything above has gone through every path.
  describe('no selfie, BVN photo or full BVN is stored or logged', () => {
    it('a refusal that echoes the selfie (as much as fits under the answer cap), the BVN and the photo back is logged masked', async () => {
      const user = person();
      await bvnChecked(user);
      const image = selfie();
      const refusal = fintavaError(
        400,
        `Face mismatch for BVN ${BVN} image ${image.slice(0, 2000)} photo ${ECHOED_PHOTO_PART.repeat(4)}`,
      );
      // Under the answer cap, so it is read (and masked), not dropped.
      expect(JSON.stringify(refusal).length).toBeLessThan(
        SELFIE_ANSWER_MAX_BYTES,
      );
      answerSelfie({ status: 400, body: refusal });
      await match(user, { bvn: BVN, image }).expect(422);
      expect(captured.join('\n')).toMatch(
        /verify BVN selfie: identity_refused/,
      );
    });

    it('a refusal that echoes the whole selfie (over the answer cap) is not read: 503, counted, and only its size is logged', async () => {
      const user = person();
      await bvnChecked(user);
      const image = selfie();
      const before = captured.length;
      answerSelfie({
        status: 400,
        body: fintavaError(
          400,
          `Face mismatch for BVN ${BVN} image ${image} photo ${ECHOED_PHOTO_PART.repeat(4)}`,
        ),
      });
      const res = await match(user, { bvn: BVN, image }).expect(503);
      expect(body<null>(res).reason?.code).toBe('provider_unreachable');
      const [row] = await rows(user);
      expect(row.outcome).toBe('unavailable');
      const logged = captured.slice(before).join('\n');
      expect(logged).toMatch(
        /verify BVN selfie: bad_response HTTP 400 "the answer is over 4096 bytes"/,
      );
      expect(logged).not.toContain('Face mismatch');
    });

    it('no column of any table holds a selfie, the BVN photo or a full BVN', async () => {
      const columns = await prisma.$queryRawUnsafe<
        Array<{ table_name: string; column_name: string }>
      >(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'bytea', 'ARRAY')`,
      );
      expect(columns.length).toBeGreaterThan(20);
      // A 40-character window from the start and the middle of every image
      // sent, the photos, and the BVNs.
      const needles = [
        ...images.flatMap((i) => [
          i.slice(0, 40),
          i.slice(Math.floor(i.length / 2), Math.floor(i.length / 2) + 40),
        ]),
        ECHOED_PHOTO_PART,
        BVN_PHOTO,
        BVN,
        OTHER_BVN,
      ];
      const hits: string[] = [];
      for (const { table_name, column_name } of columns) {
        const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "${table_name}"
           WHERE "${column_name}"::text LIKE ANY ($1::text[])`,
          needles.map((x) => `%${x}%`),
        );
        if (Number(n) > 0) hits.push(`${table_name}.${column_name}`);
      }
      expect(hits).toEqual([]);
    });

    it('no log line and no answer in this file carries a selfie, the photo, a full BVN or the keys', () => {
      // The proof is only worth something if the capture saw the app's logs.
      expect(captured.join('\n')).toMatch(/verify BVN selfie/);
      expect(captured.length).toBeGreaterThan(20);
      const needles = [
        ...images.map((i) => i.slice(0, 40)),
        ...images.map((i) => i.slice(-40)),
        ECHOED_PHOTO_PART,
        BVN,
        OTHER_BVN,
        NIN,
        HASH_KEY,
        KEY,
      ];
      for (const text of [...captured, ...answered]) {
        for (const needle of needles) {
          expect({ needle, leaked: text.includes(needle) }).toEqual({
            needle,
            leaked: false,
          });
        }
      }
    });
  });
});
