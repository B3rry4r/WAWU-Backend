import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { PointsSpendModule } from '../points/spend/points-spend.module';
import { StorageModule } from '../storage/storage.module';
import { AI_AUDIO_STORE, StorageAiAudioStore } from './audio/ai-audio-store';
import { AiJobService } from './ai-job.service';
import { AiToolsController } from './ai-tools.controller';
import {
  AI_INPUT_FILES,
  AiInputService,
  StorageAiInputFiles,
} from './input/ai-input-files';
import { AiToolsService } from './ai-tools.service';
import { AiDubService } from './dub/ai-dub.service';
import { AI_VOICE_PROVIDER } from './voice/ai-voice-provider';
import { HttpVoiceProvider } from './voice/http-voice-provider';
import { ProviderCopyService } from './voice/provider-copy.service';

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
    // AITOOLS-04: the person's own file for Captions and Clean audio.
    { provide: AI_INPUT_FILES, useClass: StorageAiInputFiles },
    AiInputService,
    // AITOOLS-04 round 2: deletes the provider's copy of a transcript or a
    // cleaned recording, trying again until the provider has stored it.
    ProviderCopyService,
    // AITOOLS-05: follows the dubs the provider is working on, until each is done or failed.
    AiDubService,
  ],
  exports: [AiJobService, AiInputService, AI_VOICE_PROVIDER, AI_AUDIO_STORE],
})
export class AiToolsModule {}
