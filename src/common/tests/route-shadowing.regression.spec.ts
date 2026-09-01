import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { ResponseInterceptor } from '../interceptors/response.interceptor';

/**
 * Literal routes that share a prefix with somebody else's parameter route.
 *
 * GET /dm/response-stats answered 400 "Validation failed (uuid is expected)"
 * in production for weeks while its own contract test passed. Both are green
 * for the same reason the bug existed: that test boots
 * CreatorNoResponseTrackerModule ALONE, so nothing else is mounted at `dm` and
 * nothing can shadow it. In the real app DirectMessageController is also
 * `@Controller('dm')` and owns `@Get(':messageId')`, which swallows any
 * literal sibling registered after it — and it was being registered early,
 * transitively, through AdminPaymentsModule -> PaymentWebhookModule.
 *
 * This suite boots the FULL AppModule, because composition is the only place
 * this class of defect exists. A per-module test cannot see it by
 * construction.
 */
const MOCK_WAWU_ID_BASE_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('route shadowing (full AppModule)', () => {
  let app: INestApplication;
  let proCreatorToken: string;

  beforeAll(async () => {
    proCreatorToken = await loginAs('creator-pro@test.wawu.dev');
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  it('GET /dm/response-stats resolves to its own controller, not dm/:messageId', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/dm/response-stats')
      .set('Authorization', `Bearer ${proCreatorToken}`);

    // The exact production symptom, asserted against directly: a 400 carrying
    // the UUID message means the parameter route won the match.
    expect(res.body?.message ?? '').not.toMatch(/uuid is expected/i);
    expect(res.status).toBe(200);
    // The tracker's own wire shape, not the client's — the browser builds its
    // `responseStats` object from `noResponseRatePct`.
    expect(res.body.data).toHaveProperty('noResponseRatePct');
    expect(res.body.data).toHaveProperty('penaltyState');
  });

  it('the parameter route it shares a prefix with still works', async () => {
    // Guards against "fixing" the shadowing by breaking dm/:messageId.
    const res = await request(app.getHttpServer())
      .get('/api/hub/dm/not-a-uuid')
      .set('Authorization', `Bearer ${proCreatorToken}`);
    expect(res.status).toBe(400);
    expect(String(res.body?.message ?? '')).toMatch(/uuid is expected/i);
  });
});
