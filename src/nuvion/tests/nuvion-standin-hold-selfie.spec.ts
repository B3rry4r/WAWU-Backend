import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { NUVION_API_VERSION } from '../nuvion-config';
import { NuvionClient } from '../nuvion-client';
import {
  linkLivenessCalls,
  readLivenessCalls,
  startLivenessCalls,
} from '../areas/liveness';

/**
 * ME-13 L3 and FIX-47 L2: the LOCAL stand-in that the test stack runs
 * (scripts/dev/nuvion-standin.cjs) has two more things a verifier needs.
 *
 * - A hold switch (`POST /__standin/hold`): while it is on, a book transfer
 *   into WAWU's operational account (what a paid tier sends) stays pending
 *   and is not settled by itself; `POST /__standin/release` settles it
 *   through the normal path, the signed `outflows.completed` webhook. That
 *   is how the app's "Paid, still confirming" (M15) is walked on a stack.
 * - A hosted selfie: `POST /kyc/liveness/sessions`, `GET
 *   /kyc/liveness/sessions/{id}`, the entity link and the page the session's
 *   address opens, read here through the Hub's own liveness area
 *   (`src/nuvion/areas/liveness.ts`), so what the Hub expects is what the
 *   stand-in answers. No image is received.
 *
 * The script is started as a child process on a loopback port; the webhook
 * target is a loopback server of this spec. No host but loopback.
 */

const SCRIPT = join(__dirname, '../../../scripts/dev/nuvion-standin.cjs');
const OPERATIONAL = '01STACKOPERATIONAL0000001';
const SECRET = 'spec-hold-selfie-secret';
const ORIGIN = 'https://verify.example.invalid';

interface Answer<T> {
  status: number;
  body: T;
  type: string;
}
interface Hook {
  event: string;
  data: { id: string; status: string };
  signature: string;
  timestamp: string;
  raw: string;
}

describe('ME-13 L3, FIX-47 L2: the stand-in holds a payment pending and hosts a selfie', () => {
  let guard: OutboundGuard;
  let child: ChildProcess;
  let hooks: Server;
  let base = '';
  const received: Hook[] = [];
  let client: NuvionClient;
  let entity = '';
  let payer = '';
  let payerEntity = '';

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    form?: string,
  ): Promise<Answer<T>> {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type':
          form === undefined
            ? 'application/json'
            : 'application/x-www-form-urlencoded',
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    return {
      status: res.status,
      body: (type.includes('json') ? JSON.parse(text) : text) as T,
      type,
    };
  }

  const buy = (reference: string, narration = 'WAWU purchase') =>
    call<{ data: { id: string; status: string; applicable_fee: number } }>(
      'POST',
      '/transfers',
      {
        account_id: payer,
        entity_id: payerEntity,
        unique_reference: reference,
        amount: 100_000,
        currency: 'NGN',
        payment_type: 'book-transfer',
        nuvion_ban: operationalBan,
        narration,
      },
    );
  let operationalBan = '';

  const statusOf = async (id: string) =>
    (
      await call<{ transfers: { id: string; status: string }[] }>(
        'GET',
        '/__standin/state',
      )
    ).body.transfers.find((t) => t.id === id)?.status;

  const waitFor = async (what: () => boolean, ms = 6_000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    guard = guardOutbound();
    hooks = createServer((rq, rs) => {
      const chunks: Buffer[] = [];
      rq.on('data', (c: Buffer) => chunks.push(c));
      rq.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(raw) as {
          event: string;
          data: Hook['data'];
        };
        received.push({
          event: parsed.event,
          data: parsed.data,
          signature: String(rq.headers['x-nuvion-event-signature']),
          timestamp: String(rq.headers['x-nuvion-event-timestamp']),
          raw,
        });
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
        STANDIN_SETTLE_MS: '300', // a transfer that is not held settles quickly
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
    client = new NuvionClient(
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
      'nv_test_sk_HOLDselfieKEY00000000000',
    );

    const e = await call<{ data: { entity: { id: string } } }>(
      'POST',
      '/individual-entities',
      { name: 'Hold Spec', person: {} },
    );
    entity = e.body.data.entity.id;
    payerEntity = entity;
    const a = await call<{ data: { account: { id: string } } }>(
      'POST',
      '/accounts',
      { entity_id: entity, type: 'checking', currency: 'NGN' },
    );
    payer = a.body.data.account.id;
    await call('POST', '/__standin/fund', {
      account_id: payer,
      amount_kobo: 5_000_000,
    });
    const op = await call<{ nuvion_ban: string }>(
      'GET',
      `/__standin/account/${OPERATIONAL}`,
    );
    operationalBan = op.body.nuvion_ban;
  });

  afterAll(async () => {
    child?.kill('SIGTERM');
    await new Promise<void>((r) => (hooks ? hooks.close(() => r()) : r()));
    const refused = guard.violations;
    guard.restore();
    expect(refused).toEqual([]);
  });

  describe('the hold switch', () => {
    it('settles a purchase by itself while the switch is off', async () => {
      const t = await buy('spec-hold-off');
      expect(t.status).toBe(201);
      expect(t.body.data.status).toBe('pending');
      await waitFor(() => received.some((h) => h.data.id === t.body.data.id));
      expect(await statusOf(t.body.data.id)).toBe('successful');
    });

    it('keeps a purchase pending while it is on, and says so on state', async () => {
      const on = await call('POST', '/__standin/hold', { on: true });
      expect(on.status).toBe(200);
      const t = await buy('spec-hold-on');
      expect(t.status).toBe(201);
      await new Promise((r) => setTimeout(r, 900)); // three times the settle time
      expect(await statusOf(t.body.data.id)).toBe('pending');
      expect(received.some((h) => h.data.id === t.body.data.id)).toBe(false);
      const held = await call<{ on: boolean; held: string[] }>(
        'GET',
        '/__standin/hold',
      );
      expect(held.body).toMatchObject({ on: true, held: [t.body.data.id] });
      // The payer was debited at once, as for any transfer.
      const acct = await call<{ balance: { available: number } }>(
        'GET',
        `/__standin/account/${payer}`,
      );
      expect(acct.body.balance.available).toBeLessThan(5_000_000 - 100_000);
    });

    it('releases it through the signed webhook the Hub verifies', async () => {
      const id = (await call<{ held: string[] }>('GET', '/__standin/hold')).body
        .held[0];
      const before = received.length;
      const r = await call<{ released: { id: string; status: string }[] }>(
        'POST',
        '/__standin/release',
        {},
      );
      expect(r.status).toBe(200);
      expect(r.body.released).toEqual([{ id, status: 'successful' }]);
      await waitFor(() => received.length > before);
      const hook = received[received.length - 1];
      expect(hook.event).toBe('outflows.completed');
      expect(hook.data).toMatchObject({ id, status: 'successful' });
      const expected = createHmac('sha256', SECRET)
        .update(`${hook.timestamp}.${hook.raw}`)
        .digest('hex');
      expect(hook.signature).toBe(expected);
      expect(await statusOf(id)).toBe('successful');
      const again = await call('POST', '/__standin/release', {});
      expect(again.status).toBe(404); // nothing is held now
    });

    it('holds only the transfers whose narration matches, and fails one by hand', async () => {
      await call('POST', '/__standin/hold', { on: true, narration: 'tier' });
      const other = await buy('spec-hold-other', 'WAWU purchase');
      const tier = await buy('spec-hold-tier', 'WAWU tier purchase');
      await waitFor(() =>
        received.some((h) => h.data.id === other.body.data.id),
      );
      expect(await statusOf(other.body.data.id)).toBe('successful');
      expect(await statusOf(tier.body.data.id)).toBe('pending');
      const failed = await call('POST', '/__standin/release', {
        transfer_id: tier.body.data.id,
        status: 'failed',
      });
      expect(failed.status).toBe(200);
      await waitFor(() =>
        received.some(
          (h) =>
            h.data.id === tier.body.data.id && h.event === 'outflows.failed',
        ),
      );
      await call('POST', '/__standin/hold', { on: false });
      const free = await buy('spec-hold-free');
      await waitFor(() =>
        received.some((h) => h.data.id === free.body.data.id),
      );
      expect(await statusOf(free.body.data.id)).toBe('successful');
    });

    it('refuses a switch that is not true or false', async () => {
      const r = await call('POST', '/__standin/hold', { on: 'yes' });
      expect(r.status).toBe(422);
    });
  });

  describe('the hosted selfie, read through the Hub liveness area', () => {
    it('starts a session to an https address and reads it pending', async () => {
      const started = await startLivenessCalls(client, entity, null);
      expect(started.url).toBe(`${ORIGIN}/capture/${started.sessionId}`);
      const read = await readLivenessCalls(client, started.sessionId, entity);
      expect(read).toMatchObject({
        state: 'pending',
        captureStatus: 'pending',
        verificationStatus: 'pending',
        captureUrl: started.url,
      });
      expect(read.initiatedAt).toBeGreaterThan(0);
    });

    it('serves the page and passes after the selfie button', async () => {
      const started = await startLivenessCalls(
        client,
        entity,
        'https://example.invalid/selfie',
      );
      const path = `/capture/${started.sessionId}`;
      const page = await call<string>('GET', path);
      expect(page.status).toBe(200);
      expect(page.type).toContain('text/html');
      expect(page.body).toContain('Take my selfie');
      const done = await call<string>(
        'POST',
        `${path}/finish`,
        undefined,
        'result=approved',
      );
      expect(done.status).toBe(200);
      expect(done.body).toContain('You can go back to the app');
      const read = await readLivenessCalls(client, started.sessionId, entity);
      expect(read).toMatchObject({
        state: 'passed',
        captureStatus: 'completed',
        verificationStatus: 'approved',
      });
      // Decided once: a second press changes nothing.
      await call<string>(
        'POST',
        `${path}/finish`,
        undefined,
        'result=not-approved',
      );
      expect(
        (await readLivenessCalls(client, started.sessionId, entity)).state,
      ).toBe('passed');
    });

    it('reads a face that does not match, and a camera error, as not passed', async () => {
      const a = await startLivenessCalls(client, entity, null);
      await call(
        'POST',
        `/capture/${a.sessionId}/finish`,
        undefined,
        'result=not-approved',
      );
      expect((await readLivenessCalls(client, a.sessionId, entity)).state).toBe(
        'not_passed',
      );
      const b = await startLivenessCalls(client, entity, null);
      await call('POST', `/__standin/liveness/${b.sessionId}/finish`, {
        capture_status: 'image-error',
      });
      expect((await readLivenessCalls(client, b.sessionId, entity)).state).toBe(
        'not_passed',
      );
    });

    it('answers 404 for an entity or session it does not know, and takes the link', async () => {
      await expect(
        startLivenessCalls(client, '01NOSUCHENTITY00000000000', null),
      ).rejects.toMatchObject({ kind: 'not_found' });
      await expect(
        readLivenessCalls(client, 'no-such-session', entity),
      ).rejects.toMatchObject({ kind: 'not_found' });
      const started = await startLivenessCalls(client, entity, null);
      await expect(
        linkLivenessCalls(client, entity, started.sessionId),
      ).resolves.toBeUndefined();
      const listed = await call<{ sessions: { id: string }[] }>(
        'GET',
        '/__standin/liveness',
      );
      expect(listed.body.sessions.map((x) => x.id)).toContain(
        started.sessionId,
      );
    });
  });
});
