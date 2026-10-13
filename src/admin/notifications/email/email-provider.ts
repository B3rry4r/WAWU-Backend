import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resendBaseUrl } from './email-config';

export interface ProviderMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  /** Same key on a retry: the provider answers with the first result. */
  idempotencyKey: string;
}

export type ProviderResult =
  { ok: true; id: string } | { ok: false; transient: boolean; error: string };

/**
 * Resend's HTTP API (POST /emails). The only place the Hub talks to the email
 * provider. A timeout, a network error, a 429 and a 5xx are transient (worth a
 * retry); any other answer is the provider refusing this message.
 */
@Injectable()
export class ResendClient {
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
