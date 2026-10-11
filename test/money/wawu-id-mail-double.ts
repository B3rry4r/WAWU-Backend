import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for WAWU ID's mail route for the nightly check's report
 * (task MONEY-16, BACKEND_GAPS G-680): `POST /internal/users/:userId/money-check-report`.
 * It records who was mailed which facts and the service key that came with
 * them, and can be told to refuse a person (a 404 is what WAWU ID answers
 * until it builds the route). Nothing leaves this machine.
 */
export interface MailedReport {
  userId: string;
  serviceKey: string | undefined;
  body: Record<string, unknown>;
}

export class WawuIdMailDouble {
  readonly mailed: MailedReport[] = [];
  /** User ids the route answers with this status instead of 200. */
  readonly refuse = new Map<string, number>();
  /** Answered to everyone when set. */
  refuseAll: number | null = null;
  private server: Server | null = null;
  private port = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const m = /^\/internal\/users\/([^/]+)\/money-check-report$/.exec(
          req.url ?? '',
        );
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST' || !m) {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        const userId = decodeURIComponent(m[1]);
        const status = this.refuseAll ?? this.refuse.get(userId) ?? 200;
        if (status >= 300) {
          res.statusCode = status;
          res.end(JSON.stringify({ message: 'no' }));
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >;
        } catch {
          body = {};
        }
        this.mailed.push({
          userId,
          serviceKey: req.headers['x-service-key'] as string | undefined,
          body,
        });
        res.end(JSON.stringify({ data: { sent: true } }));
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
}
