import { Global, Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { VerificationStateModule } from '../common/verification/verification-state.module';
import { ContentPieceModule } from '../content-piece/content-piece.module';
import { VerificationController } from './verification.controller';
import { AdminVerificationTicksController } from './admin-verification-ticks.controller';
import { VerificationService } from './verification.service';

/**
 * The two ticks: buying one, granting one, taking one away.
 *
 * ── WHY THE PAYMENT CLIENT COMES FROM ContentPieceModule ─────────────────
 * Every paid action in this backend so far carries its own copy of
 * `FlutterwaveClient`, `InitChargeParams`, `RealFlutterwaveAdapter` and
 * `MockFlutterwaveAdapter` - five of each, and the forks gate reports all
 * five. A sixth set would be that same defect with a fresh coat on it. So
 * this imports ContentPieceModule and uses the `FLUTTERWAVE_CLIENT` it
 * exports, which is the exact client the content unlock verifies against.
 * One idiom, one adapter pair, one place the mock/real swap is decided.
 *
 * AppModule lists this module AFTER ContentPieceModule on purpose. Route
 * registration order is decided by first encounter during that walk, so
 * listing it earlier would move ContentPiece's own controllers up the order
 * as a side effect of this import.
 *
 * ── WHY THE READER IS A SEPARATE MODULE ──────────────────────────────────
 * VerificationStateModule holds the read side and declares no controller, so
 * a feature module that needs to render a tick can import it and drag no
 * routes in with it. This module is @Global() as well, so nothing has to
 * import it to inject VerificationService.
 *
 * AdminAuthModule is imported for the guards the admin tick routes need. It
 * is listed far earlier in AppModule than this module, so importing it here
 * does not move where its own controller is first encountered.
 */
@Global()
@Module({
  imports: [
    WawuAuthModule,
    AdminAuthModule,
    VerificationStateModule,
    ContentPieceModule,
  ],
  controllers: [VerificationController, AdminVerificationTicksController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
