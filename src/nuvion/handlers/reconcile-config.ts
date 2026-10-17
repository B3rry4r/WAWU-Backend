/**
 * The knobs of the reconciliation with Nuvion (task NUV-08). Tuning, not
 * money: no fee or limit figure is here. Each is optional; an unset or
 * unusable value falls back to its default (a typo never stops the server,
 * because nothing here moves money).
 *
 * PROVISIONAL(NUVION-SWEEP-MINUTES, owner=YOU, why=Nuvion stops retrying a webhook after 15 minutes (webhooks__overview.md), so a pass every 15 minutes finds a missed delivery soon after its window closes; the owner may want it shorter once real volume and Nuvion's rate limits are known)
 * PROVISIONAL(NUVION-SWEEP-LOOKBACK-HOURS, owner=YOU, why=the task reads the last day's statement lines; a server that was down longer than this leaves the older ones to the nightly check)
 * PROVISIONAL(NUVION-SWEEP-MAX-ACCOUNTS, owner=YOU, why=Nuvion states no rate limit for statements, so one pass reads at most this many accounts and rotates through the rest across passes)
 * PROVISIONAL(NUVION-WEBHOOK-RENEW-HOURS, owner=YOU, why=Nuvion's docs give a webhook an expiry but no advice on when to renew; three days leaves time to notice a failed renewal)
 * PROVISIONAL(NUVION-SIMULATE-FEES-HOURS, owner=YOU, why=a fee simulation is a call to Nuvion for each kind and band, and a fee changes rarely, so once a day)
 */
export const NUVION_RECONCILE_CONFIG_KEYS = {
  sweepMinutes: 'NUVION_SWEEP_MINUTES',
  lookbackHours: 'NUVION_SWEEP_LOOKBACK_HOURS',
  maxAccounts: 'NUVION_SWEEP_MAX_ACCOUNTS',
  renewHours: 'NUVION_WEBHOOK_RENEW_HOURS',
  feeCheckHours: 'NUVION_SIMULATE_FEES_HOURS',
} as const;

export interface NuvionReconcileSettings {
  sweepMinutes: number;
  lookbackHours: number;
  maxAccounts: number;
  renewHours: number;
  feeCheckHours: number;
}

export const NUVION_RECONCILE_DEFAULTS: NuvionReconcileSettings = {
  sweepMinutes: 15,
  lookbackHours: 24,
  maxAccounts: 300,
  renewHours: 72,
  feeCheckHours: 24,
};

function whole(
  raw: string | undefined | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Reads the settings through `get` (ConfigService.get, or an env map). */
export function readReconcileSettings(
  get: (key: string) => string | undefined | null,
): NuvionReconcileSettings {
  const K = NUVION_RECONCILE_CONFIG_KEYS;
  const D = NUVION_RECONCILE_DEFAULTS;
  return {
    sweepMinutes: whole(get(K.sweepMinutes), D.sweepMinutes, 1, 360),
    lookbackHours: whole(get(K.lookbackHours), D.lookbackHours, 2, 168),
    maxAccounts: whole(get(K.maxAccounts), D.maxAccounts, 10, 5000),
    renewHours: whole(get(K.renewHours), D.renewHours, 1, 720),
    feeCheckHours: whole(get(K.feeCheckHours), D.feeCheckHours, 1, 168),
  };
}
