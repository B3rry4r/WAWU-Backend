import { randomUUID } from 'node:crypto';
import { AdminRole } from '../../generated/prisma/enums';
import type { AdminActor } from '../../src/common/audit/admin-ops-audit.service';
import type { PlanSettingsService } from '../../src/plan-settings/plan-settings.service';

/**
 * PACK-CAP (R-100): the pack of extra products is sold only on Founding Maker,
 * two packs at most. Specs of the other mechanics (the room logic, the payment,
 * the grant) run on the first tier with many packs, so they open the rule in
 * the settings for their own run and put it back after. The rule itself is
 * tested in extra-products-cap.spec.ts and the two extra-products-cap
 * contract specs.
 */
const actor: AdminActor = {
  id: randomUUID(),
  email: 'open-pack-rule@admin.test.wawu.dev',
  role: AdminRole.finance,
};

export async function openPackRule(
  settings: PlanSettingsService,
  tierIds: readonly string[],
): Promise<void> {
  await settings.set(actor, {
    settings: {
      'plan.extra_products.tiers': [...tierIds],
      'plan.extra_products.max_packs': 2_147_483_647,
    },
  });
}

export async function resetPackRule(
  settings: PlanSettingsService,
): Promise<void> {
  await settings.set(actor, {
    settings: {
      'plan.extra_products.tiers': null,
      'plan.extra_products.max_packs': null,
    },
  });
}
