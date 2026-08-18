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
export class WawuIdAccountClient implements WawuIdAccountGateway {
  private readonly logger = new Logger(WawuIdAccountClient.name);
  private readonly baseUrl: string;
  private readonly serviceKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    this.serviceKey =
      resolveServiceKey(this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY'));
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
