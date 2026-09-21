import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Outbound client for WAWU ID's internal service-to-service API
 * (conventions.md § Auth model, declared/wawu-id-integration.json).
 * Two actions: elevating a user's verification tier after this backend's own
 * manual review approves a badge-ladder submission, and reading display names
 * and badge tiers in bulk — WAWU ID owns both of those, and a creator list
 * cannot be rendered without them. Behind an interface-shaped class so
 * it's trivially mockable in tests (no real WAWU_ID_INTERNAL_SERVICE_KEY
 * is available in this sandbox — see conventions.md's documented gap).
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

@Injectable()
export class WawuIdClient {
  private readonly logger = new Logger(WawuIdClient.name);
  private readonly baseUrl: string;
  private readonly serviceKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    this.serviceKey = resolveServiceKey(
      this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY'),
    );
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
    const CHUNK = 100;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      try {
        const res = await fetch(`${this.baseUrl}/internal/users/lookup`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': this.serviceKey,
          },
          body: JSON.stringify({ ids: chunk }),
        });
        if (!res.ok) {
          this.logger.warn(
            `WAWU ID identity lookup failed (HTTP ${res.status}); creator names will fall back to handles`,
          );
          continue;
        }
        const body = (await res.json()) as {
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
        this.logger.warn(
          `WAWU ID identity lookup threw; creator names will fall back to handles: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
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
    const res = await fetch(
      `${this.baseUrl}/internal/users/${userId}/verification`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
        },
        body: JSON.stringify({
          kind,
          verifiedAt: dates.verifiedAt?.toISOString() ?? null,
          verifiedUntil: dates.verifiedUntil?.toISOString() ?? null,
        }),
      },
    );
    if (!res.ok) {
      this.logger.error(
        `Failed to set ${kind} verification for ${userId}: ${res.status} ${await res.text()}`,
      );
      throw new BadGatewayException(
        'Your verification could not be saved. Your payment is safe, try again in a moment.',
      );
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
    const res = await fetch(
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
        `Failed to elevate verification tier for ${userId}: ${res.status} ${await res.text()}`,
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
    const res = await fetch(`${this.baseUrl}/internal/users/${userId}/name`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': this.serviceKey,
      },
      body: JSON.stringify(parts),
    });
    if (!res.ok) {
      this.logger.error(
        `Failed to update name for ${userId}: ${res.status} ${await res.text()}`,
      );
      throw new BadGatewayException('Your name could not be saved. Try again in a moment.');
    }
  }
}
