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

const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // seeded: no CreatorState row
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // seeded: basic, subscriptionPaid, kyc pending
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // seeded: pro, subscriptionPaid, kyc approved

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
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /creator/state', () => {
    it('200s with the shape + tier-derived slotsTotal for a seeded basic creator', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator/state')
        .set('Authorization', `Bearer ${signToken(USER_CREATOR_BASIC)}`)
        .expect(200);

      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: {
          wawuUserId: USER_CREATOR_BASIC,
          tier: 'basic',
          subscriptionPaid: true,
          kycStatus: 'pending',
          slotsUsed: 1,
          slotsTotal: 3,
          dmPrice: 100,
          dmEnabled: true,
        },
      });
    });

    it('200s with slotsTotal=7 for the seeded pro creator', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator/state')
        .set('Authorization', `Bearer ${signToken(USER_CREATOR_PRO)}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        wawuUserId: USER_CREATOR_PRO,
        tier: 'pro',
        slotsTotal: 7,
      });
    });

    it('401s with no Authorization header', async () => {
      const res = await request(app.getHttpServer()).get('/creator/state').expect(401);
      expect(res.body.data).toBeNull();
    });

    it('403s for a seeded plain-user account (no CreatorState row — not the creator role)', async () => {
      const res = await request(app.getHttpServer())
        .get('/creator/state')
        .set('Authorization', `Bearer ${signToken(USER_PLAIN)}`)
        .expect(403);
      expect(res.body.data).toBeNull();
    });
  });

  describe('PATCH /creator/dm-settings', () => {
    afterEach(async () => {
      // restore seeded values so tests stay independent of run order
      await prisma.creatorState.update({
        where: { wawuUserId: USER_CREATOR_BASIC },
        data: { dmEnabled: true, dmPrice: 100 },
      });
    });

    it('200s and persists a valid dmEnabled/dmPrice update', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(USER_CREATOR_BASIC)}`)
        .send({ dmEnabled: false, dmPrice: 250 })
        .expect(200);

      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: { wawuUserId: USER_CREATOR_BASIC, dmEnabled: false, dmPrice: 250, slotsTotal: 3 },
      });

      const persisted = await prisma.creatorState.findUnique({ where: { wawuUserId: USER_CREATOR_BASIC } });
      expect(persisted).toMatchObject({ dmEnabled: false, dmPrice: 250 });
    });

    it('400s when dmPrice is outside the ₦50-500 range', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(USER_CREATOR_BASIC)}`)
        .send({ dmEnabled: true, dmPrice: 1000 })
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

    it('403s for a seeded plain-user account (no CreatorState row — not the creator role)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/creator/dm-settings')
        .set('Authorization', `Bearer ${signToken(USER_PLAIN)}`)
        .send({ dmEnabled: true, dmPrice: 150 })
        .expect(403);
      expect(res.body.data).toBeNull();
    });
  });
});
