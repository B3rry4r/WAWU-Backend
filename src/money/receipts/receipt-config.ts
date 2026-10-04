import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { wholeSetting } from '../pin/pin-reset-config';

/**
 * Settings for receipts (task WALLET-18). None is required: the server
 * starts without any of them.
 */
export const RECEIPT_CONFIG_KEYS = {
  verifyBaseUrl: 'RECEIPT_VERIFY_BASE_URL',
  renderConcurrency: 'RECEIPT_RENDER_CONCURRENCY',
} as const;

/**
 * PROVISIONAL(RECEIPT-RENDER-CONCURRENCY, owner=YOU, why=no ruling names how much of the droplet's memory receipt drawing may take)
 *
 * Receipt images and PDFs drawn at once in this process, whoever asks: a
 * PDF in flight holds about 45 MB, so 2 at once stays near 100 MB over the
 * server's usual size on the 4 GB droplet. A request beyond that waits up
 * to RECEIPT_RENDER_WAIT_MS for a slot, then is answered 503 with
 * Retry-After. Overridable with RECEIPT_RENDER_CONCURRENCY (1 to 8).
 */
export const DEFAULT_RECEIPT_RENDER_CONCURRENCY = 2;

/** How long a drawing request waits for a slot before the busy answer. */
export const RECEIPT_RENDER_WAIT_MS = 10_000;

/**
 * PROVISIONAL(RECEIPT-LOOKUP-LIMITS, owner=YOU, why=no ruling names how often one address may open receipt pages)
 *
 * The public page `GET /r/{code}` answers anyone with a code, so one
 * address may open at most 10 a minute and 60 an hour (on the app's own
 * named throttlers, `short` and `medium`; the global guard counts each
 * route apart). Someone checking the receipts they were sent opens a few;
 * with 2 to the 60th possible codes, 60 an hour per address never finds one
 * by guessing.
 */
export const RECEIPT_LOOKUP_THROTTLE = {
  short: { limit: 10, ttl: 60_000 },
  medium: { limit: 60, ttl: 60 * 60_000 },
};

/**
 * PROVISIONAL(RECEIPT-RENDER-LIMITS, owner=YOU, why=no ruling names how many receipt images and PDFs one person may make)
 *
 * Drawing a receipt as an image or a PDF costs the server a few hundred
 * milliseconds, so one address may ask for at most 10 a minute and 60 an
 * hour on each of the two routes. Sharing a receipt takes one.
 */
export const RECEIPT_RENDER_THROTTLE = {
  short: { limit: 10, ttl: 60_000 },
  medium: { limit: 60, ttl: 60 * 60_000 },
};

/**
 * The address a receipt's code opens, without the code: the public host's
 * `/api/hub/r` (nginx sends the whole host to this server,
 * deploy/install-services.sh). Unset, receipts print `wawu/r/<code>` and
 * `url` is null: the owner names the public host (mobile repo
 * BACKEND_GAPS G-67). Only an https address is taken in production.
 */
@Injectable()
export class ReceiptSettings {
  readonly verifyBaseUrl: string | null;
  readonly renderConcurrency: number;

  constructor(config: ConfigService) {
    this.renderConcurrency = wholeSetting(
      RECEIPT_CONFIG_KEYS.renderConcurrency,
      config.get<string>(RECEIPT_CONFIG_KEYS.renderConcurrency),
      DEFAULT_RECEIPT_RENDER_CONCURRENCY,
      1,
      8,
    );
    this.verifyBaseUrl = verifyBase(
      config.get<string>(RECEIPT_CONFIG_KEYS.verifyBaseUrl),
      config.get<string>('NODE_ENV') === 'production',
    );
  }

  /** The full address of one code's page, or null while no host is set. */
  urlOf(code: string): string | null {
    return this.verifyBaseUrl ? `${this.verifyBaseUrl}/${code}` : null;
  }
}

/** The base as set, without a trailing slash; a value that is not a web address stops the app. */
export function verifyBase(
  raw: string | undefined,
  production: boolean,
): string | null {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  if (v === '') return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(
      `${RECEIPT_CONFIG_KEYS.verifyBaseUrl} must be a web address.`,
    );
  }
  const allowed = production ? ['https:'] : ['https:', 'http:'];
  if (!allowed.includes(url.protocol) || url.search || url.hash) {
    throw new Error(
      `${RECEIPT_CONFIG_KEYS.verifyBaseUrl} must be an ${production ? 'https' : 'http or https'} address with no query.`,
    );
  }
  return v;
}
