import { Logger } from '@nestjs/common';
import { MoviePartnerError } from '../movie-partner/movie-partner.interface';
import {
  environmentOfKey,
  type FlixoraEnvironment,
  type FlixoraSettings,
} from './flixora-settings';

/** The partner answers within this, or the call is treated as unavailable. */
export const FLIXORA_TIMEOUT_MS = 15_000;
/** Below this many requests left in the partner's 15 minute window, the client waits for the reset instead of spending the last ones (the limit is 1,000). */
export const FLIXORA_LOW_WATER = 25;
/** A 429 with no hint pauses calls this long. */
const DEFAULT_PAUSE_SECONDS = 60;
/** No pause is longer than the partner's own window. */
const MAX_PAUSE_SECONDS = 15 * 60;

export type FetchLike = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface FlixoraAnswer {
  /** 200 with a JSON body, or 404 with `json: null`: every other status throws. */
  status: 200 | 404;
  json: unknown;
  environment: string | null;
}

export interface FlixoraClientOptions {
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * The Flixora partner API over HTTPS (FLIX-02), server side only. It sends the
 * key in `x-partner-key` and nothing else about the Hub, reads the
 * `X-Flixora-Environment` header on every answer, and turns each failure into
 * a plain `MoviePartnerError`. A message or a log line never holds the key,
 * a response body, a token or a link: only the status and the path.
 *
 * `rejected`: Flixora refused (401 a bad or revoked key, 403 not approved or
 * switched off, other 4xx): trying again will not help. `unavailable`: 429,
 * 5xx, no answer, a reply that is not JSON, or a pause to stay under the
 * 1,000 requests per 15 minutes limit: trying later may work.
 */
export class FlixoraClient {
  private readonly logger = new Logger('Flixora');
  private readonly doFetch: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly expected: FlixoraEnvironment | null;
  private pausedUntil = 0;

  constructor(
    private readonly settings: Pick<FlixoraSettings, 'apiBaseUrl' | 'apiKey'>,
    options: FlixoraClientOptions = {},
  ) {
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? FLIXORA_TIMEOUT_MS;
    this.expected = environmentOfKey(settings.apiKey);
  }

  /** GET `path` (for example `/v1/movies`) with the query. A 404 is an answer (`status: 404`); everything else that is not 200 throws. */
  async get(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<FlixoraAnswer> {
    const waitMs = this.pausedUntil - this.now();
    if (waitMs > 0) {
      throw new MoviePartnerError(
        'unavailable',
        `The movie partner's request limit is reached, so no call is made for another ${Math.ceil(waitMs / 1000)} seconds.`,
      );
    }

    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) params.set(name, String(value));
    }
    const qs = params.toString();
    const url = `${this.settings.apiBaseUrl}${path}${qs === '' ? '' : `?${qs}`}`;

    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      res = await this.doFetch(url, {
        method: 'GET',
        headers: {
          'x-partner-key': this.settings.apiKey,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      text = await res.text();
    } catch (err) {
      // The error may quote the address or headers: log only its kind.
      this.logger.warn(
        `Flixora did not answer GET ${path}: ${err instanceof Error ? err.name : 'error'}.`,
      );
      throw new MoviePartnerError(
        'unavailable',
        'The movie partner did not answer.',
      );
    }

    this.noteLimit(res.headers);
    const environment = res.headers.get('x-flixora-environment');
    if (
      environment !== null &&
      this.expected !== null &&
      environment.toLowerCase() !== this.expected
    ) {
      this.logger.error(
        `Flixora answered from the "${environment}" environment but the key belongs to "${this.expected}". The answer was not used.`,
      );
      throw new MoviePartnerError(
        'rejected',
        'The movie partner answered from a different environment than the key belongs to.',
      );
    }

    if (res.status === 200) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        this.logger.warn(`Flixora answered GET ${path} with a non-JSON body.`);
        throw new MoviePartnerError(
          'unavailable',
          'The movie partner sent an answer the Hub could not read.',
        );
      }
      return { status: 200, json, environment };
    }
    if (res.status === 404) return { status: 404, json: null, environment };

    this.logger.warn(`Flixora answered ${res.status} to GET ${path}.`);
    throw this.errorFor(res.status, res.headers);
  }

  private errorFor(
    status: number,
    headers: { get(name: string): string | null },
  ): MoviePartnerError {
    if (status === 401) {
      return new MoviePartnerError(
        'rejected',
        'The movie partner did not accept the Hub key. Check FLIXORA_API_KEY.',
      );
    }
    if (status === 403) {
      return new MoviePartnerError(
        'rejected',
        'The movie partner has not approved this account yet, or has switched it off.',
      );
    }
    if (status === 429) {
      const hinted = Number(
        headers.get('retry-after') ?? headers.get('ratelimit-reset'),
      );
      const seconds =
        Number.isFinite(hinted) && hinted > 0
          ? Math.min(hinted, MAX_PAUSE_SECONDS)
          : DEFAULT_PAUSE_SECONDS;
      this.pausedUntil = this.now() + seconds * 1000;
      return new MoviePartnerError(
        'unavailable',
        'The movie partner asked the Hub to slow down. Calls wait until its limit resets.',
      );
    }
    if (status >= 500) {
      return new MoviePartnerError(
        'unavailable',
        'The movie partner had a fault.',
      );
    }
    return new MoviePartnerError(
      'rejected',
      'The movie partner did not accept the request.',
    );
  }

  /** Stops calling when the window's last requests are all that is left, until it resets. */
  private noteLimit(headers: { get(name: string): string | null }): void {
    const left = Number(headers.get('ratelimit-remaining'));
    const reset = Number(headers.get('ratelimit-reset'));
    if (
      headers.get('ratelimit-remaining') !== null &&
      Number.isFinite(left) &&
      left <= FLIXORA_LOW_WATER
    ) {
      const seconds =
        Number.isFinite(reset) && reset > 0
          ? Math.min(reset, MAX_PAUSE_SECONDS)
          : DEFAULT_PAUSE_SECONDS;
      this.pausedUntil = Math.max(
        this.pausedUntil,
        this.now() + seconds * 1000,
      );
    }
  }
}
