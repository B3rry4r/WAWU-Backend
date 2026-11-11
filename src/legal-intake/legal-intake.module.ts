import { Module } from '@nestjs/common';
import { GEMINI_CLIENT } from '../common/ai/gemini-client.interface';
import { RealGeminiAdapter } from '../common/ai/real-gemini.adapter';
import { ConfigService } from '@nestjs/config';
import { AI_VOICE_PROVIDER } from '../ai-tools/voice/ai-voice-provider';
import { HttpVoiceProvider } from '../ai-tools/voice/http-voice-provider';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { ElevenLabsLegalAi } from './ai/elevenlabs-legal-ai';
import { LegalAiClient } from './ai/legal-ai.client';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { LivePublisherModule } from '../live/live-publisher.module';
import { StorageModule } from '../storage/storage.module';
import { LegalIntakeController } from './legal-intake.controller';
import { LegalIntakeOpsController } from './legal-intake-ops.controller';
import { LegalIntakeService } from './legal-intake.service';
import { LegalIntakeOpsService } from './legal-intake-ops.service';
import { LegalChatService } from './legal-chat.service';
import { LegalMatterNoticeService } from '../legal/legal-matter-notice.service';
import { LegalAssistantController } from './assistant/legal-assistant.controller';
import { LegalAssistantOpsController } from './assistant/legal-assistant-ops.controller';
import { LegalAssistantService } from './assistant/legal-assistant.service';
import { LegalAssistantAllowance } from './assistant/legal-assistant-allowance';
import { LegalMatterFiles } from './assistant/legal-matter-files';
import {
  ASSISTANT_OPENER_WAIT_MS,
  LEGAL_OPENER_WAIT_MS,
} from './assistant/legal-assistant-config';

/**
 * Legal profiling. The AI client that writes the brief is LegalAiClient (LEGAL-ELEVEN);
 * WawuAuthModule supplies the JWKS verification the guard needs. PrismaService
 * comes from the global PrismaModule.
 *
 * Two controllers: the client's flow behind WawuAuthGuard, and the
 * consultant's read-only queue behind AdminAuthGuard. They cannot share one,
 * because a class-level WawuAuthGuard would reject an admin's HS256 token
 * before it was ever read — the same reason LegalOpsController is separate
 * from LegalController.
 */
@Module({
  imports: [
    // LEGAL-ELEVEN: the settings that pick the provider and model (no controller: it moves no route).
    PlanSettingsModule,
    WawuAuthModule,
    AdminAuthModule,
    LivePublisherModule,
    // R2-LEGAL3: the files a person sends on a matter ride the chat upload path.
    StorageModule,
  ],
  controllers: [
    LegalIntakeController,
    LegalIntakeOpsController,
    // LEGAL-01: legal starts as a chat, on the same intake table.
    LegalAssistantController,
    LegalAssistantOpsController,
  ],
  providers: [
    // LEGAL-ELEVEN (R-137): the legal services' GEMINI_CLIENT is this module's own, which answers through the agent
    // platform (`legal.ai_provider=elevenlabs`, the default) or Gemini (`gemini`, the way back).
    RealGeminiAdapter,
    // The agent client, this module's own instance (the same class and settings as the AI tools'; importing AiToolsModule
    // would load its controllers earlier and reorder the Hub's routes).
    {
      provide: AI_VOICE_PROVIDER,
      useFactory: (config: ConfigService) => new HttpVoiceProvider(config),
      inject: [ConfigService],
    },
    ElevenLabsLegalAi,
    LegalAiClient,
    { provide: GEMINI_CLIENT, useExisting: LegalAiClient },
    LegalIntakeService,
    LegalIntakeOpsService,
    LegalChatService,
    LegalAssistantAllowance,
    LegalMatterFiles,
    LegalMatterNoticeService,
    LegalAssistantService,
    // FIX-11: how long a read waits for another read's opener.
    { provide: LEGAL_OPENER_WAIT_MS, useValue: ASSISTANT_OPENER_WAIT_MS },
  ],
  exports: [LegalIntakeService, LegalChatService, LegalAssistantAllowance],
})
export class LegalIntakeModule {}
