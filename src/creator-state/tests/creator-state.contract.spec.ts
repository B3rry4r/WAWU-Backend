import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { CreatorStateModule } from '../creator-state.module';

/**
 * Contract tests for the CreatorState resource (.pipeline/registry.json):
 *   GET   /api/hub/creator/state
 *   PATCH /api/hub/creator/dm-settings
 *
 * Auth: real RS256 JWTs, signed here with a throwaway keypair and verified
 * with a real `jwt.verify()` signature check (genuine crypto, not a blind
 * trust of req.user). What's substituted is only the *transport* — WawuAuthGuard
 * is overridden with an equivalent guard that verifies against this test's
 * known public key directly rather than fetching it over HTTP from a JWKS
 * endpoint via jwks-rsa. This is a deliberate, documented workaround: jwks-rsa's
 * `jose` dependency is pure ESM and this sandbox's Node 22.14 cannot
 * synchronously require it under Jest/ts-jest (no --experimental-vm-modules
 * sync support until Node 24.9+), so the real WawuJwtStrategy/jwks-rsa code
 * path cannot execute inside this test runner at all — not specific to this
 * resource, a sandbox-wide constraint. The claims shape, signature
 * verification, and 401-on-missing/invalid-token behavior are otherwise
 * identical to production. Production code (WawuAuthGuard, WawuJwtStrategy)
 * is untouched.
 */

/**
 * Fixtures this spec owns outright.
 *
 * These assertions used to run against the three SHARED seeded accounts, and
 * that made them order-dependent: content-piece's upload tests claim an
 * upload slot on the seeded Basic creator (`slotsUsed += 1`) and
 * another spec's flow can promote the seeded plain user to a
 * creator account. Whether `slotsUsed: 1` held therefore depended on which
 * suite jest happened to run first — the exact failure mode that makes a red
 * suite unreadable.
 *
 * This spec now creates its own rows under fresh UUIDs that neither seed.ts
 * nor any other spec touches, and deletes them in afterAll. It signs its own
 * tokens (see TestWawuAuthGuard below), so unlike community.contract.spec.ts
 * it does not need to register throwaway identities with mock-wawu-id at all
 * — a fresh `sub` is enough. Same principle, one less moving part.
 */
const OWN_PLAIN = 'c5000000-0000-4000-8000-000000000001'; // no CreatorState row
const OWN_CREATOR_BASIC = 'c5000000-0000-4000-8000-000000000002'; // basic, paid, KYC submitted + pending
const OWN_CREATOR_PRO = 'c5000000-0000-4000-8000-000000000003'; // pro, paid, kyc approved
// Basic + paid, but has never opened a KYC submission: the stored `pending`
// must surface as `not_started` (see CreatorStateService.toResponse).
const OWN_CREATOR_NO_KYC = 'c5000000-0000-4000-8000-000000000004';
// A creator account that has NOT subscribed yet: accountType creator, no
// CreatorState row. Every creator is in this state between signing up and
// paying, and it used to 403.
const OWN_CREATOR_NO_STATE = 'c5000000-0000-4000-8000-000000000005';
const OWNED_SUBS = [
  OWN_PLAIN,
  OWN_CREATOR_BASIC,
  OWN_CREATOR_PRO,
  OWN_CREATOR_NO_KYC,
  OWN_CREATOR_NO_STATE,
];

describe('CreatorState (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let privateKey: string;
  let publicKey: string;

  function signToken(sub: string): string {
    return jwt.sign(
      {
        sub,
        email: `${sub}@test.wawu.dev`,
        phone: '+2348000000000',
        firstName: 'Test',
        lastName: 'User',
        country: 'Nigeria',
        verificationTier: 'basic',
        trustScore: 40,
        status: 'active',
      },
      privateKey,
      { algorithm: 'RS256', expiresIn: '15m' },
    );
  }

  class TestWawuAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const header: string | undefined = req.headers['authorization'];
      if (!header?.startsWith('Bearer ')) {
        throw new UnauthorizedException();
      }
      try {
        req.user = jwt.verify(header.slice('Bearer '.length), publicKey, { algorithms: ['RS256'] });
        return true;
      } catch {
        throw new UnauthorizedException();
      }
    }
  }

  beforeAll(async () => {
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, CreatorStateModule],
    })
      .overrideGuard(WawuAuthGuard)
      .useClass(TestWawuAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    // Build this spec's own rows. Mirrors the seeded shapes the assertions
    // below expect, but under UUIDs nothing else can move.
    await prisma.userProfile.upsert({
      where: { wawuUserId: OWN_PLAIN },
      update: { accountType: 'user' },
      create: {
        wawuUserId: OWN_PLAIN,
        accountType: 'user',
        bio: 'Fixture for creator-state.contract.spec.ts.',
        interests: [],
      },
    });
    await prisma.userProfile.upsert({
      where: { wawuUserId: OWN_CREATOR_NO_STATE },
      update: { accountType: 'creator' },
      create: {
        wawuUserId: OWN_CREATOR_NO_STATE,
        accountType: 'creator',
        bio: 'Creator with no CreatorState row yet.',
        interests: [],
      },
    });
    for (const [sub, state] of [
      [
        OWN_CREATOR_BASIC,
        {
          kycStatus: 'pending',
          slotsUsed: 1,
          dmPrice: 100,
          dmEnabled: true,
        },
      ],
      [
        OWN_CREATOR_PRO,
        {
          kycStatus: 'approved',
          slotsUsed: 2,
          dmPrice: 300,
          dmEnabled: true,
        },
      ],
      [
        OWN_CREATOR_NO_KYC,
        {
          kycStatus: 'pending',
          slotsUsed: 0,
          dmPrice: 100,
          dmEnabled: false,
        },
      ],
    ] as const) {
      await prisma.userProfile.upsert({
        where: { wawuUserId: sub },
        update: { accountType: 'creator' },
        create: {
          wawuUserId: sub,
          accountType: 'creator',
          bio: 'Fixture for creator-state.contract.spec.ts.',
          interests: [],
        },
      });
      await prisma.creatorState.upsert({
        where: { wawuUserId: sub },
        update: state as never,
        create: { wawuUserId: sub, ...state } as never,
      });
    }

    // `kycStatus: 'pending'` is reported as 'not_started' unless a
    // KycSubmission actually exists, so the "pending" fixture needs one.
    // OWN_CREATOR_NO_KYC deliberately gets none.
    await prisma.kycSubmission.deleteMany({
      where: { wawuUserId: { in: [...OWNED_SUBS] } },
    });
    await prisma.kycSubmission.create({
      data: {
        wawuUserId: OWN_CREATOR_BASIC,
        country: 'NG',
        bvn: '12345678901',
        nin: '12345678901',
        idDocumentType: 'national_id',
        idDocumentUrl: 'https://storage.test/id.pdf',
        payoutBankName: 'Test Bank',
        payoutAccountNumber: '0123456789',
        status: 'pending',
      },
    });
  });

  afterAll(async () => {
    // Undo everything this spec created, so the shared wawu_hub_test database
    // is byte-for-byte what it was before the run.
    await prisma.kycSubmission.deleteMany({
      where: { wawuUserId: { in: [...OWNED_SUBS] } },
    });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: [...OWNED_SUBS] } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: [...OWNED_SUBS] } },
    });
    await app.close();
  });

  describe('GET /creator/state', () => {
    it('200s with the shape + the derived flat slotsTotal for a creator', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator/state')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_BASIC)}`)
        .expect(200);

      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: {
          wawuUserId: OWN_CREATOR_BASIC,
          kycStatus: 'pending',
          slotsUsed: 1,
          slotsTotal: 5,
          dmPrice: 100,
          dmEnabled: true,
        },
      });
    });

    it('200s with the SAME allowance for every other creator — there is no ladder left', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator/state')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_PRO)}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        wawuUserId: OWN_CREATOR_PRO,
        slotsTotal: 5,
      });
    });

    // A stored `pending` means two different things — "never started" and
    // "submitted, awaiting review" — and the difference is derived from
    // whether a KycSubmission exists. Both branches are pinned so the
    // derivation cannot quietly regress.
    it("reports a stored 'pending' as 'not_started' when no KYC was ever submitted", async () => {
      const res = await request(app.getHttpServer())
        .get('/creator/state')
        .set(
          'Authorization',
          `Bearer ${signToken(OWN_CREATOR_NO_KYC)}`,
        )
        .expect(200);

      expect(res.body.data).toMatchObject({
        wawuUserId: OWN_CREATOR_NO_KYC,
        kycStatus: 'not_started',
      });
    });

    it('401s with no Authorization header', async () => {
      const res = await request(app.getHttpServer()).get('/creator/state').expect(401);
      expect(res.body.data).toBeNull();
    });

    it('answers a CREATOR with no CreatorState row yet, rather than refusing them', async () => {
      // Every creator is in this state between signing up and publishing or
      // configuring anything, and production had eight creator accounts
      // against one CreatorState row. It used to 403, and the app rendered the
      // raw sentence with a Try again button that could never work.
      const res = await request(app.getHttpServer())
        .get('/creator/state')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_NO_STATE)}`)
        .expect(200);
      expect(res.body.data).toMatchObject({
        slotsUsed: 0,
        slotsTotal: 5,
        kycStatus: 'not_started',
      });
    });

    it('403s for a plain-user account (no CreatorState row — not the creator role)', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator/state')
        .set('Authorization', `Bearer ${signToken(OWN_PLAIN)}`)
        .expect(403);
      expect(res.body.data).toBeNull();
    });
  });

  describe('PATCH /creator/dm-settings', () => {
    afterEach(async () => {
      // restore seeded values so tests stay independent of run order
      await prisma.creatorState.update({
        where: { wawuUserId: OWN_CREATOR_BASIC },
        data: { dmEnabled: true, dmPrice: 100 },
      });
    });

    it('200s and persists a valid dmEnabled/dmPrice update', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_BASIC)}`)
        .send({ dmEnabled: false, dmPrice: 250 })
        .expect(200);

      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: { wawuUserId: OWN_CREATOR_BASIC, dmEnabled: false, dmPrice: 250, slotsTotal: 6 },
      });

      const persisted = await prisma.creatorState.findUnique({ where: { wawuUserId: OWN_CREATOR_BASIC } });
      expect(persisted).toMatchObject({ dmEnabled: false, dmPrice: 250 });
    });

    // The ₦500 ceiling this used to assert was removed in d370b05 on the
    // product owner's explicit instruction (docs/01_SPEC.md line 23:
    // "min ₦50, no ceiling"). Asserting the removed rule is replaced by
    // asserting the rule that actually applies now: the ₦50 floor stays as an
    // abuse guard, and above it the creator sets their own rate.
    // PATCH returns the same CreatorState shape as GET, so it has to derive
    // kycStatus the same way. It used to default `hasSubmitted` to true, so
    // the same account read 'not_started' from GET and 'pending' from PATCH.
    it("derives kycStatus the same way GET does (no KYC submitted -> 'not_started')", async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_NO_KYC)}`)
        .send({ dmEnabled: true, dmPrice: 150 })
        .expect(200);

      expect(res.body.data).toMatchObject({
        wawuUserId: OWN_CREATOR_NO_KYC,
        kycStatus: 'not_started',
      });
    });

    it('400s when dmPrice is below the ₦50 floor', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_BASIC)}`)
        .send({ dmEnabled: true, dmPrice: 49 })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('accepts ₦50 exactly (the floor is inclusive)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_BASIC)}`)
        .send({ dmEnabled: true, dmPrice: 50 })
        .expect(200);
      expect(res.body.data).toMatchObject({ dmPrice: 50 });
    });

    it('accepts a dmPrice above the old ₦500 ceiling (cap removed in d370b05)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_BASIC)}`)
        .send({ dmEnabled: true, dmPrice: 5000 })
        .expect(200);
      expect(res.body.data).toMatchObject({ dmPrice: 5000 });

      const persisted = await prisma.creatorState.findUnique({
        where: { wawuUserId: OWN_CREATOR_BASIC },
      });
      expect(persisted?.dmPrice).toBe(5000);
    });

    it('400s when dmPrice exceeds the sanity limit', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(OWN_CREATOR_BASIC)}`)
        .send({ dmEnabled: true, dmPrice: 10_000_001 })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .send({ dmEnabled: true, dmPrice: 150 })
        .expect(401);
      expect(res.body.data).toBeNull();
    });

    it('403s for a plain-user account (no CreatorState row — not the creator role)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(OWN_PLAIN)}`)
        .send({ dmEnabled: true, dmPrice: 150 })
        .expect(403);
      expect(res.body.data).toBeNull();
    });
  });
});
