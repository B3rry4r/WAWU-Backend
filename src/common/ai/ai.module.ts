import { Module } from '@nestjs/common';
import { GEMINI_CLIENT } from './gemini-client.interface';
import { RealGeminiAdapter } from './real-gemini.adapter';

/**
 * Gemini. One adapter, one code path, every environment.
 *
 * There is no stand-in and no offline mode. Gemini issues API keys the same
 * way Flutterwave issues test keys — you point a non-production environment
 * at a non-production key and the real request goes out. Swapping in canned
 * text would mean the thing exercised in tests is not the thing that runs in
 * production, which for a call whose whole output is generated text is not a
 * test of anything worth having.
 *
 * `GEMINI_API_KEY` is therefore required to boot, in every environment.
 */
@Module({
  providers: [
    RealGeminiAdapter,
    { provide: GEMINI_CLIENT, useExisting: RealGeminiAdapter },
  ],
  exports: [GEMINI_CLIENT],
})
export class AiModule {}
