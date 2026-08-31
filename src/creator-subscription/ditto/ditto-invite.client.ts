import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Asks WAWU ID to email a creator their Ditto distribution link.
 *
 * The mail transport lives in WAWU ID (Resend) and this service has none, so
 * the alternative to this call is not "send it from here" — it is not sending
 * it at all. WAWU ID also owns the address and the first name; passing those
 * across just to have them sent back would put a personal email address in
 * this service's request logs for no gain.
 */
function resolveServiceKey(configured: string | undefined): string {
  // Same rule as WawuIdAccountClient: the dev fallback is a publicly known
  // string, so production must fail loudly rather than authenticate with it.
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'WAWU_ID_INTERNAL_SERVICE_KEY is not set. Refusing to start in production with the public development fallback.',
    );
  }
  return 'dev-internal-service-key-not-secret';
}

@Injectable()
export class DittoInviteClient {
  private readonly logger = new Logger(DittoInviteClient.name);
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
   * Returns whether an email actually went out.
   *
   * A failure here is logged and reported as `false`, never thrown. The opt-in
   * itself has already succeeded and the link is shown in the app — failing
   * the whole request because a copy could not be emailed would take the
   * benefit away over the least important half of it.
   */
  async send(
    wawuUserId: string,
    signupUrl: string,
    discountPercent: number,
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/users/${wawuUserId}/ditto-invite`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': this.serviceKey,
          },
          body: JSON.stringify({ signupUrl, discountPercent }),
        },
      );
      if (!res.ok) {
        this.logger.error(
          `Ditto invite email failed for ${wawuUserId}: ${res.status}`,
        );
        return false;
      }
      const body = (await res.json()) as { emailed?: boolean } | { data?: { emailed?: boolean } };
      // WAWU ID wraps responses in an envelope on some routes and not others.
      const emailed =
        (body as { emailed?: boolean }).emailed ??
        (body as { data?: { emailed?: boolean } }).data?.emailed ??
        false;
      return emailed === true;
    } catch (err) {
      this.logger.error(
        `Ditto invite email failed for ${wawuUserId}: ${String(err)}`,
      );
      return false;
    }
  }
}
