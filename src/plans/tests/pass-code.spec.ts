import { LivePlansConfig } from '../../plan-settings/live-plans-config';
import { loadPlanSettingsDefaults } from '../../plan-settings/plan-settings-defaults';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { MakerTierService } from '../maker-tier.service';
import { PlansService } from '../plans.service';

/**
 * FIX-110 (G-814): `GET /me/tier` `eventPass` carries the event's name and the
 * code the pass's QR holds. No database: the pass table is a stand-in.
 */

const seed = loadPlanSettingsDefaults();

async function plansWith(
  passes: { id: string; type: string; createdAt: Date }[],
) {
  const settings = new PlanSettingsService(
    { planSetting: { findMany: () => Promise.resolve([]) } } as never,
    seed,
  );
  await settings.onModuleInit();
  settings.onModuleDestroy();
  const config = new LivePlansConfig(settings);
  const prisma = {
    makerTier: { findUnique: () => Promise.resolve(null) },
    eventPass: { findMany: () => Promise.resolve(passes) },
  };
  const tiers = new MakerTierService(prisma as never, config);
  const publishing = {
    of: () => Promise.resolve({ productsUsed: 0 }),
  };
  return new PlansService(config, {} as never, tiers, publishing as never);
}

describe('the pass on GET /me/tier (FIX-110)', () => {
  it("carries the event name and the best pass's own id as its code", async () => {
    const service = await plansWith([
      {
        id: 'pass-row-1',
        type: 'watch_apply',
        createdAt: new Date('2026-10-01'),
      },
      {
        id: 'pass-row-2',
        type: 'maker_pass',
        createdAt: new Date('2026-10-02'),
      },
    ]);
    const tier = await service.myTier('person-1');
    expect(tier.eventPass).toMatchObject({
      id: 'maker_pass',
      name: 'Maker Pass',
      eventName: 'Christmas event',
      passCode: 'pass-row-2',
    });
  });

  it('is null for a person with no pass, so there is no code to show', async () => {
    const service = await plansWith([]);
    expect((await service.myTier('person-1')).eventPass).toBeNull();
  });
});
