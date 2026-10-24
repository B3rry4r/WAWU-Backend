process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { HUB_THROTTLERS } from '../../hub-throttlers';
import { StorageService } from '../../storage/storage.service';
import { UserProfileModule } from '../user-profile.module';

/**
 * SIGNUP-NAMES round 3: `GET /users/handle-available` is signed out, so its own rate limit (60 a minute per
 * address, on top of the app's 20 a second) is what keeps a loop from walking the names. The Hub's real throttlers
 * (HUB_THROTTLERS) sit behind the same global guard the app uses, so the spec counts what the app counts.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHORT = HUB_THROTTLERS.find((t) => t.name === 'short')!;

describe('GET /users/handle-available is limited to 60 a minute per address (SIGNUP-NAMES)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ThrottlerModule.forRoot([...HUB_THROTTLERS]),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    })
      .overrideProvider(StorageService)
      .useValue({ freshUrlFor: (s: string | null) => Promise.resolve(s) })
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
    await app.listen(0);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('the 60 calls of a minute are answered, and the 61st is a 429 with the wait', async () => {
    const ask = (n: number) =>
      http()
        .get('/api/hub/users/handle-available')
        .query({ handle: `thr${Date.now() % 100_000}x${n}` });
    const one = await ask(0);
    expect(one.status).toBe(200);
    expect(one.headers['x-ratelimit-limit-medium']).toBe('60');
    expect(one.headers['x-ratelimit-remaining-medium']).toBe('59');

    // 59 more, in groups under the app's 20 a second.
    const statuses: number[] = [];
    for (let done = 0; done < 59; done += SHORT.limit - 2) {
      const group = Math.min(SHORT.limit - 2, 59 - done);
      const res = await Promise.all(
        Array.from({ length: group }, (_, i) => ask(done + i + 1)),
      );
      statuses.push(...res.map((r) => r.status));
      if (done + group < 59) await sleep(1100);
    }
    expect(statuses).toHaveLength(59);
    expect(statuses.every((s) => s === 200)).toBe(true);

    const over = await ask(99);
    expect(over.status).toBe(429);
    expect(over.headers['retry-after-medium']).toMatch(/^\d+$/);
    expect((over.body as { message?: string }).message).toEqual(
      expect.any(String),
    );
  }, 60_000);
});
