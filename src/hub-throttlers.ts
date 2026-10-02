import type { ThrottlerOptions } from '@nestjs/throttler';

/**
 * The app's named rate limits, registered once in AppModule
 * (`ThrottlerModule.forRoot(HUB_THROTTLERS)`, behind the global
 * ThrottlerGuard). Moved here unchanged from app.module.ts by MONEY-07, so
 * a route that must never be throttled can skip every one of them by name.
 */
export const HUB_THROTTLERS = [
  { name: 'short', ttl: 1_000, limit: 20 },
  { name: 'medium', ttl: 60_000, limit: 200 },
] as const satisfies readonly ThrottlerOptions[];

/**
 * For `@SkipThrottle(SKIP_EVERY_HUB_THROTTLER)`. A bare `@SkipThrottle()`
 * skips only a throttler named `default`, which this app does not have, so
 * it skips nothing here. This map names every throttler above, so a
 * throttler added later is skipped too.
 */
export const SKIP_EVERY_HUB_THROTTLER: Record<string, boolean> =
  Object.fromEntries(HUB_THROTTLERS.map((t) => [t.name, true]));
