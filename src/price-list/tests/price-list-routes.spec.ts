import { ContentPieceService } from '../../content-piece/content-piece.service';
import { CommunityRoomsService } from '../../community/rooms/community-rooms.service';
import { PaidDmSettingsService } from '../../direct-message/paid-dm-settings.service';
import { MoneyError } from '../../money/money-error';
import { loadPlanSettingsDefaults } from '../../plan-settings/plan-settings-defaults';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { PriceListService } from '../price-list.service';

/**
 * PRICE-LIST (R-101 point 3): the three routes the app alone uses to set a
 * price refuse a price that is not on the list with `400 price_not_on_list`,
 * before anything is written. Stand-ins for everything the check does not
 * reach; the real price list service over the real seed.
 *
 * POST /content, PUT /events/{id}/tickets and POST /events are routes the
 * website also calls (the protected registry); they are not changed here, and
 * `ContentPieceService.create` has no price list in reach (upload-allowance
 * spec passes none and still creates).
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

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as MoneyError;
  }
  return undefined;
};

describe('PATCH /content/{id} (a piece before review)', () => {
  const piece = {
    id: 'p1',
    creatorWawuId: 'c1',
    status: 'pending',
    accessType: 'paid',
    price: 1200,
    previewAssetUrl: 'a',
    fullAssetUrl: 'b',
  };
  const build = async (listService?: unknown) => {
    const prisma = {
      contentPiece: { findUnique: jest.fn(() => Promise.resolve(piece)) },
    };
    const gate = { assertMayUpload: jest.fn() };
    return {
      prisma,
      service: new ContentPieceService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        gate as never,
        (listService ?? (await realList())) as never,
      ),
    };
  };

  it('refuses a new price that is not on the list, with the nearest two, and writes nothing', async () => {
    const { service, prisma } = await build();
    const e = await refusal(service.updateMine('p1', 'c1', { price: 1300 }));
    expect(e).toBeInstanceOf(MoneyError);
    expect(e!.getStatus()).toBe(400);
    expect((e!.getResponse() as { reason: unknown }).reason).toMatchObject({
      code: 'price_not_on_list',
      nearestLowerNaira: 1000,
      nearestHigherNaira: 1500,
    });
    expect(Object.keys(prisma.contentPiece)).toEqual(['findUnique']);
  });

  it('judges only a price that is being set: a title edit, the same price, or free is not asked of the list', async () => {
    const asked = jest.fn();
    const { service } = await build({ assertOnList: asked });
    for (const dto of [
      { title: 'New title' },
      { price: 1200 },
      { accessType: 'free' },
    ]) {
      await refusal(service.updateMine('p1', 'c1', dto as never));
    }
    expect(asked).not.toHaveBeenCalled();
    await refusal(service.updateMine('p1', 'c1', { price: 1500 }));
    expect(asked).toHaveBeenCalledWith(1500);
  });
});

describe('PUT /paid-dm/settings (a paid question)', () => {
  const build = async (listService?: unknown, dmPrice = 400) => {
    const prisma = {
      creatorState: {
        findUnique: jest.fn(() =>
          Promise.resolve({ dmPrice, dmResponseHours: 24 }),
        ),
        upsert: jest.fn(),
      },
    };
    const pause = { standing: jest.fn(() => Promise.resolve({ state: 'on' })) };
    return {
      prisma,
      service: new PaidDmSettingsService(
        prisma as never,
        pause as never,
        (listService ?? (await realList())) as never,
      ),
    };
  };

  it('refuses a price off the list (₦450) before anything is saved', async () => {
    const { service, prisma } = await build();
    const e = await refusal(
      service.save('c1', { enabled: true, priceKobo: 45_000 }),
    );
    expect(e).toBeInstanceOf(MoneyError);
    expect((e!.getResponse() as { reason: unknown }).reason).toMatchObject({
      code: 'price_not_on_list',
      nearestLowerNaira: 200,
      nearestHigherNaira: 500,
    });
    expect(prisma.creatorState.upsert).not.toHaveBeenCalled();
  });

  it('asks the list for a new price only, not for a price sent again or no price at all', async () => {
    const asked = jest.fn();
    const { service } = await build({ assertOnList: asked }, 400);
    await refusal(service.save('c1', { enabled: true, priceKobo: 40_000 }));
    await refusal(service.save('c1', { enabled: false }));
    expect(asked).not.toHaveBeenCalled();
    await refusal(service.save('c1', { enabled: true, priceKobo: 50_000 }));
    expect(asked).toHaveBeenCalledWith(500);
  });
});

describe('POST /communities/rooms (a pass)', () => {
  const build = async () => {
    const communities = { create: jest.fn() };
    const service = new CommunityRoomsService(
      {} as never,
      communities as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      await realList(),
    );
    return { communities, service };
  };
  const room = (passPriceKobo: number) =>
    ({
      kind: 'private',
      name: 'Room',
      description: 'd',
      imageUrl: 'https://x/y.png',
      passPriceKobo,
    }) as never;

  it('refuses a monthly price off the list, including one that is not whole naira, and creates nothing', async () => {
    const { service, communities } = await build();
    const e = await refusal(service.createRoom('h1', room(350_000)));
    expect(e).toBeInstanceOf(MoneyError);
    expect((e!.getResponse() as { reason: unknown }).reason).toMatchObject({
      code: 'price_not_on_list',
      nearestLowerNaira: 3000,
      nearestHigherNaira: 4000,
    });
    expect(
      await refusal(service.createRoom('h1', room(300_050))),
    ).toBeInstanceOf(MoneyError);
    expect(communities.create).not.toHaveBeenCalled();
  });

  it('accepts a list price (₦3,000) and hands it to the create', async () => {
    const { service, communities } = await build();
    communities.create.mockRejectedValue(new Error('stop here'));
    await refusal(service.createRoom('h1', room(300_000)));
    expect(communities.create).toHaveBeenCalledTimes(1);
  });
});
