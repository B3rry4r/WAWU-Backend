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
import { NotificationSettingsModule } from '../notification-settings.module';

/**
 * Contract tests for the NotificationSettings resource (.pipeline/registry.json):
 *   GET   /api/hub/settings/notifications
 *   PATCH /api/hub/settings/notifications
 *
 * Both endpoints are roles: ["any"] — any authenticated WAWU user, no
 * creator/admin gate. Auth: real RS256 JWTs signed here with a throwaway
 * keypair and verified with a real `jwt.verify()` signature check.
 * WawuAuthGuard is overridden with an equivalent guard that verifies
 * against this test's known public key directly rather than fetching it
 * over HTTP from a JWKS endpoint via jwks-rsa — the same documented
 * sandbox-wide workaround used by every other resource's contract spec
 * (jwks-rsa's `jose` dependency is pure ESM and cannot sync-require under
 * Jest/ts-jest on this sandbox's Node version). Production code
 * (WawuAuthGuard, WawuJwtStrategy) is untouched.
 */

const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // seeded: has a NotificationSettings row (defaults)
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // seeded: has a NotificationSettings row (defaults)
const USER_WITH_NO_ROW = '00000000-0000-4000-8000-00000000dead'; // not seeded — exercises lazy upsert-create

describe('NotificationSettings (contract)', () => {
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
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, NotificationSettingsModule],
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
    // clean up the lazily-created row so repeated runs stay idempotent
    await prisma.notificationSettings.deleteMany({ where: { userWawuId: USER_WITH_NO_ROW } });
    await app.close();
  });

  describe('GET /settings/notifications', () => {
    it('200s with the seeded default shape for a plain user', async () => {
      const res = await request(app.getHttpServer())
        .get('/settings/notifications')
        .set('Authorization', `Bearer ${signToken(USER_PLAIN)}`)
        .expect(200);

      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: {
          userWawuId: USER_PLAIN,
          newReplies: true,
          newFollowers: true,
          dmReminders: true,
          refunds: true,
          promotions: false,
          communityDigest: true,
        },
      });
    });

    it('200s for a creator account too (no role gate on this resource)', async () => {
      const res = await request(app.getHttpServer())
        .get('/settings/notifications')
        .set('Authorization', `Bearer ${signToken(USER_CREATOR_BASIC)}`)
        .expect(200);

      expect(res.body.data).toMatchObject({ userWawuId: USER_CREATOR_BASIC });
    });

    it('lazily creates a default row for a user with none yet', async () => {
      const res = await request(app.getHttpServer())
        .get('/settings/notifications')
        .set('Authorization', `Bearer ${signToken(USER_WITH_NO_ROW)}`)
        .expect(200);

      // `promotions` defaults to TRUE as of build brief C8, which made this
      // column the opt-out for admin-composed campaigns. It had defaulted to
      // false while nothing read it, and a promotion channel whose default is
      // off reaches nobody. Existing rows were deliberately NOT backfilled
      // (see prisma/migrations/20260921140000_notification_campaigns), so this
      // assertion is specifically about a user with NO row.
      expect(res.body.data).toMatchObject({
        userWawuId: USER_WITH_NO_ROW,
        newReplies: true,
        promotions: true,
      });

      const persisted = await prisma.notificationSettings.findUnique({ where: { userWawuId: USER_WITH_NO_ROW } });
      expect(persisted).not.toBeNull();
    });

    it('401s with no Authorization header', async () => {
      const res = await request(app.getHttpServer()).get('/settings/notifications').expect(401);
      expect(res.body.data).toBeNull();
    });
  });

  describe('PATCH /settings/notifications', () => {
    afterEach(async () => {
      // restore seeded defaults so tests stay independent of run order
      await prisma.notificationSettings.update({
        where: { userWawuId: USER_PLAIN },
        data: {
          newReplies: true,
          newFollowers: true,
          dmReminders: true,
          refunds: true,
          promotions: false,
          communityDigest: true,
        },
      });
    });

    it('200s and persists a partial update, leaving other fields untouched', async () => {
      const res = await request(app.getHttpServer())
        .patch('/settings/notifications')
        .set('Authorization', `Bearer ${signToken(USER_PLAIN)}`)
        .send({ promotions: true, newReplies: false })
        .expect(200);

      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: {
          userWawuId: USER_PLAIN,
          promotions: true,
          newReplies: false,
          newFollowers: true,
          dmReminders: true,
          refunds: true,
          communityDigest: true,
        },
      });

      const persisted = await prisma.notificationSettings.findUnique({ where: { userWawuId: USER_PLAIN } });
      expect(persisted).toMatchObject({ promotions: true, newReplies: false });
    });

    it('200s on an empty body (no-op update)', async () => {
      await request(app.getHttpServer())
        .patch('/settings/notifications')
        .set('Authorization', `Bearer ${signToken(USER_PLAIN)}`)
        .send({})
        .expect(200);
    });

    it('400s when a field carries a non-boolean value', async () => {
      const res = await request(app.getHttpServer())
        .patch('/settings/notifications')
        .set('Authorization', `Bearer ${signToken(USER_PLAIN)}`)
        .send({ promotions: 'yes' })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('400s when the payload carries a field not in the DTO (forbidNonWhitelisted)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/settings/notifications')
        .set('Authorization', `Bearer ${signToken(USER_PLAIN)}`)
        .send({ notARealField: true })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      const res = await request(app.getHttpServer())
        .patch('/settings/notifications')
        .send({ promotions: true })
        .expect(401);
      expect(res.body.data).toBeNull();
    });
  });
});
