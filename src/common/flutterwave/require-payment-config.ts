/**
 * Guards against payments failing OPEN.
 *
 * Every money module picks its Flutterwave adapter with roughly
 * `!process.env.FLUTTERWAVE_SECRET_KEY ? Mock : Real`, and every mock adapter
 * reports `status: 'successful'` for the full amount without contacting
 * Flutterwave. That is correct for tests and local development — but it means
 * a production deploy that is missing (or typos) `FLUTTERWAVE_SECRET_KEY`
 * boots perfectly happily and hands out every content unlock, credit pack,
 * paid DM, CAC registration and Pro subscription for ₦0, silently.
 *
 * `shouldUseMockFlutterwave()` keeps the same developer-friendly default, but
 * refuses to start in production rather than silently giving the product away.
 */

/** True when the process is a real deployment rather than test/local dev. */
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function shouldUseMockFlutterwave(): boolean {
  if (process.env.NODE_ENV === 'test') return true;

  const key = process.env.FLUTTERWAVE_SECRET_KEY ?? '';
  const unusable = key.length === 0 || key.includes('placeholder');

  if (!unusable) return false;

  if (isProductionRuntime()) {
    throw new Error(
      'FLUTTERWAVE_SECRET_KEY is missing or a placeholder in a production build. ' +
        'Refusing to start: the mock payment adapter approves every charge for free, ' +
        'so booting would give away all paid content, credits, DMs and subscriptions. ' +
        'Set a real Flutterwave secret key, or set NODE_ENV to something other than "production".',
    );
  }

  return true;
}
