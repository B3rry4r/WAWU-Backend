import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Asks WAWU ID to email a person their export link (SETTINGS-04).
 *
 * WAWU ID owns every address and every email template (its mail service
 * already sends the unpaid-account warning the same way), so the Hub never
 * holds an address and never writes an email. Like those routes, it names the
 * user and the link, and WAWU ID decides the address, the subject and the
 * wording: `POST /internal/users/:userId/data-export`
 * `{ downloadUrl, expiresAt }`. WAWU ID built that route in FIX-53 (BACKEND_GAPS
 * G-131, wawu-id `src/auth/internal.controller.ts`): it answers 200 once the
 * mail is handed to its mailer, 400 for a body that is not exactly the export
 * link and its deadline, 404 for no such account, 409 for an account with no
 * proven address and 503 when its mailer could not take it. Any answer but 200
 * leaves the request pending and the sweep retries; a Hub older than that route
 * got 404 and never sent the email.
 */
@Injectable()
export class DataExportMailer {
  constructor(private readonly config: ConfigService) {}

  async sendLink(
    userWawuId: string,
    downloadUrl: string,
    expiresAt: Date,
  ): Promise<void> {
    const base =
      this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    const serviceKey =
      this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY') ??
      (process.env.NODE_ENV === 'production'
        ? undefined
        : 'dev-internal-service-key-not-secret');
    if (!serviceKey) {
      throw new Error('WAWU_ID_INTERNAL_SERVICE_KEY is not set.');
    }
    const res = await fetch(
      `${base}/internal/users/${encodeURIComponent(userWawuId)}/data-export`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': serviceKey,
        },
        body: JSON.stringify({
          downloadUrl,
          expiresAt: expiresAt.toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(`WAWU ID refused the export email (HTTP ${res.status}).`);
    }
  }
}
