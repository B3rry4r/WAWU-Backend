import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { historyRow } from './fintava-double';

/**
 * A local stand-in for Fintava's BOOKS, for the nightly check (task MONEY-16):
 * the wallets and WAWU's own account with the balances Fintava reports, and
 * the debits each of them made, served the way the real sandbox serves them
 * (mobile repo `docs/fintava/sandbox/09-`, `10-`, `12-`, `22-`):
 * - `GET /txn?customerId=` lists that customer's own DEBITS, newest first,
 *   `data: { data: [rows], meta }`; money received never appears in it;
 * - `GET /txn/merchant?page=&take=&order=` lists WAWU's own debits, compliance
 *   charges (`BVNCHARGE`) included, `{ data: [rows], meta }`;
 * - `GET /transaction/id/{id}` is the full record, with `merchantComm`;
 * - `GET /customer/wallet/balance/{walletId}` and `GET /merchant/balance`.
 * Pages take up to 100 rows and `meta` reports the counts as strings, as the
 * real ones do. A difference is planted by changing the books on one side
 * only (a debit Fintava has and the ledger lacks, a balance, a merchant
 * charge that never landed). Nothing here reaches the internet.
 */

export interface BooksWallet {
  customerId: string;
  walletId: string;
  accountNumber: string;
  availableKobo: number;
}

export interface BooksDebit {
  id: string;
  createdAt: string;
  amountKobo: number;
  /** The status word as Fintava writes it. */
  status: string;
  /** Our CustomerReference; null on a charge. */
  ourReference: string | null;
  /** Fintava's `reference` (findable by lookup). */
  reference: string;
  tagapayTransRef: string | null;
  sessionId: string;
  transType: string;
  /** The customer who made it, or 'merchant' for WAWU's own account. */
  holder: string;
  /** What the record shows as paid to WAWU's account (`merchantComm`), kobo. */
  merchantCommKobo: number | null;
}

/** Kobo as the naira number Fintava's balances use. */
function nairaNumber(kobo: number): number {
  const rest = Math.abs(kobo) % 100;
  const whole = (Math.abs(kobo) - rest) / 100;
  const n = Number(`${whole}.${String(rest).padStart(2, '0')}`);
  return kobo < 0 ? -n : n;
}

/** Kobo as the naira text a transaction record uses: `"100.00"`. */
function nairaText(kobo: number): string {
  const rest = kobo % 100;
  const whole = (kobo - rest) / 100;
  return `${whole}.${String(rest).padStart(2, '0')}`;
}

export class FintavaBooks {
  readonly wallets = new Map<string, BooksWallet>();
  readonly debits: BooksDebit[] = [];
  merchant = {
    accountNumber: '1102038668',
    accountName: 'Test Account4',
    availableKobo: 0,
  };
  /** Every request seen, `METHOD path`. */
  readonly seen: string[] = [];
  /** Answer the next call to a path prefix with this status, then forget it. */
  readonly fail = new Map<string, number>();
  /** List the oldest debit first, to show a reader that assumes newest first. */
  ascending = false;
  /** Transaction ids the by-id lookup answers `data: null` for, as it does for an unknown id. */
  readonly unknownIds = new Set<string>();
  private server: Server | null = null;
  private port = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/api/dev`;
  }

  addWallet(w: BooksWallet): void {
    this.wallets.set(w.walletId, w);
  }

  addDebit(
    d: Partial<BooksDebit> & Pick<BooksDebit, 'holder' | 'amountKobo'>,
  ): BooksDebit {
    const n = this.debits.length + 1;
    const row: BooksDebit = {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      createdAt: new Date().toISOString(),
      status: 'SUCCESS',
      ourReference: `books-ref-${n}`,
      reference: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
      tagapayTransRef: `tagapay-${n}`,
      sessionId: `09062026${String(n).padStart(14, '0')}`,
      transType: 'AATRANSFER',
      merchantCommKobo: null,
      ...d,
    };
    this.debits.push(row);
    return row;
  }

  private rowOf(d: BooksDebit, full: boolean): Record<string, unknown> {
    const base = historyRow({
      id: d.id,
      createdAt: d.createdAt,
      updatedAt: d.createdAt,
      amount: nairaText(d.amountKobo),
      transType: d.transType,
      entry: 'DEBIT',
      reference: d.reference,
      CustomerReference: d.ourReference,
      status: d.status,
      sessionId: d.sessionId,
      narration: 'books stand-in',
      customer: {
        id: d.holder,
        firstName: '***',
        lastName: '***',
        phoneNumber: '***',
      },
    });
    if (!full) return base;
    return {
      ...base,
      platformComm: null,
      merchantComm:
        d.merchantCommKobo === null ? null : nairaText(d.merchantCommKobo),
      lomaCharge: null,
      tagapayTransRef: d.tagapayTransRef,
      metertoken: null,
      meternumber: null,
      discoRef: null,
    };
  }

  private page(rows: BooksDebit[], page: number, take: number) {
    const sorted = [...rows].sort((a, b) => {
      const newestFirst =
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
      return this.ascending ? -newestFirst : newestFirst;
    });
    const slice = sorted.slice((page - 1) * take, page * take);
    const pageCount = Math.ceil(sorted.length / take);
    return {
      rows: slice.map((d) => this.rowOf(d, false)),
      meta: {
        page: String(page),
        take: String(take),
        itemCount: sorted.length,
        pageCount,
        hasPreviousPage: page > 1,
        hasNextPage: page < pageCount,
      },
    };
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/^\/api\/dev/, '');
      this.seen.push(`${req.method ?? 'GET'} ${path}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify(body));
      };
      for (const [prefix, status] of this.fail) {
        if (path.startsWith(prefix)) {
          this.fail.delete(prefix);
          send(status, {
            status,
            timestamp: new Date().toISOString(),
            message: ['Planted failure'],
            path,
          });
          return;
        }
      }
      const q = url.searchParams;
      const pageNo = Math.max(1, Number(q.get('page') ?? '1'));
      const take = Math.min(100, Math.max(1, Number(q.get('take') ?? '10')));
      let m: RegExpExecArray | null;
      if (path === '/txn') {
        const customerId = q.get('customerId') ?? '';
        if (
          ![...this.wallets.values()].some((w) => w.customerId === customerId)
        ) {
          send(404, {
            status: 404,
            timestamp: new Date().toISOString(),
            message: ['Customer not found'],
            path,
          });
          return;
        }
        const p = this.page(
          this.debits.filter((d) => d.holder === customerId),
          pageNo,
          take,
        );
        send(200, {
          data: { data: p.rows, meta: p.meta },
          status: 200,
          message: 'Customer transactions fetched',
        });
        return;
      }
      if (path === '/txn/merchant') {
        const p = this.page(
          this.debits.filter((d) => d.holder === 'merchant'),
          pageNo,
          take,
        );
        send(200, { data: p.rows, meta: p.meta });
        return;
      }
      if ((m = /^\/transaction\/id\/([^/]+)$/.exec(path))) {
        const id = decodeURIComponent(m[1]);
        const d = this.unknownIds.has(id)
          ? undefined
          : this.debits.find((x) => x.id === id);
        send(
          200,
          d
            ? { data: this.rowOf(d, true), status: 200, message: 'successful' }
            : { data: null, status: 200, message: 'successful' },
        );
        return;
      }
      if ((m = /^\/customer\/wallet\/balance\/([^/]+)$/.exec(path))) {
        const w = this.wallets.get(decodeURIComponent(m[1]));
        if (!w) {
          send(400, {
            status: 400,
            timestamp: new Date().toISOString(),
            message: ['Wallet not found'],
            path,
          });
          return;
        }
        send(200, {
          data: {
            balance: {
              bookedBalance: nairaNumber(w.availableKobo),
              availableBalance: nairaNumber(w.availableKobo),
            },
            tier: 'TIER_2',
          },
          status: 200,
          message: 'Wallet details fetched',
        });
        return;
      }
      if (path === '/merchant/balance') {
        send(200, {
          data: {
            accountName: this.merchant.accountName,
            accountNumber: this.merchant.accountNumber,
            balance: {
              bookedBalance: nairaNumber(this.merchant.availableKobo),
              availableBalance: nairaNumber(this.merchant.availableKobo),
            },
            tier: 'TIER_3',
          },
          status: 200,
          message: 'successful',
        });
        return;
      }
      send(404, {
        status: 404,
        timestamp: new Date().toISOString(),
        message: ['Cannot route this in the books stand-in'],
        path,
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(port, '127.0.0.1', () => resolve()),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }
}
