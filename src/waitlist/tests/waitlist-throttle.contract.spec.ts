// The spec reads response headers.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_THROTTLERS } from '../../hub-throttlers';
import { WAITLIST_THROTTLE } from '../waitlist-config';
import {
  bootWaitlist,
  configWith,
  ScriptedFlutterwave,
  OFFER_ID,
  openOffer,
} from './waitlist-harness';

/**
 * JOIN-01: the four public routes are limited per address, and the limit is
 * one a whole event venue on one Wi-Fi address will not hit by registering:
 * 120 calls to each route in 10 minutes (WAITLIST_THROTTLE, listed in
 * hub-rate-limits.contract.spec.ts). The app's own throttlers are used
 * unchanged (HUB_THROTTLERS) behind the same global guard, so the global
 * 20 a second still applies and the spec sends in groups under it.
 */

const MARK = 'join01-throttle-spec';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHORT = HUB_THROTTLERS.find((t) => t.name === 'short')!;

describe('Event registration routes are throttled per address (JOIN-01)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const fake = new ScriptedFlutterwave();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootWaitlist(
      configWith((raw) => (raw.event_offers = [openOffer()])),
      fake,
      [ThrottlerModule.forRoot([...HUB_THROTTLERS])],
      [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    );
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    await app.close();
  });

  /** n calls to `send`, in groups under the per-second limit. */
  async function many(n: number, send: () => request.Test) {
    const statuses: number[] = [];
    for (let done = 0; done < n; done += SHORT.limit - 2) {
      const group = Math.min(SHORT.limit - 2, n - done);
      const res = await Promise.all(
        Array.from({ length: group }, () => send()),
      );
      statuses.push(...res.map((r) => r.status));
      if (done + group < n) await sleep(1100);
    }
    return statuses;
  }

  it('a venue of 120 registers, and the 121st call from that address is 429 on that route only', async () => {
    const limit = WAITLIST_THROTTLE.medium.limit;
    expect([limit, WAITLIST_THROTTLE.medium.ttl]).toEqual([120, 600_000]);
    let n = 0;
    const body = () => {
      n += 1;
      return {
        offerId: OFFER_ID,
        fullName: `Venue Person ${n} ${MARK}`,
        phone: `+23470${String(40_000_000 + n).slice(-8)}`,
        email: `${MARK}-${n}@test.wawu.dev`,
        consent: true,
      };
    };
    const one = await http()
      .post('/api/hub/waitlist/registrations')
      .send(body());
    expect(one.status).toBe(200);
    expect(one.headers['x-ratelimit-limit-medium']).toBe(String(limit));
    expect(one.headers['x-ratelimit-remaining-medium']).toBe(String(limit - 1));
    const rest = await many(limit - 1, () =>
      http().post('/api/hub/waitlist/registrations').send(body()),
    );
    expect(rest.filter((s) => s === 200)).toHaveLength(limit - 1);
    const over = await http()
      .post('/api/hub/waitlist/registrations')
      .send(body());
    expect(over.status).toBe(429);
    expect(over.headers['retry-after-medium']).toMatch(/^\d+$/);
    // The same address can still use the other routes: each is counted apart.
    await http().get('/api/hub/waitlist/offers/current').expect(200);
    await http()
      .get('/api/hub/waitlist/registrations/wawu-join-nope')
      .expect(404);
    await http()
      .post('/api/hub/waitlist/registrations/verify')
      .send({ reference: 'wawu-join-nope', transactionId: '1' })
      .expect(404);
  }, 60_000);

  it('the offer, verify and status routes carry the same limit', async () => {
    // The first test already made one call to each of these three routes.
    const limit = WAITLIST_THROTTLE.medium.limit - 1;
    const offers = await many(limit, () =>
      http().get('/api/hub/waitlist/offers/current'),
    );
    expect(offers.filter((s) => s === 200)).toHaveLength(limit);
    expect((await http().get('/api/hub/waitlist/offers/current')).status).toBe(
      429,
    );
    const statuses = await many(limit, () =>
      http().get('/api/hub/waitlist/registrations/wawu-join-x'),
    );
    expect(statuses.filter((s) => s === 404)).toHaveLength(limit);
    expect(
      (await http().get('/api/hub/waitlist/registrations/wawu-join-x')).status,
    ).toBe(429);
    const verifies = await many(limit, () =>
      http()
        .post('/api/hub/waitlist/registrations/verify')
        .send({ reference: 'wawu-join-x', transactionId: '1' }),
    );
    expect(verifies.filter((s) => s === 404)).toHaveLength(limit);
    expect(
      (
        await http()
          .post('/api/hub/waitlist/registrations/verify')
          .send({ reference: 'wawu-join-x', transactionId: '1' })
      ).status,
    ).toBe(429);
  }, 120_000);
});
