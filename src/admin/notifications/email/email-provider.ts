import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RELAY_TIMEOUT_MS,
  relayBaseUrl,
  relayServiceKey,
  resendBaseUrl,
} from './email-config';

export interface ProviderMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  /** Same key on a retry: the provider answers with the first result. */
  idempotencyKey: string;
  /** The campaign id, kept on the provider's record of the mail (relay only). */
  tag?: string;
  /**
   * Files that travel with the mail, `content` as base64 (a statement,
   * WALLET-35). Sent by the relay and by Resend; a campaign has none.
   */
  attachments?: Array<{
    filename: string;
    content: string;
    contentType: string;
  }>;
}

export type ProviderResult =
  { ok: true; id: string } | { ok: false; transient: boolean; error: string };

/** Where one mail goes out: Resend directly, or WAWU ID's relay. */
export interface EmailTransport {
  send(message: ProviderMessage): Promise<ProviderResult>;
}

/**
 * Resend's HTTP API (POST /emails), used only when the Hub itself has a
 * RESEND_API_KEY. A timeout, a network error, a 429 and a 5xx are transient (worth a
 * retry); any other answer is the provider refusing this message.
 */
@Injectable()
export class ResendClient implements EmailTransport {
  constructor(private readonly config: ConfigService) {}

  apiKey(): string | undefined {
    const key = this.config.get<string>('RESEND_API_KEY')?.trim();
    return key ? key : undefined;
  }

  async send(message: ProviderMessage): Promise<ProviderResult> {
    const key = this.apiKey();
    if (!key)
      return {
        ok: false,
        transient: false,
        error: 'RESEND_API_KEY is not set.',
      };
    let response: Response;
    try {
      response = await fetch(`${resendBaseUrl(this.config)}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: message.headers,
          ...(message.attachments
            ? {
                attachments: message.attachments.map((a) => ({
                  filename: a.filename,
                  content: a.content,
                })),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return {
        ok: false,
        transient: true,
        error: `Could not reach the email provider (${e instanceof Error ? e.name : 'error'}).`,
      };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const id =
      body &&
      typeof body === 'object' &&
      typeof (body as { id?: unknown }).id === 'string'
        ? (body as { id: string }).id
        : null;
    if (response.ok && id) return { ok: true, id };
    const message_ =
      body &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `The email provider answered ${response.status}.`;
    return {
      ok: false,
      transient:
        response.status === 429 ||
        response.status >= 500 ||
        (response.ok && !id),
      error: message_.slice(0, 300),
    };
  }
}

/**
 * WAWU ID's mail relay (EMAIL-02, `POST /internal/mail/send`), the default way
 * a campaign goes out: WAWU ID already sends email with its own Resend key, so
 * the Hub needs none. WAWU ID's MAIL_FROM is the From line, always; the
 * message's `from` is not sent. Reached with WAWU_ID_BASE_URL and the shared
 * WAWU_ID_INTERNAL_SERVICE_KEY.
 *
 * What a retry is worth: a timeout, a network error, a 503 (the provider was
 * busy or WAWU ID had no mail key at that moment) and any other 5xx (a proxy's
 * 502 or 504 while WAWU ID restarts) are transient. A 400 (a bad address), a
 * 401 (the key), a 429 (WAWU ID's daily cap, which waiting a second does not
 * lift) and every other answer are the relay refusing this message.
 */
@Injectable()
export class WawuIdMailRelay implements EmailTransport {
  constructor(private readonly config: ConfigService) {}

  /** True when both the address and the key are set on this server. */
  configured(): boolean {
    return Boolean(relayBaseUrl(this.config) && relayServiceKey(this.config));
  }

  async send(message: ProviderMessage): Promise<ProviderResult> {
    const base = relayBaseUrl(this.config);
    const key = relayServiceKey(this.config);
    if (!base || !key) {
      return {
        ok: false,
        transient: false,
        error: 'WAWU ID is not set up as the email sender on this server.',
      };
    }
    let response: Response;
    try {
      response = await fetch(`${base}/internal/mail/send`, {
        method: 'POST',
        headers: {
          'X-Service-Key': key,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: message.headers,
          ...(message.tag ? { tag: message.tag } : {}),
          ...(message.attachments ? { attachments: message.attachments } : {}),
        }),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch (e) {
      return {
        ok: false,
        transient: true,
        error: `Could not reach WAWU ID (${e instanceof Error ? e.name : 'error'}).`,
      };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const id =
      body &&
      typeof body === 'object' &&
      typeof (body as { id?: unknown }).id === 'string'
        ? (body as { id: string }).id
        : null;
    if (response.ok && id) {
      // A relay from before WALLET-35 drops `attachments` (its body whitelist)
      // and still answers 200 { id }: the mail goes out with no file. So a mail
      // that carries files is sent only when the relay says how many it took,
      // and the number is the one sent. A mail with no files has nothing to
      // confirm and is judged exactly as before.
      const sentFiles = message.attachments?.length ?? 0;
      if (sentFiles > 0) {
        const took =
          body &&
          typeof body === 'object' &&
          typeof (body as { attachments?: unknown }).attachments === 'number'
            ? (body as { attachments: number }).attachments
            : null;
        if (took !== sentFiles) {
          return {
            ok: false,
            transient: false,
            error: `WAWU ID did not confirm the file (sent ${sentFiles}, it took ${took ?? 'none'}).`,
          };
        }
      }
      return { ok: true, id };
    }
    const said =
      body &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : null;
    const error =
      response.status === 401
        ? 'WAWU ID refused the service key.'
        : (said ?? `WAWU ID answered ${response.status}.`);
    return {
      ok: false,
      transient: response.status >= 500 || (response.ok && !id),
      error: error.slice(0, 300),
    };
  }
}
