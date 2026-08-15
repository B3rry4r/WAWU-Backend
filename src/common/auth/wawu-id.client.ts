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
@Injectable()
export class WawuIdClient {
  private readonly logger = new Logger(WawuIdClient.name);
  private readonly baseUrl: string;
  private readonly serviceKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    this.serviceKey = this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY') ?? 'dev-internal-service-key-not-secret';
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
