import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WawuIdAccountGateway } from './wawu-id-account.gateway';

/**
 * Real implementation of WawuIdAccountGateway, built against WAWU ID's own
 * documented internal deletion pattern (registry.json Account endpoint
 * note: "WAWU ID's own DELETE /internal/users/:userId?mode pattern"),
 * X-Service-Key auth per conventions.md § Auth model.
 *
 * TODO: mock-wawu-id/server.js (this sandbox's local WAWU ID stand-in) does
 * not yet implement this route -- it only implements
 * `PATCH /internal/users/:userId/verification-tier`. No real WAWU ID
 * internal deletion endpoint is reachable in this sandbox (conventions.md's
 * documented local-test-environment gap), so this call is exercised for
 * real wiring/shape but is swapped for a stub via WAWU_ID_ACCOUNT_GATEWAY
 * in contract tests (see tests/account.contract.spec.ts) rather than hit
 * live.
 */
@Injectable()
export class WawuIdAccountClient implements WawuIdAccountGateway {
  private readonly logger = new Logger(WawuIdAccountClient.name);
  private readonly baseUrl: string;
  private readonly serviceKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    this.serviceKey =
      this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY') ?? 'dev-internal-service-key-not-secret';
  }

  async scheduleAccountDeletion(wawuUserId: string): Promise<{ scheduled: boolean }> {
    const res = await fetch(`${this.baseUrl}/internal/users/${wawuUserId}?mode=soft`, {
      method: 'DELETE',
      headers: { 'X-Service-Key': this.serviceKey },
    });
    if (!res.ok) {
      this.logger.error(`WAWU ID account deletion call failed for ${wawuUserId}: ${res.status}`);
      throw new Error('WAWU ID account deletion failed');
    }
    return { scheduled: true };
  }
}
