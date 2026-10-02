/**
 * The ledger's timings (task MONEY-10). Each is overridable in config.
 */

/** Config keys. None is required: the server starts without any of them. */
export const LEDGER_CONFIG_KEYS = {
  confirmWindowHours: 'LEDGER_CONFIRM_WINDOW_HOURS',
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
