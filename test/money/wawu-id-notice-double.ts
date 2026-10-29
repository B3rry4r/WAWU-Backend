import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for WAWU ID's notice route (EMAIL-01):
 * `POST /internal/mail/notice` with `{ wawuId, kind, data, idempotencyKey }`.
 * It checks what the contract says WAWU ID checks (the service key, exactly
 * these four fields, a known kind with exactly its fields, a key of 8 to 128
 * of [A-Za-z0-9_-]), sends once per key (a repeat answers
 * `{ sent: false, replayed: true }`) and records every request. Its field
 * lists are written here from the contract on purpose, apart from the Hub's
 * own, so a drift between the two is a failing test. Nothing leaves this machine.
 */
export const CONTRACT_FIELDS: Record<string, string[]> = {
  pin_changed: ['at'],
  account_deletion_started: ['deleteOn'],
  account_deleted: [],
  money_in: ['amountMinor', 'currency', 'senderName'],
  bank_send_completed: [
    'amountMinor',
    'feeMinor',
    'currency',
    'recipientName',
    'bankName',
    'accountLast4',
    'reference',
  ],
  bank_send_failed: ['amountMinor', 'returnedMinor', 'currency', 'reference'],
  sale_made: ['itemTitle', 'buyerName', 'earnedMinor', 'currency', 'paidWhen'],
  tip_received: ['earnedMinor', 'currency', 'fromName', 'paidWhen'],
  paid_message_received: ['fromName', 'earnedMinor', 'currency', 'replyBy'],
  refund_processed: ['what', 'amountMinor', 'currency', 'returnedTo'],
  purchase_receipt: ['itemTitle', 'paidMinor', 'currency', 'reference'],
  ticket_confirmed: [
    'eventTitle',
    'startsAt',
    'place',
    'paidMinor',
    'currency',
    'ticketRef',
  ],
  event_cancelled: ['eventTitle', 'refundMinor', 'currency'],
  bill_paid: [
    'billerName',
    'customerRef',
    'amountMinor',
    'currency',
    'token',
    'units',
    'reference',
  ],
};

export interface NoticeRequest {
  serviceKey: string | undefined;
  raw: string;
  body: {
    wawuId: string;
    kind: string;
    data: Record<string, unknown>;
    idempotencyKey: string;
  };
}

export class WawuIdNoticeDouble {
  /** Every request that reached the route, valid or not. */
  readonly requests: NoticeRequest[] = [];
  /** The first request of each key, as WAWU ID would have sent it. */
  readonly sent: NoticeRequest[] = [];
  readonly serviceKey = 'notice-double-key';
  /** The next N requests answer this status instead of working (a busy relay). */
  failNext: { count: number; status: number } | null = null;
  private seen = new Set<string>();
  private server: Server | null = null;
  private port = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The requests of one kind for one person. */
  sentTo(wawuId: string, kind?: string): NoticeRequest[] {
    return this.sent.filter(
      (r) =>
        r.body.wawuId === wawuId &&
        (kind === undefined || r.body.kind === kind),
    );
  }

  reset(): void {
    this.requests.length = 0;
    this.sent.length = 0;
    this.seen = new Set();
    this.failNext = null;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        const raw = Buffer.concat(chunks).toString('utf8');
        if (req.method !== 'POST' || req.url !== '/internal/mail/notice') {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        let body: NoticeRequest['body'] | null = null;
        try {
          body = JSON.parse(raw) as NoticeRequest['body'];
        } catch {
          body = null;
        }
        this.requests.push({
          serviceKey: req.headers['x-service-key'] as string | undefined,
          raw,
          body: body as NoticeRequest['body'],
        });
        if (req.headers['x-service-key'] !== this.serviceKey) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        if (this.failNext && this.failNext.count > 0) {
          this.failNext.count -= 1;
          res.statusCode = this.failNext.status;
          res.end('{"message":"busy"}');
          return;
        }
        if (!this.valid(body)) {
          res.statusCode = 400;
          res.end('{"message":"bad notice"}');
          return;
        }
        if (this.seen.has(body.idempotencyKey)) {
          res.statusCode = 200;
          res.end('{"sent":false,"replayed":true}');
          return;
        }
        this.seen.add(body.idempotencyKey);
        this.sent.push(this.requests[this.requests.length - 1]);
        res.statusCode = 202;
        res.end('{"sent":true}');
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(port, '127.0.0.1', () => resolve()),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private valid(
    body: NoticeRequest['body'] | null,
  ): body is NoticeRequest['body'] {
    if (!body || typeof body !== 'object') return false;
    const keys = Object.keys(body).sort().join(',');
    if (keys !== 'data,idempotencyKey,kind,wawuId') return false;
    if (typeof body.wawuId !== 'string' || body.wawuId === '') return false;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(body.idempotencyKey)) return false;
    const fields = CONTRACT_FIELDS[body.kind];
    if (!fields) return false;
    if (typeof body.data !== 'object' || body.data === null) return false;
    return (
      Object.keys(body.data).sort().join(',') === [...fields].sort().join(',')
    );
  }
}
