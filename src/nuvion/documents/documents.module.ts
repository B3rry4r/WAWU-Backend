import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { IdentityHasher } from '../../money/identity/identity-config';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { NuvionDocumentsController } from './documents.controller';
import { NuvionDocumentsService } from './documents.service';
import { DocumentUploadInterceptor } from './documents-upload.interceptor';
import { DocumentUploadSlots } from './documents-slots';

/**
 * The ID document, the proof of address and the hosted selfie routes
 * (task NUV-03): `GET` and `POST /money/identity/documents`, `GET` and
 * `POST /money/identity/liveness`. Imported by MoneyModule (mobile repo
 * SHARED-CHANGES NUV-03 #1: money.module.ts is a shared file); until that
 * line is in, the routes are not served.
 *
 * It needs the app built as the Hub is (`rawBody`, the global prefix and
 * the validation pipe: src/main.ts); the upload is read by the multer that
 * `@nestjs/platform-express` ships, in memory, with Nuvion's 10 MB limit.
 */
@Module({
  imports: [ConfigModule, PrismaModule, WalletProviderModule, WawuAuthModule],
  controllers: [NuvionDocumentsController],
  providers: [
    // The fingerprint of an upload is an HMAC under IDENTITY_HASH_KEY, as
    // the BVN's hash is (MoneyModule provides its own instance of this).
    IdentityHasher,
    NuvionDocumentsService,
    DocumentUploadSlots,
    DocumentUploadInterceptor,
  ],
  exports: [NuvionDocumentsService],
})
export class NuvionDocumentsModule {}
