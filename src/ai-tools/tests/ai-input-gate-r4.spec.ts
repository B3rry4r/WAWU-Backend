// AITOOLS-04 round 4, the provider run behind the read gate:
//   HIGH 2: the run no longer reads the person's file whole, once per running
//   job with no limit. It takes the same place as a quote (the account's one
//   place, the global turns and bytes, charged the file's REAL length) and
//   streams the file to the provider; the Hub holds a few buffers of it, not
//   the file.
//   LOW (b): the account's place and the turn share ONE deadline.
//
// The files double makes a file's bytes only as they are read (nothing is held
// by the spec), the provider is the real HTTP adapter, and the provider is a
// sink on this machine that reads and drops the body (so the memory measured is
// the Hub's). No database, no stand-in, no real provider, no Fintava double.

import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import type { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { wavFile } from '../../../test/ai-tools/media-fixtures';
import { MemoryInputFiles } from '../../../test/ai-tools/ai-tools-harness';
import { AiInputService } from '../input/ai-input-files';
import { ReadGate, READ_BUSY_MESSAGE } from '../input/read-gate';
import { HttpVoiceProvider } from '../voice/http-voice-provider';

jest.setTimeout(180_000);

const MB = 1024 * 1024;
const SINK_PORT = Number(process.env.R4_SINK_PORT ?? 7921);
const settings = { number: () => 500 * MB } as unknown as PlanSettingsService;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A files double whose bytes exist only while they are being streamed. */
class StreamFiles extends MemoryInputFiles {
  readonly sizes = new Map<string, number>();
  /** Per user: files being streamed now, and the most at once. */
  readonly active = new Map<string, number>();
  readonly maxActive = new Map<string, number>();
  readonly closedAt = new Map<string, number>();
  /** Milliseconds of delay per 1 MB, to make a stream last. */
  pace = 0;
  addStream(user: string, bytes: number): string {
    const key = this.add(user, Buffer.alloc(0), 'audio/wav');
    this.sizes.set(key, bytes);
    return key;
  }
  length(key: string): Promise<number> {
    const declared = this.sizes.get(key);
    return declared === undefined
      ? super.length(key)
      : Promise.resolve(declared);
  }
  open(
    key: string,
    maxBytes: number,
  ): Promise<{ stream: Readable; bytes: number; contentType: string }> {
    this.opens.push(key);
    const bytes = this.sizes.get(key) ?? 0;
    if (bytes === 0 || bytes > maxBytes) return Promise.reject(new Error('x'));
    const user = key.split('/')[2];
    this.active.set(user, (this.active.get(user) ?? 0) + 1);
    this.maxActive.set(
      user,
      Math.max(this.maxActive.get(user) ?? 0, this.active.get(user)!),
    );
    const pace = this.pace;
    const chunk = Buffer.alloc(64 * 1024, 7);
    const stream = Readable.from(
      (async function* () {
        let left = bytes;
        let sinceSleep = 0;
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          left -= n;
          yield n === chunk.length ? chunk : chunk.subarray(0, n);
          sinceSleep += n;
          if (pace > 0 && sinceSleep >= MB) {
            sinceSleep = 0;
            await sleep(pace);
          }
        }
      })(),
      { objectMode: false },
    );
    stream.on('close', () => {
      this.active.set(user, this.active.get(user)! - 1);
      this.closedAt.set(key, Date.now());
    });
    return Promise.resolve({ stream, bytes, contentType: 'audio/wav' });
  }
}

/** A provider that reads and drops the body, then answers an empty transcript. */
function sink(): Promise<{ server: Server; received: number[] }> {
  const received: number[] = [];
  const server = createServer((req, res) => {
    let n = 0;
    req.on('data', (c: Buffer) => (n += c.length));
    req.on('end', () => {
      received.push(n);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: '', words: [], audio_duration_secs: 1 }));
    });
  });
  return new Promise((resolve) =>
    server.listen(SINK_PORT, '127.0.0.1', () => resolve({ server, received })),
  );
}

const provider = () =>
  new HttpVoiceProvider(
    new ConfigService({
      AI_VOICE_BASE_URL: `http://127.0.0.1:${SINK_PORT}`,
      AI_VOICE_API_KEY: 'k',
    }),
  );

/** Opens the user's file for a run and sends it to the sink, as the pipeline does. */
async function run(service: AiInputService, user: string, key: string) {
  const file = await service.openForRun(user, key);
  try {
    await provider().transcribe({ file, languageCode: null });
  } finally {
    file.sent();
  }
}

describe('AITOOLS-04 r4: a file job streams behind the read gate (service, real HTTP adapter)', () => {
  let s: { server: Server; received: number[] };
  beforeAll(async () => {
    s = await sink();
  });
  afterAll(async () => {
    await new Promise<void>((r) => s.server.close(() => r()));
  });
  beforeEach(() => {
    s.received.length = 0;
  });

  it('a streamed file reaches the provider byte for byte, and the gate place goes back when the last byte is written, before the provider has answered', async () => {
    const files = new StreamFiles();
    const gate = new ReadGate();
    const service = new AiInputService(settings, files, gate);
    const key = files.addStream('u1', 20 * MB);
    const file = await service.openForRun('u1', key);
    expect(gate.stats()).toEqual({ running: 1, waiting: 0, bytes: 20 * MB }); // charged the real length
    let freedBeforeAnswer = false;
    const call = provider()
      .transcribe({ file, languageCode: null })
      .then(() => undefined);
    // The sink answers after the body; the place is back by then.
    await until(() => s.received.length === 1);
    freedBeforeAnswer = gate.stats().running === 0;
    await call;
    expect(freedBeforeAnswer).toBe(true);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0, bytes: 0 });
    // The body is the multipart head, the 20 MB, and the tail.
    expect(s.received[0]).toBeGreaterThan(20 * MB);
    expect(s.received[0]).toBeLessThan(20 * MB + 1024);
    expect(files.active.get('u1')).toBe(0);
  });

  it('8 jobs from one account hold one at a time: the second waits its turn, the others are refused busy at once with nothing held', async () => {
    const files = new StreamFiles();
    files.pace = 10;
    const gate = new ReadGate();
    const service = new AiInputService(settings, files, gate);
    const keys = Array.from({ length: 8 }, () => files.addStream('u1', 6 * MB));
    const t0 = Date.now();
    const results = await Promise.all(
      keys.map((k) =>
        run(service, 'u1', k).then(
          () => ({ ok: true, ms: Date.now() - t0 }),
          (e: unknown) => ({
            ok: false,
            ms: Date.now() - t0,
            busy:
              e instanceof ServiceUnavailableException &&
              e.message === READ_BUSY_MESSAGE,
          }),
        ),
      ),
    );
    const served = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    console.log(
      `8 jobs, one account: ${served.length} served (at ${served.map((r) => r.ms).join(', ')} ms), ${refused.length} refused busy (at ${refused.map((r) => r.ms).join(', ')} ms); most files streaming at once: ${files.maxActive.get('u1')}`,
    );
    expect(files.maxActive.get('u1')).toBe(1);
    expect(served).toHaveLength(2); // one running, one waited
    expect(refused).toHaveLength(6);
    for (const r of refused) {
      expect((r as { busy: boolean }).busy).toBe(true);
      expect(r.ms).toBeLessThan(500);
    }
    // A refused job never opened its file: only the two served were opened.
    expect(files.opens).toHaveLength(2);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0, bytes: 0 });
    // The account is free again.
    await run(service, 'u1', files.addStream('u1', 1 * MB));
  });

  it('a quote and a job share the account place: a quote waits for a streaming job, and a job waits for a quote that is reading', async () => {
    const files = new StreamFiles();
    files.pace = 20;
    const gate = new ReadGate();
    const service = new AiInputService(settings, files, gate);
    const jobKey = files.addStream('u1', 10 * MB);
    const wavKey = files.add('u1', wavFile(5), 'audio/wav');
    const job = run(service, 'u1', jobKey);
    await until(() => files.opens.includes(jobKey));
    const quote = service.open('u1', wavKey);
    await sleep(100);
    // The quote has not read its file: the job still has the place.
    expect(files.reads.filter((r) => r.key === wavKey)).toHaveLength(0);
    await job;
    await expect(quote).resolves.toMatchObject({ key: wavKey, minutes: 1 });
    const quoteReadAt = files.reads.findIndex(
      (r) => r.key === wavKey && r.kind === 'whole',
    );
    expect(quoteReadAt).toBeGreaterThanOrEqual(0);
    expect(files.closedAt.get(jobKey)).toBeDefined();
    // And the other way round: the job waits for a quote's read.
    const slowQuote = service.open('u1', wavKey);
    const second = run(service, 'u1', files.addStream('u1', 1 * MB));
    await expect(slowQuote).resolves.toBeDefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('20 accounts at once, 100 MB each: the Hub streams two at a time and the memory it adds is a few MB, not the files', async () => {
    const files = new StreamFiles();
    files.pace = 1;
    const gate = new ReadGate();
    const service = new AiInputService(settings, files, gate);
    const users = Array.from({ length: 20 }, (_, i) => `acct${i}`);
    const keys = users.map((u) => files.addStream(u, 100 * MB));
    global.gc?.();
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    const t0 = Date.now();
    const results = await Promise.all(
      users.map((u, i) =>
        run(service, u, keys[i]).then(
          () => 'served',
          (e: unknown) =>
            e instanceof ServiceUnavailableException ? 'busy' : 'other',
        ),
      ),
    );
    clearInterval(timer);
    const added = Math.round((peak - base) / MB);
    console.log(
      `20 accounts x 100 MB: ${results.filter((r) => r === 'served').length} served, ${results.filter((r) => r === 'busy').length} refused busy, in ${Date.now() - t0} ms; RSS base ${Math.round(base / MB)} MB, peak ${Math.round(peak / MB)} MB (+${added} MB); sink received ${s.received.length} bodies`,
    );
    expect(results.every((r) => r === 'served' || r === 'busy')).toBe(true);
    expect(results.filter((r) => r === 'served').length).toBeGreaterThanOrEqual(
      2,
    );
    // Stated bound: 100 MB over the base, whatever the number of accounts or
    // the size of the files (the streams' own buffers, about 64 KB a job, plus
    // the sockets); a whole-file read would add 100 MB a job, 200 MB for the
    // two the gate lets run at once.
    expect(added).toBeLessThan(100);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0, bytes: 0 });
    for (const u of users) expect(files.maxActive.get(u) ?? 0).toBeLessThan(2);
  });

  it('peak memory of one job: 4 jobs at a time of 150 MB each add a few MB', async () => {
    const files = new StreamFiles();
    const gate = new ReadGate({
      parallel: 4,
      waiting: 3,
      waitMs: 20_000,
      budgetBytes: 1024 * MB,
    });
    const service = new AiInputService(settings, files, gate);
    const users = ['p0', 'p1', 'p2', 'p3'];
    const keys = users.map((u) => files.addStream(u, 150 * MB));
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    await Promise.all(users.map((u, i) => run(service, u, keys[i])));
    clearInterval(timer);
    const added = (peak - base) / MB;
    console.log(
      `4 jobs x 150 MB at once: RSS +${added.toFixed(1)} MB over ${Math.round(base / MB)} MB (about ${(added / 4).toFixed(1)} MB a job)`,
    );
    expect(added).toBeLessThan(60);
  });

  it('a file whose real length passes the cap, or whose stream is longer than it said, is not sent', async () => {
    const files = new StreamFiles();
    const gate = new ReadGate();
    const service = new AiInputService(
      { number: () => 5 * MB } as unknown as PlanSettingsService,
      files,
      gate,
    );
    const big = files.addStream('u1', 6 * MB);
    await expect(service.openForRun('u1', big)).rejects.toBeDefined();
    expect(files.opens).toHaveLength(0);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0, bytes: 0 });
    // A body that is longer than the length it was charged is stopped.
    const liar = files.addStream('u1', 2 * MB);
    const real = files.open.bind(files);
    files.open = async (k, m) => {
      const o = await real(k, m);
      return { ...o, bytes: 1 * MB };
    };
    const file = await service.openForRun('u1', liar);
    await expect(
      provider().transcribe({ file, languageCode: null }),
    ).rejects.toBeDefined();
    file.sent();
    expect(gate.stats()).toEqual({ running: 0, waiting: 0, bytes: 0 });
  });
});

describe('AITOOLS-04 r4 LOW (b): one deadline for the account place and the turn', () => {
  it('a read that waits for its account and then for a turn is answered or refused inside one waitMs, not two', async () => {
    const gate = new ReadGate({
      parallel: 1,
      waiting: 3,
      waitMs: 600,
      budgetBytes: 1024 * MB,
    });
    const blocker = await gate.takeTurn(10); // the line is full for the whole test
    const first = await gate.claimAccount('a');
    setTimeout(first, 300); // the account's read in flight ends after 300 ms
    const t0 = Date.now();
    const until = gate.deadline();
    const place = await gate.claimAccount('a', until);
    await expect(gate.takeTurn(10, until)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    place();
    const took = Date.now() - t0;
    console.log(
      `waited ${took} ms for an account (300) and a turn, one 600 ms deadline`,
    );
    expect(took).toBeGreaterThanOrEqual(550);
    expect(took).toBeLessThan(750); // before: 300 + 600 = 900 ms
    blocker();
  });
});

async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await sleep(5);
  }
  throw new Error('gave up waiting');
}
