import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  OtpResetCode,
  OtpSender,
} from '../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../wallet-provider/wallet-provider-error';

/**
 * How long WAWU ID is waited for. Not a fee, a limit or a promise: an
 * email request that takes longer is treated as maybe sent.
 */
export const NUVION_OTP_EMAIL_TIMEOUT_MS = 10_000;

/** The development key WAWU ID's internal routes accept outside production. */
const DEV_SERVICE_KEY = 'dev-internal-service-key-not-secret';

/** The WAWU ID route this sender asks to email the code (BACKEND_GAPS G-400). */
export function pinResetEmailPath(wawuUserId: string): string {
  return `/internal/users/${encodeURIComponent(wawuUserId)}/pin-reset-code`;
}

/**
 * The PIN reset code under WALLET_PROVIDER=nuvion (task NUV-01, R-39: no
 * SMS, codes go by email): an email to the person's account address, sent
 * by WAWU ID, never a text.
 *
 * The Hub holds no email address and writes no email (the same rule as the
 * data export's mailer, SETTINGS-04): it names the person and the code, and
 * WAWU ID, which owns every address and template, picks the address, the
 * subject and the words (`POST /internal/users/:userId/pin-reset-code`
 * `{ code, expiresInMinutes }`, behind the internal service key). That
 * route is WAWU ID's to add (BACKEND_GAPS G-400); while WAWU ID answers 404
 * the code is not sent, the reset answers 503 and its code never works.
 *
 * Outcomes, as the PIN reset reads them (MONEY-14): 2xx is sent; a refusal
 * (any 4xx) or no connection is not sent (the code never works, the email
 * is not counted); a timeout or a 5xx may have been sent
 * (`outcome_unknown`: the code stays usable until Resend opens). The code
 * is never logged.
 */
export class NuvionOtpSender implements OtpSender {
  readonly channel = 'email' as const;
  private readonly logger = new Logger(NuvionOtpSender.name);
  private readonly baseUrl: string;
  readonly #serviceKey: string;

  constructor(config: ConfigService) {
    this.baseUrl = (
      config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001'
    ).replace(/\/+$/, '');
    this.#serviceKey =
      config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY')?.trim() ||
      (process.env.NODE_ENV === 'production' ? '' : DEV_SERVICE_KEY);
  }

  get configured(): boolean {
    return this.#serviceKey !== '';
  }

  /** No SMS under Nuvion (R-39): nothing is sent. */
  sendText(): Promise<void> {
    return Promise.reject(
      new WalletProviderError({
        kind: 'not_supported',
        provider: 'nuvion',
        operation: 'send text',
        messages: ['codes go by email under Nuvion'],
        recordMayExist: false,
      }),
    );
  }

  async sendResetCode(input: OtpResetCode): Promise<void> {
    const op = 'email PIN reset code';
    const fail = (
      kind: 'not_configured' | 'refused' | 'unavailable' | 'outcome_unknown',
      httpStatus: number | null,
      why: string,
    ) => {
      this.logger.warn(
        `${op}: ${kind}${httpStatus === null ? '' : ` HTTP ${httpStatus}`} (${why})`,
      );
      return new WalletProviderError({
        kind,
        provider: 'nuvion',
        operation: op,
        httpStatus,
        messages: [why],
      });
    };
    if (!this.configured) {
      throw fail('not_configured', null, 'no internal service key');
    }
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}${pinResetEmailPath(input.wawuUserId)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': this.#serviceKey,
          },
          body: JSON.stringify({
            code: input.code,
            expiresInMinutes: input.minutes,
          }),
          signal: AbortSignal.timeout(NUVION_OTP_EMAIL_TIMEOUT_MS),
          redirect: 'error',
        },
      );
    } catch (e) {
      const timedOut = (e as { name?: unknown }).name === 'TimeoutError';
      throw timedOut
        ? fail('outcome_unknown', null, 'WAWU ID did not answer in time')
        : fail('unavailable', null, 'WAWU ID could not be reached');
    }
    // The answer's body says nothing we use; drop it.
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) {
      this.logger.log(`${op}: sent`);
      return;
    }
    if (res.status >= 500) {
      throw fail('outcome_unknown', res.status, 'WAWU ID failed while sending');
    }
    throw fail('refused', res.status, 'WAWU ID did not send the email');
  }
}
