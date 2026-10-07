import { createServer, type IncomingMessage, type Server } from 'http';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';

/**
 * A STAND-IN for Expo's push HTTP API, on this machine. It is not Expo and
 * proves nothing about Expo: exp.host and api.expo.dev answer 403 from this
 * sandbox's egress policy, so no real response could be captured. Every shape
 * it answers with is quoted from Expo's server SDK (expo-server-sdk 7.2.0,
 * `ExpoClient.d.ts` and `ExpoClient.js`), which is Expo's own description of
 * its wire format:
 *
 *   send         POST /--/api/v2/push/send        body: messages[]  -> {data: ticket[]}
 *                ticket: {status:'ok', id} | {status:'error', message, details:{error}}
 *   getReceipts  POST /--/api/v2/push/getReceipts body: {ids}       -> {data: {[id]: receipt}}
 *                receipt: {status:'ok'} | {status:'error', message, details:{error}}
 *   failure      {errors:[{code, message}]} with a non-200 status
 *
 * A test that says "Expo" in its title means this stand-in.
 */
export interface StandInMessage {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  ttl?: number;
}

export interface StandInRequest {
  path: string;
  headers: IncomingMessage['headers'];
  json: unknown;
}

export type SendBehaviour = (messages: StandInMessage[]) => {
  status: number;
  body: unknown;
  delayMs?: number;
};

export class ExpoStandIn {
  private server: Server | null = null;
  readonly requests: StandInRequest[] = [];
  /** Receipt ids -> the receipt the stand-in will answer with. Ids it has none for are left out, as Expo does. */
  readonly receipts = new Map<string, unknown>();
  /** Ticket id -> the message it was issued for. */
  readonly ticketMessages = new Map<string, StandInMessage>();
  /** Override per token: the ticket error the send answers with (default: ok). */
  readonly ticketErrors = new Map<string, string>();
  sendBehaviour: SendBehaviour | null = null;
  port = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void this.handle(req, Buffer.concat(chunks).toString('utf8'), res);
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.receipts.clear();
    this.ticketMessages.clear();
    this.ticketErrors.clear();
    this.sendBehaviour = null;
  }

  sendRequests(): StandInRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/push/send'));
  }

  receiptRequests(): StandInRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/push/getReceipts'));
  }

  /** Every message the stand-in was asked to send, in order. */
  sentMessages(): StandInMessage[] {
    return this.sendRequests().flatMap((r) => r.json as StandInMessage[]);
  }

  private async handle(
    req: IncomingMessage,
    raw: string,
    res: import('http').ServerResponse,
  ): Promise<void> {
    const json: unknown = raw ? JSON.parse(raw) : null;
    this.requests.push({ path: req.url ?? '', headers: req.headers, json });
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.url?.endsWith('/push/send')) {
      const messages = json as StandInMessage[];
      if (this.sendBehaviour) {
        const out = this.sendBehaviour(messages);
        if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
        return reply(out.status, out.body);
      }
      const tickets = messages.map((m) => {
        const error = this.ticketErrors.get(m.to);
        if (error) {
          return {
            status: 'error',
            message: `"${m.to}" is not a registered push notification recipient`,
            details: { error },
          };
        }
        const id = randomUUID();
        this.ticketMessages.set(id, m);
        return { status: 'ok', id };
      });
      return reply(200, { data: tickets });
    }

    if (req.url?.endsWith('/push/getReceipts')) {
      const ids = (json as { ids: string[] }).ids;
      const data: Record<string, unknown> = {};
      for (const id of ids) {
        if (this.receipts.has(id)) data[id] = this.receipts.get(id);
      }
      return reply(200, { data });
    }
    return reply(404, {
      errors: [{ code: 'NOT_FOUND', message: 'no such path' }],
    });
  }
}

/** The answers Expo gives, named once so a test reads as the case it is. */
export const EXPO_SHAPES = {
  ok: { status: 'ok' },
  deviceNotRegistered: (token: string) => ({
    status: 'error',
    message: `"${token}" is not a registered push notification recipient`,
    details: { error: 'DeviceNotRegistered', expoPushToken: token },
  }),
  messageTooBig: {
    status: 'error',
    message: 'Message too big',
    details: { error: 'MessageTooBig' },
  },
  rateLimited: {
    errors: [{ code: 'TOO_MANY_REQUESTS', message: 'Too many requests' }],
  },
  badRequest: {
    errors: [{ code: 'VALIDATION_ERROR', message: 'Invalid request' }],
  },
};
