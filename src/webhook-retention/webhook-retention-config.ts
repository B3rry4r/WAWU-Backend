import type {
  FintavaWebhookProcessing,
  NuvionWebhookProcessing,
} from '../../generated/prisma/client';

/**
 * How long a provider's delivery bodies are kept (task FIX-20).
 *
 * `FintavaWebhookEvent` and `NuvionWebhookEvent` hold each signed delivery's
 * raw body and a parsed copy of it: names, account numbers, narrations. Neither
 * table has a person column, so the account purge and the data export cannot
 * find these rows (src/account-purge/account-data-map.ts and
 * src/data-export-request/data-export-sections.ts say so). Retention covers
 * them instead: a daily job (WebhookRetentionService) clears the body and the
 * parsed copy once a delivery is old enough and finished with.
 */

/** Config keys. Not required: the server starts without them. */
export const WEBHOOK_RETENTION_CONFIG_KEYS = {
  days: 'WEBHOOK_RETENTION_DAYS',
} as const;

/**
 * PROVISIONAL(WEBHOOK-RETENTION-DAYS, owner=YOU, why=no ruling says how long a provider delivery body may be kept; 90 days is the lead default and is past Fintava's 72 hour retry horizon and the ledger's 72 hour confirm window)
 *
 * Days a delivery's body is kept, counted from the time it was received.
 * `minDays` and `maxDays` bound the setting only; a value outside them stops
 * the app at boot, like the other timings. 7 days is more than twice the
 * longest a provider retries a delivery (Fintava: every 3 minutes four
 * times, then hourly for 72 hours; Nuvion: 15 minutes).
 *
 * `batch` and `budgetMs` bound one run: at most `batch` rows are cleared by
 * one statement (a transaction of its own, so no lock is held for longer than
 * that statement), and no new batch starts on a table after `budgetMs` (each
 * table has its own budget). What is left is cleared by the next run.
 */
export const WEBHOOK_RETENTION_DEFAULTS = {
  days: 90,
  minDays: 7,
  maxDays: 3650,
  batch: 200,
  budgetMs: 10 * 60_000,
} as const;

/** The daily job: 02:40 server time, named so a spec can find it. */
export const WEBHOOK_RETENTION_SCHEDULE = {
  name: 'webhook-retention',
  cron: '0 40 2 * * *',
} as const;

const DAY_MS = 86_400_000;

/** The retention period in milliseconds, or an Error naming the setting. */
export function webhookRetentionMs(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  if (text === '') return WEBHOOK_RETENTION_DEFAULTS.days * DAY_MS;
  const days = Number(text);
  if (
    !/^[0-9]+$/.test(text) ||
    !Number.isInteger(days) ||
    days < WEBHOOK_RETENTION_DEFAULTS.minDays ||
    days > WEBHOOK_RETENTION_DEFAULTS.maxDays
  ) {
    throw new Error(
      `${WEBHOOK_RETENTION_CONFIG_KEYS.days} must be a whole number of days from ${WEBHOOK_RETENTION_DEFAULTS.minDays} to ${WEBHOOK_RETENTION_DEFAULTS.maxDays}.`,
    );
  }
  return days * DAY_MS;
}

/** The two tables the job clears. */
export type WebhookRetentionTable =
  'FintavaWebhookEvent' | 'NuvionWebhookEvent';

/** Whether a state's body may be cleared once it is old enough, and why. */
export interface WebhookStateRule {
  clear: boolean;
  why: string;
}

/**
 * WHICH STATES ARE CLEARED, AND WHICH ARE HELD (Default (agent), owner may
 * override). A body is cleared only when no reader can still need it. A row
 * in a held state keeps its body whatever its age: the job reports how many
 * such rows are past the period, so they are seen and not forgotten.
 *
 * Typed over each table's enum, so a state added to the schema does not
 * compile until someone says here whether its body may go.
 */
export const WEBHOOK_STATE_RULES: {
  FintavaWebhookEvent: Record<FintavaWebhookProcessing, WebhookStateRule>;
  NuvionWebhookEvent: Record<NuvionWebhookProcessing, WebhookStateRule>;
} = {
  FintavaWebhookEvent: {
    processed: {
      clear: true,
      why: 'The ledger has applied it and nothing reads the body again. The ledger rows keep the references and the figures.',
    },
    pending: {
      clear: false,
      why: 'No consumer has used it yet: the ledger sweep reads its payload, and an event whose consumer is not built yet (cards) waits for it.',
    },
    failed: {
      clear: false,
      why: 'The consumer could not use it, which is a stop for review (a reversal with no debit). The body is the evidence, and nothing marks a review closed. A delivery that disagrees with the ledger is `processed`: its evidence is the ledger row's discrepancy, not the body.',
    },
    unrecognised: {
      clear: false,
      why: 'Kept for review: an event nobody documents is how a real payload format is learned. Nothing marks a review closed.',
    },
  },
  NuvionWebhookEvent: {
    processed: {
      clear: true,
      why: 'Every handler of its event finished with it, and each re-fetches from Nuvion before it acts on money.',
    },
    test: {
      clear: true,
      why: "Nuvion's own test delivery: it carries no data and nothing acts on it.",
    },
    pending: {
      clear: false,
      why: 'A handler has not finished with it: it may be resting after a wait, held by a worker, or an event no handler lists yet. A server on the other provider leaves it for a rollback.',
    },
    failed: {
      clear: false,
      why: 'A handler could not use it: kept for review, with its note. Nothing marks a review closed.',
    },
    unrecognised: {
      clear: false,
      why: "Not one of Nuvion's events (or none): kept for review. Nothing marks a review closed.",
    },
  },
};

/** The states of one table whose body may be cleared. */
export function clearableStates(table: WebhookRetentionTable): string[] {
  return Object.entries(WEBHOOK_STATE_RULES[table])
    .filter(([, rule]) => rule.clear)
    .map(([state]) => state);
}

/** The states of one table whose body is held. */
export function heldStates(table: WebhookRetentionTable): string[] {
  return Object.entries(WEBHOOK_STATE_RULES[table])
    .filter(([, rule]) => !rule.clear)
    .map(([state]) => state);
}

/**
 * EVERY PLACE THAT READS A WEBHOOK EVENT TABLE, AND WHAT IT READS. The
 * retention spec scans the source for any file that touches either table and
 * fails if it is not listed here, or a listed one no longer does. A new reader
 * is added with the states it reads: a reader of a body (`rawBody`,
 * `payload`) must read only rows in a held state, or be a task that changes
 * WEBHOOK_STATE_RULES on purpose.
 */
export interface WebhookTableReader {
  file: string;
  reads: string;
}

export const WEBHOOK_TABLE_READERS: readonly WebhookTableReader[] = [
  {
    file: 'src/fintava/webhook/fintava-webhook.service.ts',
    reads:
      'Writes only: one insert, ON CONFLICT DO NOTHING on bodySha256. Reads nothing back.',
  },
  {
    file: 'src/nuvion/webhook/nuvion-webhook.service.ts',
    reads:
      'Writes only: one insert, ON CONFLICT DO NOTHING on eventId and on (signedAt, bodySha256). Reads nothing back.',
  },
  {
    file: 'src/money/ledger/ledger-consumer.service.ts',
    reads:
      "The ledger sweep: the payload of `pending` rows only, locked and re-checked as `pending` inside the transaction that marks them. Also `wait`'s update of a pending row's note.",
  },
  {
    file: 'src/money/ledger/ledger.service.ts',
    reads:
      'markAbsentFailed: whether any row, in any state, names a reference (dataReference, dataCustomerReference). Columns the job keeps; never the body.',
  },
  {
    file: 'src/nuvion/webhook/nuvion-webhook-dispatcher.service.ts',
    reads:
      'The dispatcher: the payload of `pending` rows only, claimed and re-checked as `pending`. The handlers get the delivery from it and never query the table.',
  },
  {
    file: 'src/nuvion/handlers/reconcile-sweep.ts',
    reads:
      'The NUV-08 sweep: whether any stored delivery of a final event (inflows or outflows) names a transfer id (resourceId and event only, never a body). Columns the job keeps, so a delivery whose body was cleared still counts as held.',
  },
  {
    file: 'src/webhook-retention/webhook-retention.service.ts',
    reads: 'This job: ids and states, to clear and to count the rows it holds.',
  },
  {
    file: 'scripts/fintava/ledger-sandbox-check.ts',
    reads:
      'A sandbox check that prints the state and note of the delivery it just sent.',
  },
];
