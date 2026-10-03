/**
 * The ledger's timings (task MONEY-10). Each is overridable in config.
 */

/**
 * The bank code of every Fintava wallet: Loma Bank, `090620` in Fintava's
 * own bank list (mobile repo `docs/fintava/naira-api.md`, "Banks";
 * `sandbox/01-bank-list.md`). A party named at a bank is a WAWU wallet only
 * at this bank, since a NUBAN is unique only within its bank.
 */
export const FINTAVA_WALLET_BANK_CODE = '090620';

/** Config keys. None is required: the server starts without any of them. */
export const LEDGER_CONFIG_KEYS = {
  confirmWindowHours: 'LEDGER_CONFIRM_WINDOW_HOURS',
  statusCheckAfterMinutes: 'LEDGER_STATUS_CHECK_AFTER_MINUTES',
} as const;

/**
 * PROVISIONAL(LEDGER-CONFIRM-WINDOW, owner=YOU, why=Fintava does not say how long its lookups can answer an empty body; 72 hours is its own webhook retry horizon)
 *
 * How long a delivery the ledger cannot place yet stays `pending` and is
 * tried again on every sweep: a send or a reversal that Fintava could not
 * confirm (its lookup answered `{}` or did not answer), or a reversal whose
 * debit is not in the ledger. After the window a movement is recorded from
 * the signed delivery alone, with a note, and a reversal with nothing to
 * match is marked `failed` for review (MONEY-16 reports it).
 */
export const LEDGER_DEFAULTS = {
  confirmWindowHours: 72,
  /** Deliveries read per sweep, oldest first. */
  batch: 50,
  /** Pages of the sender's history read when looking for one movement. */
  historyPages: 3,
  /** Rows of that history read one by one (by id) for their tagapayTransRef. */
  byIdChecks: 5,
} as const;

export function ledgerConfirmWindowMs(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  if (text === '') return LEDGER_DEFAULTS.confirmWindowHours * 3_600_000;
  const hours = Number(text);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) {
    throw new Error(
      `${LEDGER_CONFIG_KEYS.confirmWindowHours} must be a whole number of hours from 1 to 720.`,
    );
  }
  return hours * 3_600_000;
}

/**
 * PROVISIONAL(LEDGER-STATUS-CHECK-AFTER, owner=YOU, why=Fintava publishes no time within which a webhook arrives; deliveries are consumed every 30 seconds, so 2 minutes gives the webhook four sweeps first)
 *
 * The pending sweep (task MONEY-08): how old a `pending` ledger row must be
 * before the sweep asks Fintava about it. Younger rows are left to their
 * webhook. A row it cannot settle yet is asked again after 1, 2, 4 ...
 * minutes, at most an hour apart.
 */
export const LEDGER_STATUS_DEFAULTS = {
  checkAfterMinutes: 2,
  /** Rows checked per sweep, oldest first. */
  batch: 50,
  /** References of a row tried with the lookup when it has none of ours. */
  lookups: 4,
} as const;

export function ledgerStatusCheckAfterMs(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  if (text === '') return LEDGER_STATUS_DEFAULTS.checkAfterMinutes * 60_000;
  const minutes = Number(text);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error(
      `${LEDGER_CONFIG_KEYS.statusCheckAfterMinutes} must be a whole number of minutes from 1 to 1440.`,
    );
  }
  return minutes * 60_000;
}
