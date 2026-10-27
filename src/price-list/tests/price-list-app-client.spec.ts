import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureHubApp } from '../../hub-app-config';
import { ContentPieceService } from '../../content-piece/content-piece.service';
import { ProductDraftService } from '../../content-piece/product-draft.service';
import { EventService } from '../../event/event.service';
import { EventTicketingService } from '../../event-ticketing/event-ticketing.service';
import { MoneyError } from '../../money/money-error';
import { loadPlanSettingsDefaults } from '../../plan-settings/plan-settings-defaults';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  APP_CLIENT_HEADER,
  AppClientMiddleware,
  isAppRequest,
} from '../app-client';
import { PriceListModule } from '../price-list.module';
import { PriceListService } from '../price-list.service';

/**
 * PRICE-LIST round 2 (lead ruling, option A): the app sends `X-Wawu-Client:
 * app` on every Hub request. With it, a price off the list is refused on the
 * routes the website also calls (POST /content, the draft publish, PUT
 * /events/{id}/tickets, POST /events with ticket types). Without it, those
 * routes answer as they always did. Stand-ins for everything a check does not
 * reach; the real price list over the real seed. The write is a stand-in that
 * throws REACHED, so "accepted" means the request got as far as writing.
 */

const seed = loadPlanSettingsDefaults();
async function realList() {
  const prisma = {
    planSetting: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const settings = new PlanSettingsService(prisma as never, seed);
  await settings.onModuleInit();
  settings.onModuleDestroy();
  return new PriceListService(settings);
}

/** Builds a service whose constructor is not typed here, so the spec runs the same against any head. */
function make<T>(C: unknown, ...args: unknown[]): T {
  return new (C as new (...a: unknown[]) => T)(...args);
}

/** Runs `fn` the way the middleware runs a request: with the header as the app, as the website (absent) or as something else. */
function asClient<T>(header: string | undefined, fn: () => Promise<T>) {
  let out!: Promise<T>;
  const headers: Record<string, string> = {};
  if (header !== undefined) headers[APP_CLIENT_HEADER] = header;
  new AppClientMiddleware().use({ headers } as never, {} as never, () => {
    out = fn();
  });
  return out;
}

const REACHED = 'reached the write';
/** What came of a call: a price refusal, the write (accepted), or anything else (with its message). */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'done';
  } catch (e) {
    if (e instanceof MoneyError) {
      return (e.getResponse() as { reason: { code: string } }).reason.code;
    }
    return e instanceof Error && e.message === REACHED
      ? 'accepted'
      : `other: ${String(e)}`;
  }
}

describe('X-Wawu-Client: app', () => {
  it('is read from the header, "app" only, in any case', async () => {
    const seen = (h: string | undefined) =>
      asClient(h, () => Promise.resolve(isAppRequest()));
    expect(await seen('app')).toBe(true);
    expect(await seen(' App ')).toBe(true);
    expect(await seen(undefined)).toBe(false);
    expect(await seen('web')).toBe(false);
    expect(await seen('')).toBe(false);
    // Outside any request it is the website's way.
    expect(isAppRequest()).toBe(false);
  });

  it('survives awaits inside the request', async () => {
    const seen = await asClient('app', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return isAppRequest();
    });
    expect(seen).toBe(true);
  });

  it('is applied to every route by the price list module', () => {
    const forRoutes = jest.fn();
    const apply = jest.fn(() => ({ forRoutes }));
    new PriceListModule().configure({ apply } as never);
    expect(apply).toHaveBeenCalledWith(AppClientMiddleware);
    expect(forRoutes).toHaveBeenCalledWith('*');
  });
});

describe('CORS preflight', () => {
  @Controller('prices')
  class Stand {
    @Get() read() {
      return {};
    }
  }
  let app: INestApplication<App>;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [Stand],
    }).compile();
    app = mod.createNestApplication();
    configureHubApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('allows X-Wawu-Client from a browser (the app web build)', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/hub/prices')
      .set('Origin', 'https://app.example.test')
      .set('Access-Control-Request-Method', 'GET')
      .set(
        'Access-Control-Request-Headers',
        'authorization,x-wawu-client,idempotency-key',
      );
    expect(res.status).toBeLessThan(300);
    const allowed = String(res.headers['access-control-allow-headers'] ?? '');
    expect(allowed.toLowerCase()).toContain('x-wawu-client');
    expect(allowed.toLowerCase()).toContain('authorization');
  });
});

describe('POST /content and the draft publish', () => {
  const dto = (price: number) =>
    ({
      contentType: 'video',
      title: 'A piece',
      description: 'Description',
      category: 'education',
      accessType: 'paid',
      price,
      previewAsset: 'p',
      fullAsset: 'f',
    }) as never;
  const service = async () => {
    const prisma = {
      $transaction: jest.fn(() => Promise.reject(new Error(REACHED))),
    };
    const gate = {
      assertRoomForProduct: jest.fn(() => Promise.resolve({})),
    };
    return make<ContentPieceService>(
      ContentPieceService,
      prisma,
      {},
      {},
      {},
      {},
      gate,
      await realList(),
    );
  };

  it('refuses a price off the list when the app sends the header, with the nearest two', async () => {
    const s = await service();
    expect(
      await outcome(asClient('app', () => s.create('c1', dto(1300)))),
    ).toBe('price_not_on_list');
    const e = await asClient('app', () => s.create('c1', dto(1300))).catch(
      (x: MoneyError) => x,
    );
    expect(e).toBeInstanceOf(MoneyError);
    expect((e as MoneyError).getStatus()).toBe(400);
    expect((e as MoneyError).getResponse()).toMatchObject({
      reason: { nearestLowerNaira: 1000, nearestHigherNaira: 1500 },
    });
  });

  it('accepts a list price, and free, with the header', async () => {
    const s = await service();
    expect(
      await outcome(asClient('app', () => s.create('c1', dto(1500)))),
    ).toBe('accepted');
    const free = { ...(dto(0) as object), accessType: 'free' } as never;
    expect(await outcome(asClient('app', () => s.create('c1', free)))).toBe(
      'accepted',
    );
  });

  it('answers as before without the header, or with another one', async () => {
    const s = await service();
    for (const h of [undefined, 'web']) {
      expect(await outcome(asClient(h, () => s.create('c1', dto(1300))))).toBe(
        'accepted',
      );
    }
  });

  it('refuses an off-list draft at publish when the app sends the header, and publishes it without', async () => {
    const draft = {
      id: 'd1',
      wawuUserId: 'c1',
      title: 'Draft',
      contentType: 'video',
      description: 'd',
      category: 'education',
      specializations: [],
      tags: [],
      accessType: 'paid',
      price: 1300,
    };
    const prisma = {
      productDraft: { findFirst: jest.fn(() => Promise.resolve(draft)) },
      $transaction: jest.fn(() => Promise.reject(new Error(REACHED))),
    };
    const gate = {
      assertRoomForProduct: jest.fn(() => Promise.resolve({})),
    };
    const content = make<ContentPieceService>(
      ContentPieceService,
      prisma,
      {},
      {},
      {},
      {},
      gate,
      await realList(),
    );
    jest.spyOn(content, 'settleSlowUploads').mockResolvedValue(undefined);
    jest.spyOn(content, 'filesUsableIn').mockReturnValue(jest.fn());
    const drafts = make<ProductDraftService>(
      ProductDraftService,
      prisma,
      content,
      gate,
    );
    const publish = () =>
      drafts.publish('c1', 'd1', {
        previewAsset: 'p',
        fullAsset: 'f',
      });
    expect(await outcome(asClient('app', publish))).toBe('price_not_on_list');
    expect(await outcome(asClient(undefined, publish))).toBe('accepted');
  });
});

describe('PUT /events/{id}/tickets', () => {
  const build = async () => {
    const prisma = {
      event: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            hostWawuId: 'h1',
            cancelledAt: null,
            status: 'published',
          }),
        ),
      },
      eventTicketType: { findMany: jest.fn(() => Promise.resolve([])) },
      $transaction: jest.fn(() => Promise.reject(new Error(REACHED))),
    };
    const events = { assertMayHost: jest.fn(() => Promise.resolve()) };
    return make<EventTicketingService>(
      EventTicketingService,
      prisma,
      {},
      {},
      events,
      {},
      await realList(),
    );
  };
  const tiers = (priceNaira: number) => [
    { tier: 'regular', name: 'GA', priceNaira, quantity: 10 },
    { tier: 'free', name: 'Press', priceNaira: 0, quantity: 2 },
  ];

  it('refuses a paid tier off the list with the header, and takes the free tier', async () => {
    const s = await build();
    expect(
      await outcome(
        asClient('app', () =>
          s.setTicketTypes('h1', 'e1', tiers(3500) as never),
        ),
      ),
    ).toBe('price_not_on_list');
    expect(
      await outcome(
        asClient('app', () =>
          s.setTicketTypes('h1', 'e1', tiers(3000) as never),
        ),
      ),
    ).toBe('accepted');
  });

  it('answers as before without the header', async () => {
    const s = await build();
    expect(
      await outcome(
        asClient(undefined, () =>
          s.setTicketTypes('h1', 'e1', tiers(3500) as never),
        ),
      ),
    ).toBe('accepted');
  });
});

describe('POST /events with ticket types', () => {
  const build = async () => {
    const prisma = {
      event: { create: jest.fn(() => Promise.reject(new Error(REACHED))) },
    };
    const service = make<EventService>(
      EventService,
      prisma,
      {},
      {},
      {},
      await realList(),
    );
    jest.spyOn(service, 'assertMayHost').mockResolvedValue(undefined);
    return service;
  };
  const dto = (priceNaira: number) =>
    ({
      name: 'Launch',
      description: 'd',
      hostOrg: 'Org',
      startsAt: new Date(Date.now() + 864e5).toISOString(),
      ticketTypes: [{ name: 'GA', tier: 'regular', priceNaira, quantity: 5 }],
    }) as never;

  it('refuses a paid ticket type off the list with the header', async () => {
    const s = await build();
    expect(
      await outcome(asClient('app', () => s.create('h1', dto(3500)))),
    ).toBe('price_not_on_list');
    expect(
      await outcome(asClient('app', () => s.create('h1', dto(3000)))),
    ).toBe('accepted');
  });

  it('answers as before without the header', async () => {
    const s = await build();
    expect(
      await outcome(asClient(undefined, () => s.create('h1', dto(3500)))),
    ).toBe('accepted');
  });
});
