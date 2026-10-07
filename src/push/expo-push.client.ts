import { Injectable, Logger } from '@nestjs/common';
import {
  EXPO_RECEIPT_CHUNK,
  EXPO_SEND_CHUNK,
  PUSH_REQUEST_TIMEOUT_MS,
  loadPushSettings,
} from './push-config';
import type { ExpoMessage } from './push-message';

/**
 * One ticket per message, in the order the messages were sent. Shapes are
 * Expo's: `{status:'ok', id}` or `{status:'error', message, details:{error}}`.
 */
export type ExpoTicket =
  | { status: 'ok'; id: string }
  | {
      status: 'error';
      message?: string;
      details?: { error?: string };
    };

export type ExpoReceipt =
  | { status: 'ok' }
  | {
      status: 'error';
      message?: string;
      details?: { error?: string };
    };

/**
 * What came of one send request.
 *
 *  tickets   Expo took the request; one ticket per message, in order.
 *  retry     Expo took nothing (429, 5xx, or no connection): safe to send again.
 *  rejected  Expo refused the request itself (a 4xx): sending it again cannot help.
 *  unknown   No answer in time, or one that cannot be read. Expo may have taken
 *            the messages, so they are never sent again.
 */
export type SendOutcome =
  | { kind: 'tickets'; tickets: ExpoTicket[] }
  | { kind: 'retry'; reason: string; retryAfterSeconds: number | null }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unknown'; reason: string };

export type ReceiptOutcome =
  | { kind: 'receipts'; receipts: Record<string, ExpoReceipt> }
  | { kind: 'failed'; reason: string };

/**
 * Expo's push HTTP API (send and getReceipts), written against its documented
 * shapes and its server SDK (expo-server-sdk 7.2.0 `ExpoClient`, whose
 * constants and error handling this follows). The caller chunks: a send takes
 * at most EXPO_SEND_CHUNK messages, a receipt request at most EXPO_RECEIPT_CHUNK ids.
 *
 * No message, token or response body is ever logged: a token is the address
 * of a phone.
 */
@Injectable()
export class ExpoPushClient {
  private readonly logger = new Logger(ExpoPushClient.name);

  async send(messages: ExpoMessage[]): Promise<SendOutcome> {
    if (messages.length === 0) return { kind: 'tickets', tickets: [] };
    if (messages.length > EXPO_SEND_CHUNK) {
      return { kind: 'rejected', reason: 'chunk_too_large' };
    }
    const res = await this.post('/--/api/v2/push/send', messages);
    if (res.kind !== 'ok') return res;

    const data = (res.body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data) || data.length !== messages.length) {
      return { kind: 'unknown', reason: 'unreadable_answer' };
    }
    return { kind: 'tickets', tickets: data as ExpoTicket[] };
  }

  async getReceipts(ids: string[]): Promise<ReceiptOutcome> {
    if (ids.length === 0) return { kind: 'receipts', receipts: {} };
    if (ids.length > EXPO_RECEIPT_CHUNK) {
      return { kind: 'failed', reason: 'chunk_too_large' };
    }
    const res = await this.post('/--/api/v2/push/getReceipts', { ids });
    if (res.kind === 'ok') {
      const data = (res.body as { data?: unknown } | null)?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { kind: 'failed', reason: 'unreadable_answer' };
      }
      return {
        kind: 'receipts',
        receipts: data as Record<string, ExpoReceipt>,
      };
    }
    return { kind: 'failed', reason: res.reason };
  }

  private async post(
    path: string,
    payload: unknown,
  ): Promise<
    | { kind: 'ok'; body: unknown }
    | { kind: 'retry'; reason: string; retryAfterSeconds: number | null }
    | { kind: 'rejected'; reason: string }
    | { kind: 'unknown'; reason: string }
  > {
    const settings = loadPushSettings();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (settings.accessToken) {
      headers.Authorization = `Bearer ${settings.accessToken}`;
    }

    let response: Response;
    try {
      response = await fetch(`${settings.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { kind: 'unknown', reason: 'timeout' };
      }
      // Nothing reached Expo (refused, DNS, reset before an answer).
      return {
        kind: 'retry',
        reason: 'no_connection',
        retryAfterSeconds: null,
      };
    }

    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }

    if (response.status === 200) {
      const errors = (body as { errors?: unknown[] } | null)?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        return { kind: 'rejected', reason: errorCode(errors[0]) };
      }
      return { kind: 'ok', body };
    }

    if (response.status === 429 || response.status >= 500) {
      const header = Number(response.headers.get('retry-after'));
      return {
        kind: 'retry',
        reason: `http_${response.status}`,
        retryAfterSeconds:
          Number.isFinite(header) && header > 0 ? header : null,
      };
    }

    const errors = (body as { errors?: unknown[] } | null)?.errors;
    const code = Array.isArray(errors)
      ? errorCode(errors[0])
      : `http_${response.status}`;
    if (response.status === 401 || response.status === 403) {
      this.logger.error(
        `Expo refused the push credentials (HTTP ${response.status}). Check EXPO_ACCESS_TOKEN.`,
      );
    }
    return { kind: 'rejected', reason: code };
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_a-z0-9]{1,80}$/.test(code)
    ? code
    : 'expo_error';
}
