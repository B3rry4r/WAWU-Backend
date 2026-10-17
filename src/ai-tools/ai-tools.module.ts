import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { PointsSpendModule } from '../points/spend/points-spend.module';
import { StorageModule } from '../storage/storage.module';
import { AI_AUDIO_STORE, StorageAiAudioStore } from './audio/ai-audio-store';
import { AiJobService } from './ai-job.service';
import { AiToolsController } from './ai-tools.controller';
import { AiToolsService } from './ai-tools.service';
import { AI_VOICE_PROVIDER } from './voice/ai-voice-provider';
import { HttpVoiceProvider } from './voice/http-voice-provider';

/**
 * The AI tools catalogue and VoiceOver (AITOOLS-01): `GET /ai-tools`,
 * `POST /ai-tools/voiceover/jobs`, `GET /ai-tools/jobs/{id}`.
 *
 * The voice provider is reached only through `AI_VOICE_PROVIDER`; a spec or a
 * stack points `AI_VOICE_BASE_URL` at a stand-in on this machine. The audio
 * goes to the Hub's object storage through `AI_AUDIO_STORE`.
 *
 * Mounting it in AppModule is SHARED-CHANGES AITOOLS-01 #1 (one import and one
 * entry, after PointsSpendModule).
 */
@Module({
  imports: [
    WawuAuthModule,
    PlanSettingsModule,
    PointsSpendModule,
    StorageModule,
  ],
  controllers: [AiToolsController],
  providers: [
    AiToolsService,
    AiJobService,
    {
      provide: AI_VOICE_PROVIDER,
      useFactory: (config: ConfigService) => new HttpVoiceProvider(config),
      inject: [ConfigService],
    },
    { provide: AI_AUDIO_STORE, useClass: StorageAiAudioStore },
  ],
  exports: [AiJobService],
})
export class AiToolsModule {}
