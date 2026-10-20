import { Module } from '@nestjs/common';
import { AiToolsModule } from '../ai-tools/ai-tools.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { PlansModule } from '../plans/plans.module';
import { PointsSpendModule } from '../points/spend/points-spend.module';
import { StorageModule } from '../storage/storage.module';
import { StorageVoiceFiles, VOICE_FILES } from './voice-files';
import {
  VoiceIntroController,
  VoiceIntroPublicController,
} from './voice-intro.controller';
import { VoiceIntroRunService } from './voice-intro-run.service';
import { VoiceProfileService } from './voice-profile.service';

/**
 * The caller's own voice (VOICE-01): `/me/voice*` and `/me/voice-intro*`, and `GET /users/:wawuId/voice-intro`.
 *
 * The voice provider is the same seam AITOOLS-01 holds (`AI_VOICE_PROVIDER`,
 * one adapter, one stand-in); this module reaches it only through that token
 * and never imports the adapter. The audio and the recording are kept through
 * `VOICE_FILES`. Mounting it in AppModule is SHARED-CHANGES VOICE-01 #1.
 */
@Module({
  imports: [
    WawuAuthModule,
    AiToolsModule,
    BlockedAccountModule,
    PlanSettingsModule,
    PlansModule,
    PointsSpendModule,
    StorageModule,
  ],
  controllers: [VoiceIntroController, VoiceIntroPublicController],
  providers: [
    VoiceProfileService,
    VoiceIntroRunService,
    { provide: VOICE_FILES, useClass: StorageVoiceFiles },
  ],
})
export class VoiceIntroModule {}
