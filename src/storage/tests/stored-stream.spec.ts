// AITOOLS-04 round 4: the store reads the provider run needs. `storedLength`
// gives the object's real length, `openStored` streams it and stops it at that
// length; and the storage stand-in on the stack honours a Range header (206),
// so a 16 KB head read no longer downloads a whole object there.

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { StorageService } from '../storage.service';

jest.setTimeout(60_000);

const PORT = Number(process.env.R4_STORE_PORT ?? 7922);

function serviceWith(send: (cmd: unknown) => unknown): StorageService {
  const s = Object.create(StorageService.prototype) as StorageService;
  Object.assign(s, {
    client: { send: (c: unknown) => Promise.resolve(send(c)) },
    bucket: 'b',
  });
  return s;
}
const body = (n: number, pieces = 4) =>
  Readable.from(
    (function* () {
      const size = Math.ceil(n / pieces);
      for (let at = 0; at < n; at += size)
        yield Buffer.alloc(Math.min(size, n - at), 1);
    })(),
    { objectMode: false },
  );
const drain = async (r: Readable) => {
  let n = 0;
  for await (const c of r) n += (c as Buffer).length;
  return n;
};

describe('AITOOLS-04 r4: StorageService.storedLength and openStored', () => {
  it('storedLength is the length the store says, and an empty object is refused', async () => {
    expect(
      await serviceWith(() => ({ ContentLength: 1234 })).storedLength('k'),
    ).toBe(1234);
    await expect(
      serviceWith(() => ({ ContentLength: 0 })).storedLength('k'),
    ).rejects.toBeDefined();
  });

  it('openStored streams exactly the object and reports its real length', async () => {
    const s = serviceWith(() => ({ Body: body(1000), ContentLength: 1000 }));
    const o = await s.openStored('ai/input-audio/u/x.wav', 5000);
    expect(o.length).toBe(1000);
    expect(o.contentType).toBe('audio/wav');
    expect(await drain(o.body)).toBe(1000);
  });

  it('openStored refuses an empty object or one over the cap before reading anything', async () => {
    await expect(
      serviceWith(() => ({ Body: body(10), ContentLength: 0 })).openStored(
        'k',
        5000,
      ),
    ).rejects.toBeDefined();
    const big = body(10);
    await expect(
      serviceWith(() => ({ Body: big, ContentLength: 9000 })).openStored(
        'k',
        5000,
      ),
    ).rejects.toBeDefined();
    expect(big.destroyed).toBe(true);
  });

  it('a body longer than its length, or shorter, is an error on the stream', async () => {
    const longer = await serviceWith(() => ({
      Body: body(1500),
      ContentLength: 1000,
    })).openStored('k', 5000);
    await expect(drain(longer.body)).rejects.toThrow(/longer/);
    const shorter = await serviceWith(() => ({
      Body: body(500),
      ContentLength: 1000,
    })).openStored('k', 5000);
    await expect(drain(shorter.body)).rejects.toThrow(/early/);
  });
});

describe('AITOOLS-04 r4 LOW (a): the storage stand-in honours Range', () => {
  let child: ChildProcess;
  const url = (k: string) => `http://127.0.0.1:${PORT}/stack-bucket/${k}`;
  beforeAll(async () => {
    child = spawn(
      process.execPath,
      [
        path.join(__dirname, '../../../scripts/dev/storage-standin.cjs'),
        String(PORT),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve) =>
      child.stdout!.once('data', () => resolve()),
    );
    await fetch(url('o'), {
      method: 'PUT',
      body: Buffer.from('0123456789abcdefghij'),
    });
  });
  afterAll(() => {
    child.kill();
  });

  it('a ranged read answers 206 with only those bytes and the total in Content-Range', async () => {
    const r = await fetch(url('o'), { headers: { range: 'bytes=2-5' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 2-5/20');
    expect(await r.text()).toBe('2345');
    const open = await fetch(url('o'), { headers: { range: 'bytes=15-' } });
    expect(open.status).toBe(206);
    expect(await open.text()).toBe('fghij');
    const past = await fetch(url('o'), { headers: { range: 'bytes=0-999' } });
    expect(past.headers.get('content-range')).toBe('bytes 0-19/20');
    expect(
      (await fetch(url('o'), { headers: { range: 'bytes=50-60' } })).status,
    ).toBe(416);
  });

  it('a read with no Range is the whole object, 200', async () => {
    const r = await fetch(url('o'));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('0123456789abcdefghij');
    expect(
      (await fetch(url('o'), { method: 'HEAD' })).headers.get('content-length'),
    ).toBe('20');
  });
});
