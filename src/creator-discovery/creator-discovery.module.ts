import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { CreatorDiscoveryController } from './creator-discovery.controller';
import { CreatorDiscoveryService } from './creator-discovery.service';

/**
 * Creator discovery. PrismaService comes from the global PrismaModule;
 * WawuAuthModule provides WawuIdClient (names and badge tiers) and the JWKS
 * verification the optional guard needs.
 */
@Module({
  imports: [WawuAuthModule],
  controllers: [CreatorDiscoveryController],
  providers: [CreatorDiscoveryService],
})
export class CreatorDiscoveryModule {}
