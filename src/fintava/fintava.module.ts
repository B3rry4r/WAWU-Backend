import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FintavaClient } from './fintava-client';

/**
 * The Fintava gateway (MONEY-06): one client, no routes. A feature that
 * moves naira imports this module and injects `FintavaClient`; the
 * Flutterwave adapters are separate and unchanged (CLAUDE.md rule 6). The
 * client reads FINTAVA_BASE_URL, FINTAVA_API_KEY and the FINTAVA_*_MS
 * timeouts; a set but wrong value stops the app at boot, a missing key
 * fails each call with `not_configured` and sends nothing. In production
 * with FINTAVA_BASE_URL unset the app still starts (MONEY-11): the client
 * is unconfigured, logs one warning, and every call is `not_configured`.
 */
@Module({
  imports: [ConfigModule],
  providers: [FintavaClient],
  exports: [FintavaClient],
})
export class FintavaModule {}
