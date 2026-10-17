import { Module } from '@nestjs/common';
import { PLANS_CONFIG } from '../plans/plans-config';
import { LivePlansConfig } from './live-plans-config';
import {
  loadPlanSettingsDefaults,
  PLAN_SETTINGS_DEFAULTS,
} from './plan-settings-defaults';
import { PlanSettingsService } from './plan-settings.service';

/**
 * The launch figures as admin settings (TIER-06, R-65), with no routes.
 *
 * It provides PLANS_CONFIG, the token every reader of the plan already
 * injects, as the live plan: the seed files with the settings an admin saved
 * laid over them. PlansModule and WaitlistCoreModule import this module
 * instead of reading the file themselves, so there is one plan in memory and
 * one place that changes it. A spec that overrides PLANS_CONFIG still
 * overrides it everywhere.
 *
 * The routes are in AdminPlanSettingsModule (`/admin/plan-settings`). This
 * module declares no controller, so importing it early moves no route.
 * PrismaService comes from the global PrismaModule.
 */
@Module({
  providers: [
    {
      provide: PLAN_SETTINGS_DEFAULTS,
      useFactory: () => loadPlanSettingsDefaults(),
    },
    PlanSettingsService,
    {
      provide: PLANS_CONFIG,
      useFactory: (settings: PlanSettingsService) =>
        new LivePlansConfig(settings),
      inject: [PlanSettingsService],
    },
  ],
  exports: [PLANS_CONFIG, PlanSettingsService],
})
export class PlanSettingsModule {}
