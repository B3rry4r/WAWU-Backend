import { ServiceUnavailableException } from '@nestjs/common';
import type { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  atomFlood,
  mp4File,
  wavFile,
} from '../../../test/ai-tools/media-fixtures';
import { MemoryInputFiles } from '../../../test/ai-tools/ai-tools-harness';
import {
  AiInputService,
  FILE_UNREADABLE_MESSAGE,
} from '../input/ai-input-files';
import { ReadGate, READ_BUSY_MESSAGE } from '../input/read-gate';

jest.setTimeout(180_000);

const MB = 1024 * 1024;
const settings = { number: () => 500 * MB } as unknown as PlanSettingsService;

const busy = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceUnavailableException);
  expect((err as ServiceUnavailableException).message).toBe(READ_BUSY_MESSAGE);
};

describe('AITOOLS-04 r3: the read gate (unit)', () => {
  it('one read in flight per account: a second waits for the first, a third is refused busy, another account is not held up', async () => {
    const gate = new ReadGate({
      parallel: 2,
      waiting: 3,
      waitMs: 400,
      budgetBytes: 1024 * MB,
    });
    const first = await gate.claimAccount('a');
    let secondHas = false;
    const second = gate.claimAccount('a').then((release) => {
      secondHas = true;
      return release;
    });
    await busy(gate.claimAccount('a')); // one is already waiting
    (await gate.claimAccount('b'))(); // another account is not held up
    await new Promise((r) => setTimeout(r, 50));
    expect(secondHas).toBe(false); // it waits while the first is in flight
    first();
    const releaseSecond = await second;
    expect(secondHas).toBe(true);
    releaseSecond();
    (await gate.claimAccount('a'))(); // the account is free again

    // A wait longer than waitMs is the busy answer, and leaves the line.
    const held = await gate.claimAccount('c');
    const t0 = Date.now();
    await busy(gate.claimAccount('c'));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
    held();
    (await gate.claimAccount('c'))();
  });

  it('takes the turn first: only `parallel` hold one, `waiting` wait, the rest are refused at once with nothing held', async () => {
    const gate = new ReadGate({
      parallel: 2,
      waiting: 3,
      waitMs: 5_000,
      budgetBytes: 1024 * MB,
    });
    const first = await gate.takeTurn(10);
    const second = await gate.takeTurn(10);
    const queued = [3, 4, 5].map((n) => gate.takeTurn(n));
    expect(gate.stats()).toEqual({ running: 2, waiting: 3, bytes: 20 });
    await busy(gate.takeTurn(1));
    await busy(gate.takeTurn(1));
    expect(gate.stats().waiting).toBe(3);
    first();
    const third = await queued[0];
    expect(gate.stats()).toEqual({ running: 2, waiting: 2, bytes: 13 });
    second();
    third();
    for (const q of queued.slice(1)) (await q)();
    expect(gate.stats()).toEqual({ running: 0, waiting: 0, bytes: 0 });
  });

  it('a read waits no longer than waitMs: then it is refused and leaves the line', async () => {
    const gate = new ReadGate({
      parallel: 1,
      waiting: 3,
      waitMs: 150,
      budgetBytes: 1024 * MB,
    });
    const held = await gate.takeTurn(1);
    const t0 = Date.now();
    await busy(gate.takeTurn(1));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(gate.stats().waiting).toBe(0);
    held();
  });

  it('the bytes in memory stay under the budget: a second big file waits though a place is free; a lone file over the budget still runs', async () => {
    const gate = new ReadGate({
      parallel: 2,
      waiting: 3,
      waitMs: 5_000,
      budgetBytes: 300,
    });
    const a = await gate.takeTurn(200);
    const bAsk = gate.takeTurn(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(gate.stats()).toEqual({ running: 1, waiting: 1, bytes: 200 });
    const small = gate.takeTurn(50); // behind b in the line: first come first served
    a();
    const b = await bAsk;
    (await small)();
    b();
    const lone = await gate.takeTurn(10_000);
    expect(gate.stats().running).toBe(1);
    lone();
  });
});

/**
 * The service with the REAL parser and a files double that makes a file's
 * bytes only when it is read, as the bucket does: so what the double was asked
 * to read is what the Hub held.
 */
class LazyFiles extends MemoryInputFiles {
  readonly made = new Map<string, () => Buffer>();
  addLazy(
    user: string,
    bytes: number,
    make: () => Buffer,
    type = 'video/mp4',
  ): string {
    const key = this.add(user, Buffer.alloc(0), type, 'ai/input-video');
    // The source is made once (and is the spec's own, not the Hub's); every
    // read hands out a fresh copy, as the bucket does.
    let source: Buffer | undefined;
    this.made.set(key, () => (source ??= make()));
    const f = this.files.get(key)!;
    Object.defineProperty(f, 'data', {
      get: () => ({ length: bytes, subarray: () => make().subarray(0, 16384) }),
    });
    return key;
  }
  read(key: string): Promise<{ audio: Buffer; contentType: string }> {
    this.reads.push({ key, kind: 'whole' });
    const audio = Buffer.from(this.made.get(key)!());
    return Promise.resolve({ audio, contentType: 'video/mp4' });
  }
  readHead(key: string, bytes: number): Promise<Buffer> {
    this.reads.push({ key, kind: 'head' });
    return Promise.resolve(
      Buffer.from(this.made.get(key)!().subarray(0, bytes)),
    );
  }
}

describe('AITOOLS-04 r3: hostile files cannot fill the Hub (service, real parser)', () => {
  it('a file that is not a recording is refused from its first 16 KB: the rest is never read', async () => {
    const files = new LazyFiles();
    const gate = new ReadGate();
    const service = new AiInputService(settings, files, gate);
    const key = files.addLazy('u1', 100 * MB, () =>
      Buffer.alloc(100 * MB, 0x41),
    );
    await expect(service.open('u1', key)).rejects.toMatchObject({
      response: { message: FILE_UNREADABLE_MESSAGE },
    });
    expect(files.reads).toEqual([{ key, kind: 'head' }]); // a head read only, no whole read, no turn taken
    expect(gate.stats()).toEqual({ running: 0, waiting: 0, bytes: 0 });
  });

  it('one read in flight per account: a second open from the same account waits for the first (its file is not read meanwhile); a third is refused busy', async () => {
    const files = new LazyFiles();
    const service = new AiInputService(settings, files, new ReadGate());
    const slow = files.addLazy('u1', 8 * MB, () => atomFlood(8 * MB));
    const second = files.addLazy('u1', 1 * MB, () => mp4File({}));
    const third = files.addLazy('u1', 1 * MB, () => mp4File({}));
    const running = service.open('u1', slow);
    await new Promise((r) => setTimeout(r, 200));
    const waits = service.open('u1', second);
    await new Promise((r) => setTimeout(r, 50));
    await busy(service.open('u1', third));
    expect(files.reads.filter((r) => r.key === second)).toHaveLength(0);
    expect(files.reads.filter((r) => r.key === third)).toHaveLength(0);
    await expect(running).rejects.toBeDefined(); // the flood is unreadable (time limit)
    // The second ran after the first was done.
    await expect(waits).resolves.toMatchObject({ key: second });
    expect(files.reads.findIndex((r) => r.key === second)).toBeGreaterThan(
      files.reads.findIndex((r) => r.key === slow && r.kind === 'whole'),
    );
  });

  it('N hostile 100 MB files in flight keep memory bounded; waiting ones are not in memory; a good quote is refused at once while the line is full and served when a place frees', async () => {
    const files = new LazyFiles();
    const gate = new ReadGate();
    const service = new AiInputService(settings, files, gate);
    const flood = atomFlood(100 * MB); // the spec's one source; each read copies it
    const hostile = Array.from({ length: 10 }, (_, i) => {
      const user = `h${i}`;
      return { user, key: files.addLazy(user, 100 * MB, () => flood) };
    });
    const good = files.addLazy('good', 600_000, () => wavFile(5));
    files.made.get(good)!();
    global.gc?.();
    const base = process.memoryUsage().rss;
    let peak = base;
    let peakRunning = 0;
    let peakBytes = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
      const g = gate.stats();
      peakRunning = Math.max(peakRunning, g.running);
      peakBytes = Math.max(peakBytes, g.bytes);
    }, 25);

    const t0 = Date.now();
    const outcomes = hostile.map((h) =>
      service.open(h.user, h.key).then(
        () => 'read',
        (e: unknown) =>
          e instanceof ServiceUnavailableException ? 'busy' : 'unreadable',
      ),
    );
    await new Promise((r) => setTimeout(r, 400)); // heads are read, the line forms
    // 2 running + 3 waiting; the other 5 were refused busy at once.
    expect(gate.stats()).toMatchObject({ running: 2, waiting: 3 });
    const wholeNow = files.reads.filter((r) => r.kind === 'whole').length;
    expect(wholeNow).toBe(2); // only the two with a turn were read whole

    // The line is full: a good quote is refused at once, holding nothing.
    const tBusy = Date.now();
    await busy(service.open('good', good));
    const busyMs = Date.now() - tBusy;
    expect(busyMs).toBeLessThan(1000);

    // As soon as the hostile ones have gone through (at most their 15 s limit
    // each, two at a time), the good quote is served within a stated time.
    const results = await Promise.all(outcomes);
    const floodMs = Date.now() - t0;
    const tGood = Date.now();
    const quote = await service.open('good', good);
    const goodMs = Date.now() - tGood;
    clearInterval(sampler);

    const refused = results.filter((r) => r === 'busy').length;
    const peakMb = Math.round((peak - base) / MB);
    console.log(
      `10 hostile 100 MB files: refused busy ${refused}, unreadable ${results.filter((r) => r === 'unreadable').length}; ` +
        `peak RSS +${peakMb} MB over ${Math.round(base / MB)} MB; whole reads started ${files.reads.filter((r) => r.kind === 'whole').length}; ` +
        `files held by turns at once ${peakRunning} (${Math.round(peakBytes / MB)} MB); line full refusal ${busyMs} ms; flood done in ${floodMs} ms; good quote after ${goodMs} ms`,
    );
    // 5 refused at once for want of a place in line; a waiter that is not
    // given a turn within 20 s is refused too; the rest went through the parser
    // (an atom flood runs to its 15 s limit) and are unreadable. None was read.
    expect(refused).toBeGreaterThanOrEqual(5);
    expect(results.filter((r) => r === 'read')).toHaveLength(0);
    expect(refused + results.filter((r) => r === 'unreadable').length).toBe(10);
    // Never more than the two with a turn held a file at the same moment.
    expect(peakRunning).toBeLessThanOrEqual(2);
    expect(peakBytes).toBeLessThanOrEqual(2 * 100 * MB);
    // Stated bound: the files with a turn (2 x 100 MB) plus what each parser may add (384 MB each), with 10% slack.
    expect(peak - base).toBeLessThan(
      Math.round(1.1 * (2 * 100 + 2 * 384) * MB),
    );
    expect(quote.minutes).toBe(1);
    expect(goodMs).toBeLessThan(5_000);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0, bytes: 0 });
  });
});
