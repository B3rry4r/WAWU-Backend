import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WawuIdDeadline,
  WawuIdTimeoutException,
  wawuIdExchange,
  wawuIdTimeoutMs,
} from './wawu-id-exchange';

/**
 * Outbound client for WAWU ID's internal service-to-service API
 * (conventions.md § Auth model, declared/wawu-id-integration.json).
 * Two actions: elevating a user's verification tier after this backend's own
 * manual review approves a badge-ladder submission, and reading display names
 * and badge tiers in bulk — WAWU ID owns both of those, and a creator list
 * cannot be rendered without them. Behind an interface-shaped class so
 * it's trivially mockable in tests (no real WAWU_ID_INTERNAL_SERVICE_KEY
 * is available in this sandbox — see conventions.md's documented gap).
 *
 * Every call is bounded (FIX-10, wawu-id-exchange.ts): headers and body must
 * both arrive inside the bound or the call is aborted and its socket freed.
 * A lookup that runs out of time is the same empty answer as one WAWU ID
 * failed; a write that does is a `WawuIdTimeoutException`, a 502 carrying the
 * words that write already answers when WAWU ID fails.
 */
/**
 * The dev fallback below is a PUBLICLY KNOWN string. Silently using it in
 * production would authenticate this service to WAWU ID's internal API with a
 * key anyone can read in the repo, so production must fail loudly instead.
 */
function resolveServiceKey(configured: string | undefined): string {
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'WAWU_ID_INTERNAL_SERVICE_KEY is not set. Refusing to start in production with the public development fallback.',
    );
  }
  return 'dev-internal-service-key-not-secret';
}

/** What a write that did not save answers, whether WAWU ID refused it or did not answer. */
const SET_VERIFICATION_FAILED =
  'Your verification could not be saved. Your payment is safe, try again in a moment.';
const UPDATE_NAME_FAILED =
  'Your name could not be saved. Try again in a moment.';

@Injectable()
export class WawuIdClient {
  private readonly logger = new Logger(WawuIdClient.name);
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly readMs: number;
  private readonly writeMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    this.serviceKey = resolveServiceKey(
      this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY'),
    );
    this.readMs = wawuIdTimeoutMs(this.config, 'read');
    this.writeMs = wawuIdTimeoutMs(this.config, 'write');
  }

  /**
   * Display name and badge tier for a set of users.
   *
   * Returns a Map keyed by user id, with unknown ids simply absent — the
   * caller decides what to do about a creator WAWU ID has never heard of,
   * and that is a real case worth distinguishing rather than papering over
   * with a blank name.
   *
   * A failure here returns an EMPTY map rather than throwing. This feeds
   * creator discovery, and identity being briefly unreachable should degrade
   * that list to handles, not take the page down. The caller is written to
   * cope with a missing entry either way, so there is exactly one path to
   * test rather than two.
   */
  async lookupPublicIdentities(userIds: string[]): Promise<
    Map<
      string,
      {
        firstName: string | null;
        lastName: string | null;
        verificationTier: string;
      }
    >
  > {
    const unique = [...new Set(userIds)];
    const out = new Map<
      string,
      {
        firstName: string | null;
        lastName: string | null;
        verificationTier: string;
      }
    >();
    if (unique.length === 0) return out;

    // WAWU ID caps a lookup at 100 ids; chunk rather than silently truncate.
    // One deadline covers every chunk: a stalled WAWU ID costs the bound once,
    // not once per chunk, and the chunks after the stall are not tried.
    const CHUNK = 100;
    const deadline = new WawuIdDeadline(
      'identity lookup',
      this.readMs,
      'WAWU ID did not answer the identity lookup in time.',
    );
    try {
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        try {
          const res = await wawuIdExchange(
            `${this.baseUrl}/internal/users/lookup`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Service-Key': this.serviceKey,
              },
              body: JSON.stringify({ ids: chunk }),
            },
            deadline,
          );
          if (!res.ok) {
            this.logger.warn(
              `WAWU ID identity lookup failed (HTTP ${res.status}); creator names will fall back to handles`,
            );
            continue;
          }
          const body = JSON.parse(res.text) as {
            data?: Array<{
              id?: string;
              firstName?: string | null;
              lastName?: string | null;
              verificationTier?: string;
            }>;
          };
          for (const row of body.data ?? []) {
            if (!row.id) continue;
            out.set(row.id, {
              firstName: row.firstName ?? null,
              lastName: row.lastName ?? null,
              verificationTier: row.verificationTier ?? 'basic',
            });
          }
        } catch (error) {
          if (error instanceof WawuIdTimeoutException) {
            this.logger.warn(
              `WAWU ID identity lookup timed out after ${error.boundMs} ms; creator names will fall back to handles`,
            );
            break;
          }
          this.logger.warn(
            `WAWU ID identity lookup threw; creator names will fall back to handles: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      deadline.end();
    }
    return out;
  }

  /**
   * Writes one of the two ticks at WAWU ID.
   *
   * Identity is the source of truth for whether somebody is verified, so this
   * goes out BEFORE the Hub writes its own mirror columns. The ordering is
   * the same one the old tier elevation used and for the same reason: if the
   * call fails, the Hub has granted nothing and the payment is simply
   * re-verifiable, whereas writing locally first would leave a tick that
   * identity has never heard of and no API path back.
   *
   * A REVOKE is this same call with both dates null. There is no separate
   * DELETE, because "verified until" is the whole state and clearing it is
   * the whole revocation.
   *
   * Errors are RAISED. Somebody has just paid for this; silently keeping the
   * two services out of step would be worse than a retryable failure.
   */
  async setVerification(
    userId: string,
    kind: 'creator' | 'professional',
    dates: { verifiedAt: Date | null; verifiedUntil: Date | null },
  ): Promise<void> {
    const deadline = new WawuIdDeadline(
      'set verification',
      this.writeMs,
      SET_VERIFICATION_FAILED,
    );
    const res = await this.timed(
      deadline,
      `${this.baseUrl}/internal/users/${userId}/verification`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
        },
        /*
          WAWU ID's own shape, confirmed against its UpdateVerificationDto,
          not this backend's internal one.

          Its body is { tick, granted, expiresAt }: `tick` not `kind`, and an
          EXPLICIT `granted` boolean rather than "both dates null means
          revoke". It derives verifiedAt itself on a grant and refuses a
          `verified` field outright, because whether a tick draws is derived
          from the expiry on every read and a caller must not assert it.

          This backend keeps thinking in (verifiedAt, verifiedUntil) because
          that is what its own mirror columns are; the translation happens
          here, at the boundary, and nowhere else. A revoke is verifiedAt ===
          null, which is exactly how writeTick calls it.
        */
        body: JSON.stringify({
          tick: kind,
          granted: dates.verifiedAt !== null,
          expiresAt: dates.verifiedUntil?.toISOString() ?? null,
        }),
      },
    );
    if (!res.ok) {
      this.logger.error(
        `Failed to set ${kind} verification for ${userId}: ${res.status} ${res.text}`,
      );
      throw new BadGatewayException(SET_VERIFICATION_FAILED);
    }
  }

  /**
   * The five-rung ladder's write path.
   *
   * Superseded by setVerification and no longer called by anything that
   * grants a tick. Kept callable because the admin verification-review and
   * professional-review queues still carry ladder submissions that were made
   * before the change, and a half-reviewed queue that cannot be finished is
   * worse than one write path too many.
   */
  async elevateVerificationTier(userId: string, tier: string): Promise<void> {
    const res = await this.timed(
      new WawuIdDeadline(
        'elevate verification tier',
        this.writeMs,
        'WAWU ID did not answer in time. Try again in a moment.',
      ),
      `${this.baseUrl}/internal/users/${userId}/verification-tier`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
        },
        body: JSON.stringify({ tier }),
      },
    );
    if (!res.ok) {
      this.logger.error(
        `Failed to elevate verification tier for ${userId}: ${res.status} ${res.text}`,
      );
      throw new Error('WAWU ID verification-tier update failed');
    }
  }

  /**
   * Updates a user's own name in WAWU ID.
   *
   * Names live there, not here, so this is a proxy for the profile screen's
   * edit. Errors are RAISED rather than swallowed: unlike a best-effort
   * notification, somebody pressing Save on their own name has to be told
   * whether it saved — silently keeping the old one is how a KYC mismatch
   * outlives the attempt to fix it.
   */
  async updateName(
    userId: string,
    parts: { firstName: string; middleName?: string; lastName: string },
  ): Promise<void> {
    const res = await this.timed(
      new WawuIdDeadline('update name', this.writeMs, UPDATE_NAME_FAILED),
      `${this.baseUrl}/internal/users/${userId}/name`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
        },
        body: JSON.stringify(parts),
      },
    );
    if (!res.ok) {
      this.logger.error(
        `Failed to update name for ${userId}: ${res.status} ${res.text}`,
      );
      throw new BadGatewayException(UPDATE_NAME_FAILED);
    }
  }

  /**
   * One bounded write. The deadline ends here whatever happens, and a timeout
   * is logged once with the call and the bound before it goes to the caller.
   */
  private async timed(
    deadline: WawuIdDeadline,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) {
    try {
      return await wawuIdExchange(url, init, deadline);
    } catch (error) {
      if (error instanceof WawuIdTimeoutException) {
        this.logger.error(
          `WAWU ID ${error.call} timed out after ${error.boundMs} ms`,
        );
      }
      throw error;
    } finally {
      deadline.end();
    }
  }
}
