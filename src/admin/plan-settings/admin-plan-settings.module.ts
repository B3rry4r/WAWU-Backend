import { Module } from '@nestjs/common';
import { PlanSettingsModule } from '../../plan-settings/plan-settings.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminPlanSettingsController } from './admin-plan-settings.controller';

/** `/admin/plan-settings` (TIER-06): the launch figures in the dashboard. */
@Module({
  imports: [AdminAuthModule, PlanSettingsModule],
  controllers: [AdminPlanSettingsController],
})
export class AdminPlanSettingsModule {}
