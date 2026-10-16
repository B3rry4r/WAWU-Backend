import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { WawuIdMailRelay, type ProviderMessage } from '../email-provider';

/**
 * What the Hub accepts as "WAWU ID sent it" (WALLET-35 round 2). A relay from
 * before WALLET-35 drops `attachments` and still answers 200 { id }, so a mail
 * that carries a file counts as sent only when the answer says how many files
 * were taken and the number is the one sent. A mail with no file (a campaign,
 * the money check's report) is sent and judged exactly as before.
 */

const KEY = 'relay-test-key';

interface Seen {
  headers: Record<string, string | string[] | undefined>;
  raw: string;
}

describe('WawuIdMailRelay: the file is confirmed (WALLET-35 round 2)', () => {
  let server: Server;
  let seen: Seen[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  let relay: WawuIdMailRelay;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          headers: req.headers,
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    relay = new WawuIdMailRelay({
      get: (k: string) =>
        ({ WAWU_ID_BASE_URL: base, WAWU_ID_INTERNAL_SERVICE_KEY: KEY })[k],
    } as unknown as ConfigService);
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    seen = [];
    reply = { status: 200, body: {} };
  });

  const file = (name: string) => ({
    filename: name,
    content: Buffer.from('a,b\r\n1,2\r\n').toString('base64'),
    contentType: 'text/csv; charset=utf-8',
  });
  const plain: ProviderMessage = {
    from: '',
    to: 'a@example.test',
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
    headers: { 'List-Unsubscribe': '<https://example.test/u>' },
    idempotencyKey: 'k-plain',
    tag: 'camp_1',
  };
  const withFile = (n: number): ProviderMessage => ({
    ...plain,
    tag: undefined,
    idempotencyKey: 'k-file',
    attachments: Array.from({ length: n }, (_, i) => file(`s${i + 1}.csv`)),
  });

  describe('a mail with no file is judged as before', () => {
    it('sends exactly the fields it sent before, and 200 { id } is sent', async () => {
      reply = { status: 200, body: { id: 'mail-1' } };
      const r = await relay.send(plain);
      expect(r).toEqual({ ok: true, id: 'mail-1' });
      expect(seen).toHaveLength(1);
      expect(seen[0].raw).toBe(
        JSON.stringify({
          to: plain.to,
          subject: plain.subject,
          html: plain.html,
          text: plain.text,
          headers: plain.headers,
          tag: 'camp_1',
        }),
      );
      expect(seen[0].headers['x-service-key']).toBe(KEY);
      expect(seen[0].headers['idempotency-key']).toBe('k-plain');
    });

    it('is sent whatever the answer says about files, since it sent none', async () => {
      for (const attachments of [undefined, 0, 1, 5, null, 'x']) {
        reply = { status: 200, body: { id: 'mail-2', attachments } };
        expect(await relay.send(plain)).toEqual({ ok: true, id: 'mail-2' });
      }
    });

    it('an empty list of files is no file: the same rule as no list', async () => {
      reply = { status: 200, body: { id: 'mail-3' } };
      expect(await relay.send({ ...plain, attachments: [] })).toEqual({
        ok: true,
        id: 'mail-3',
      });
    });

    it('its failures keep their kinds: 503 and 5xx retry, 400, 401, 429 do not, and a 200 with no id retries', async () => {
      const cases: Array<[number, unknown, boolean]> = [
        [503, { message: 'busy' }, true],
        [502, {}, true],
        [400, { message: 'bad address' }, false],
        [401, {}, false],
        [429, {}, false],
        [200, {}, true],
      ];
      for (const [status, body, transient] of cases) {
        reply = { status, body };
        const r = await relay.send(plain);
        expect(r).toMatchObject({ ok: false, transient });
      }
    });
  });

  describe('a mail with a file is sent only when the relay says it took that many', () => {
    it('one file taken: sent', async () => {
      reply = { status: 200, body: { id: 'mail-4', attachments: 1 } };
      expect(await relay.send(withFile(1))).toEqual({
        ok: true,
        id: 'mail-4',
      });
      const body = JSON.parse(seen[0].raw) as { attachments: unknown[] };
      expect(body.attachments).toHaveLength(1);
    });

    it('two files, two taken: sent', async () => {
      reply = { status: 200, body: { id: 'mail-5', attachments: 2 } };
      expect(await relay.send(withFile(2))).toEqual({
        ok: true,
        id: 'mail-5',
      });
    });

    it('an old relay that drops the files and answers 200 { id } is not sent', async () => {
      reply = { status: 200, body: { id: 'old-1' } };
      const r = await relay.send(withFile(1));
      expect(r).toMatchObject({ ok: false, transient: false });
      expect((r as { error: string }).error).toContain('did not confirm');
      // The mail did go to the relay with its file; the answer is what failed.
      expect(JSON.parse(seen[0].raw)).toHaveProperty('attachments');
    });

    it('any other count or form is not sent', async () => {
      const wrong: unknown[] = [0, 2, 3, -1, 1.5, '1', null, true, [{}], {}];
      for (const attachments of wrong) {
        reply = { status: 200, body: { id: 'x', attachments } };
        expect(await relay.send(withFile(1))).toMatchObject({
          ok: false,
          transient: false,
        });
      }
      // Two sent, one taken.
      reply = { status: 200, body: { id: 'x', attachments: 1 } };
      expect(await relay.send(withFile(2))).toMatchObject({ ok: false });
    });

    it('the relay refusing the mail keeps its own kinds', async () => {
      reply = { status: 400, body: { message: 'too large' } };
      expect(await relay.send(withFile(1))).toMatchObject({
        ok: false,
        transient: false,
      });
      reply = { status: 503, body: { message: 'busy' } };
      expect(await relay.send(withFile(1))).toMatchObject({
        ok: false,
        transient: true,
      });
    });
  });
});
