import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Outbound client for WAWU ID's internal service-to-service API
 * (conventions.md § Auth model, declared/wawu-id-integration.json).
 * Currently exposes only the one action this backend needs: elevating a
 * user's verification tier after this backend's own manual review
 * approves a badge-ladder submission. Behind an interface-shaped class so
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
    this.baseUrl = this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    this.serviceKey = resolveServiceKey(this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY'));
  }

  async elevateVerificationTier(userId: string, tier: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/users/${userId}/verification-tier`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': this.serviceKey,
      },
      body: JSON.stringify({ tier }),
    });
    if (!res.ok) {
      this.logger.error(`Failed to elevate verification tier for ${userId}: ${res.status} ${await res.text()}`);
      throw new Error('WAWU ID verification-tier update failed');
    }
  }
}
