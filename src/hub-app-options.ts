import type { NestApplicationOptions } from '@nestjs/common';

/**
 * The options the Hub app is created with (src/main.ts), in one place so a
 * test builds its app the same way.
 *
 * `rawBody: true` keeps the exact bytes of every JSON and form body on
 * `request.rawBody`, beside the parsed `request.body`. Fintava signs the raw
 * body (HMAC-SHA512, task MONEY-07), and re-serialising the parsed JSON
 * does not give the same bytes back (spacing, key order, `100.0`, escapes).
 * Nothing else changes: the same parsers parse the same bodies.
 */
export const HUB_APP_OPTIONS: NestApplicationOptions = { rawBody: true };
