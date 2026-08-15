import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { WawuJwtStrategy } from './wawu-jwt.strategy';
import { WawuIdClient } from './wawu-id.client';

/**
 * Shared auth infrastructure — imported once by AppModule. Exports
 * WawuIdClient so resource modules (e.g. verification) can call WAWU ID's
 * internal API (elevateVerificationTier) without re-implementing the
 * X-Service-Key client.
 */
@Module({
  imports: [ConfigModule, PassportModule.register({ defaultStrategy: 'wawu-jwt' })],
  providers: [WawuJwtStrategy, WawuIdClient],
  exports: [WawuIdClient],
})
export class WawuAuthModule {}
