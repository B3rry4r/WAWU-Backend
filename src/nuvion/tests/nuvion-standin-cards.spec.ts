import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { NUVION_API_VERSION } from '../nuvion-config';
import { NuvionClient } from '../nuvion-client';
import { nuvionWalletId } from '../areas/accounts';
import { NuvionCardsArea } from '../areas/cards';

/**
 * CARD-USE F7: the LOCAL stand-in the test stack runs
 * (scripts/dev/nuvion-standin.cjs) spends on a card the way Nuvion's docs of
 * 29 Oct 2026 say it happens: a single-use card that has taken its one payment
 * is `deactivated` (not `blocked`), and the payment reaches the Hub as
 * `outflows.created` and `outflows.completed` with `payment_type` `card-debit`
 * and the card's id in `card_id`. There is no `cards.*` event for a use, so a
 * stack walk exercises the Hub's outflows path (CARD-USE F1) and not a
 * `cards.frozen` that Nuvion never sends. The status is read through the Hub's
 * own cards area, so what the Hub expects is what the stand-in answers.
 */

const SCRIPT = join(__dirname, '../../../scripts/dev/nuvion-standin.cjs');
const OPERATIONAL = '01STACKOPERATIONAL0000001';
const SECRET = 'spec-cards-secret';

interface Hook {
  event: string;
  data: Record<string, unknown>;
}

describe('CARD-USE F7: the stand-in deactivates a used single-use card and sends the payment as an outflow', () => {
  let guard: OutboundGuard;
  let child: ChildProcess;
  let hooks: Server;
  let base = '';
  const received: Hook[] = [];
  let area: NuvionCardsArea;
  let entity = '';
  let account = '';

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  const make = async (route: '/disposable-cards' | '/virtual-cards') => {
    const made = await call<{ data: { id: string } }>('POST', route, {
      account_id: account,
      entity_id: entity,
      card_name: `wawu-card-${route.slice(1, 5)}${Date.now()}`,
      currency: 'USD',
      cardholder: {
        first_name: 'Ada',
        last_name: 'Tester',
        email: 'ada.tester@example.test',
        phone_number: '+2348012345678',
      },
      expiration_month: '09',
      expiration_year: '28',
    });
    expect(made.status).toBe(201);
    return made.body.data.id;
  };

  const spend = (cardId: string, extra: Record<string, unknown> = {}) =>
    call('POST', '/__standin/card-spend', {
      card_id: cardId,
      amount_cents: 728,
      merchant: 'Acme Corp',
      ...extra,
    });

  const statusOf = async (cardId: string) =>
    (await area.getCard({ walletId: nuvionWalletId(entity, account) }, cardId))
      .status;

  const waitFor = async (what: () => boolean, ms = 6_000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  /** The payments told about a card. */
  const hooksFor = (cardId: string) =>
    received.filter(
      (h) => h.event.startsWith('outflows.') && h.data.card_id === cardId,
    );
  /** The cards.* events about a card, by name. */
  const cardEventsFor = (cardId: string) =>
    received
      .filter((h) => h.event.startsWith('cards.') && h.data.id === cardId)
      .map((h) => h.event);

  beforeAll(async () => {
    guard = guardOutbound();
    hooks = createServer((rq, rs) => {
      const chunks: Buffer[] = [];
      rq.on('data', (c: Buffer) => chunks.push(c));
      rq.on('end', () => {
        received.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as Hook,
        );
        rs.statusCode = 200;
        rs.end('ok');
      });
    });
    const hookPort = await new Promise<number>((resolve) =>
      hooks.listen(0, '127.0.0.1', () => {
        const a = hooks.address();
        resolve(typeof a === 'object' && a !== null ? a.port : 0);
      }),
    );
    child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? '',
        NUVION_STANDIN_PORT: process.env.STANDIN_SPEC_PORT ?? '0',
        HUB_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/hook`,
        NUVION_WEBHOOK_SECRET: SECRET,
        NUVION_FEE_BOOK_TRANSFER: '0',
        NUVION_FEE_BANK_PAYOUT: '2500',
        NUVION_FEE_INFLOW: '0',
        STANDIN_WEBHOOK_DELAY_MS: '20',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    base = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(
        () => reject(new Error('the stand-in did not start')),
        10_000,
      );
      child.stdout?.on('data', (b: Buffer) => {
        out += b.toString();
        const hit = /on 127\.0\.0\.1:(\d+)/.exec(out);
        if (hit) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${hit[1]}`);
        }
      });
      child.once('exit', () =>
        reject(new Error(`the stand-in exited: ${out}`)),
      );
    });
    area = new NuvionCardsArea(
      new NuvionClient(
        {
          baseUrl: base,
          environment: 'standin',
          apiVersion: NUVION_API_VERSION,
          operationalAccountId: OPERATIONAL,
          readTimeoutMs: 5_000,
          moneyTimeoutMs: 5_000,
          checkTimeoutMs: 5_000,
          resendSafetyMs: 60_000,
          retryAfterSeconds: 30,
        },
        'nv_test_sk_CARDSspecKEY0000000000000',
      ),
    );
    const e = await call<{ data: { entity: { id: string } } }>(
      'POST',
      '/individual-entities',
      { name: 'Cards Spec', person: {} },
    );
    entity = e.body.data.entity.id;
    const a = await call<{ data: { account: { id: string } } }>(
      'POST',
      '/accounts',
      { entity_id: entity, type: 'checking', currency: 'NGN' },
    );
    account = a.body.data.account.id;
    await call('POST', '/__standin/fund', {
      account_id: account,
      amount_kobo: 50_000_000,
    });
  });

  afterAll(async () => {
    child?.kill('SIGTERM');
    await new Promise<void>((r) => (hooks ? hooks.close(() => r()) : r()));
    const refused = guard.violations;
    guard.restore();
    expect(refused).toEqual([]);
  });

  it('a spent single-use card reads deactivated, and the payment is two card-debit outflows naming the card, with no cards.* event', async () => {
    const card = await make('/disposable-cards');
    expect(await statusOf(card)).toBe('active');
    const paid = await spend(card);
    expect(paid.status).toBe(201);
    expect(await statusOf(card)).toBe('deactivated');
    await waitFor(() =>
      hooksFor(card).some((h) => h.event === 'outflows.completed'),
    );
    const mine = hooksFor(card);
    expect(mine.map((h) => h.event).sort()).toEqual([
      'outflows.completed',
      'outflows.created',
    ]);
    for (const h of mine) {
      expect(h.data).toMatchObject({
        payment_type: 'card-debit',
        type: 'outflow',
        card_id: card,
        entity_id: entity,
        account_id: account,
      });
    }
    expect(mine.find((h) => h.event === 'outflows.created')?.data.status).toBe(
      'new',
    );
    expect(
      mine.find((h) => h.event === 'outflows.completed')?.data.status,
    ).toBe('successful');
    // Nuvion sends no event for a use: the card's own events are its making and nothing else.
    expect(cardEventsFor(card)).toEqual(['cards.created']);
    // It takes no second payment.
    expect((await spend(card)).status).toBe(400);
  });

  it('a reusable card stays active after a payment, and the payment is told the same way', async () => {
    const card = await make('/virtual-cards');
    expect((await spend(card)).status).toBe(201);
    expect(await statusOf(card)).toBe('active');
    await waitFor(() =>
      hooksFor(card).some((h) => h.event === 'outflows.completed'),
    );
    expect(hooksFor(card)).toHaveLength(2);
    expect(cardEventsFor(card)).toEqual(['cards.created']);
  });
});
