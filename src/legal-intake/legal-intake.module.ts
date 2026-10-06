import { Module } from '@nestjs/common';
import { AiModule } from '../common/ai/ai.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { LegalIntakeController } from './legal-intake.controller';
import { LegalIntakeOpsController } from './legal-intake-ops.controller';
import { LegalIntakeService } from './legal-intake.service';
import { LegalIntakeOpsService } from './legal-intake-ops.service';
import { LegalChatService } from './legal-chat.service';
import { LegalAssistantService } from './assistant/legal-assistant.service';

/**
 * Legal profiling. AiModule supplies the Gemini client that writes the brief;
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
  imports: [AiModule, WawuAuthModule, AdminAuthModule],
  controllers: [LegalIntakeController, LegalIntakeOpsController],
  providers: [
    LegalIntakeService,
    LegalIntakeOpsService,
    LegalChatService,
    LegalAssistantService,
  ],
  exports: [LegalIntakeService, LegalChatService],
})
export class LegalIntakeModule {}
