// The spec reads response headers.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_THROTTLERS } from '../../hub-throttlers';
import {
  WAITLIST_THROTTLE_READ,
  WAITLIST_THROTTLE_WRITE,
} from '../waitlist-config';
import {
  bootWaitlist,
  configWith,
  ScriptedFlutterwave,
  OFFER_ID,
  openOffer,
} from './waitlist-harness';

/**
 * JOIN-01 (round 2): the four public routes are limited per address, and the
 * limit is one a whole event venue on one Wi-Fi address, or many phones behind
 * one mobile-network address, will not hit: 600 calls in 10 minutes to each
 * read route (the offer, a registration's status) and 300 to each write route
 * (register, verify). The app's own throttlers are used unchanged
 * (HUB_THROTTLERS) behind the same global guard, so the global 20 a second per
 * route still applies and the spec sends in groups under it. The four routes
 * are counted apart, so the spec fills them side by side.
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

  it('the figures are 600 for the reads and 300 for the writes, in 10 minutes', () => {
    expect(WAITLIST_THROTTLE_READ).toEqual({
      medium: { limit: 600, ttl: 600_000 },
    });
    expect(WAITLIST_THROTTLE_WRITE).toEqual({
      medium: { limit: 300, ttl: 600_000 },
    });
  });

  it('a venue of 300 registers, and the 301st call from that address is 429 on that route only', async () => {
    const limit = WAITLIST_THROTTLE_WRITE.medium.limit;
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
    const offer = await http().get('/api/hub/waitlist/offers/current');
    expect(offer.status).toBe(200);
    expect(offer.headers['x-ratelimit-limit-medium']).toBe(
      String(WAITLIST_THROTTLE_READ.medium.limit),
    );
    await http()
      .get('/api/hub/waitlist/registrations/wawu-join-nope')
      .expect(404);
    await http()
      .post('/api/hub/waitlist/registrations/verify')
      .send({ reference: 'wawu-join-nope', transactionId: '1' })
      .expect(404);
  }, 120_000);

  it('the offer and status routes allow 600 each, and verify 300, side by side', async () => {
    // The first test already made one call to each of these three routes.
    const reads = WAITLIST_THROTTLE_READ.medium.limit - 1;
    const writes = WAITLIST_THROTTLE_WRITE.medium.limit - 1;
    const [offers, statuses, verifies] = await Promise.all([
      many(reads, () => http().get('/api/hub/waitlist/offers/current')),
      many(reads, () =>
        http().get('/api/hub/waitlist/registrations/wawu-join-x'),
      ),
      many(writes, () =>
        http()
          .post('/api/hub/waitlist/registrations/verify')
          .send({ reference: 'wawu-join-x', transactionId: '1' }),
      ),
    ]);
    expect(offers.filter((s) => s === 200)).toHaveLength(reads);
    expect(statuses.filter((s) => s === 404)).toHaveLength(reads);
    expect(verifies.filter((s) => s === 404)).toHaveLength(writes);
    expect((await http().get('/api/hub/waitlist/offers/current')).status).toBe(
      429,
    );
    expect(
      (await http().get('/api/hub/waitlist/registrations/wawu-join-x')).status,
    ).toBe(429);
    expect(
      (
        await http()
          .post('/api/hub/waitlist/registrations/verify')
          .send({ reference: 'wawu-join-x', transactionId: '1' })
      ).status,
    ).toBe(429);
  }, 180_000);
});
