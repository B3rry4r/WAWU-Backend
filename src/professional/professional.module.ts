import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { ProfessionalController } from './professional.controller';
import { ProfessionalService } from './professional.service';

/**
 * Professional profiles. WawuAuthModule supplies WawuIdClient (display names
 * and badge tiers, which WAWU ID owns) plus the JWKS verification both guards
 * need. PrismaService comes from the global PrismaModule.
 *
 * Exported so the admin review surface drives approvals through the same
 * service rather than writing the table itself.
 */
@Module({
  imports: [WawuAuthModule],
  controllers: [ProfessionalController],
  providers: [ProfessionalService],
  exports: [ProfessionalService],
})
export class ProfessionalModule {}
