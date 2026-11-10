// VIDEO-PRIVACY (R-127): the stored-object side. An in-memory bucket stands in
// for the store; the cleaner reads it by ranges, writes it back at the same key
// only when something changes, and leaves a file it cannot read exactly as it is.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  cleanStoredVideo,
  COOL_DOWN_MS,
  forgetCleanedVideos,
} from '../video-privacy/clean-stored';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const box = (t: string, ...p: Buffer[]) => {
  const body = Buffer.concat(p);
  return Buffer.concat([u32(8 + body.length), Buffer.from(t, 'latin1'), body]);
};
const tagged = () =>
  Buffer.concat([
    box('ftyp', Buffer.from('isom'), u32(0)),
    box('mdat', Buffer.alloc(3000, 7)),
    box(
      'moov',
      box('mvhd', Buffer.alloc(100, 1)),
      box('udta', box('©xyz', Buffer.from('+06.4542+003.3925/'))),
    ),
  ]);

function bucket(
  objects: Record<string, { body: Buffer; type: string; etag?: string }>,
) {
  const calls: unknown[] = [];
  const hooks: { onHead?: (n: number) => void; onGet?: (n: number) => void } =
    {};
  let gets = 0;
  let heads = 0;
  let serial = 0;
  const tag = (o: { etag?: string }) => (o.etag ??= `"e${(serial += 1)}"`);
  const puts: { key: string; type?: string; len?: number }[] = [];
  const deletes: string[] = [];
  const client = {
    send: async (cmd: unknown, opts?: unknown) => {
      void opts;
      calls.push(cmd);
      if (cmd instanceof HeadObjectCommand) {
        heads += 1;
        hooks.onHead?.(heads);
        const o = objects[cmd.input.Key!];
        if (!o) throw new Error('NoSuchKey');
        return {
          ContentLength: o.body.length,
          ContentType: o.type,
          ETag: tag(o),
        };
      }
      if (cmd instanceof GetObjectCommand) {
        gets += 1;
        hooks.onGet?.(gets);
        const o = objects[cmd.input.Key!];
        if (!o) throw new Error('NoSuchKey');
        if (cmd.input.IfMatch && cmd.input.IfMatch !== tag(o))
          throw Object.assign(new Error('412'), { name: 'PreconditionFailed' });
        const m = /bytes=(\d+)-(\d+)/.exec(cmd.input.Range ?? '');
        const part = m
          ? o.body.subarray(Number(m[1]), Number(m[2]) + 1)
          : o.body;
        return {
          ContentLength: part.length,
          ETag: tag(o),
          Body: Object.assign(Readable.from([part]), {
            transformToByteArray: () => Promise.resolve(new Uint8Array(part)),
          }),
        };
      }
      if (cmd instanceof PutObjectCommand) {
        const chunks: Buffer[] = [];
        for await (const c of cmd.input.Body as Readable)
          chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        puts.push({
          key: cmd.input.Key!,
          type: cmd.input.ContentType,
          len: cmd.input.ContentLength,
        });
        objects[cmd.input.Key!] = { body, type: cmd.input.ContentType ?? '' };
        return {};
      }
      if (cmd instanceof DeleteObjectCommand) {
        deletes.push(cmd.input.Key!);
        delete objects[cmd.input.Key!];
        return {};
      }
      throw new Error('unexpected command');
    },
  } as unknown as S3Client;
  return { client, puts, deletes, calls, hooks, heads: () => heads };
}
const logger = { log: jest.fn(), warn: jest.fn() };
/** What StorageService supplies: the write goes through the client as it is when called. */
const putVia =
  (client: S3Client) =>
  async (put: {
    key: string;
    body: Readable;
    contentType: string | undefined;
    contentLength: number;
  }) => {
    await client.send(
      new PutObjectCommand({
        Bucket: 'b',
        Key: put.key,
        Body: put.body,
        ContentType: put.contentType,
        ContentLength: put.contentLength,
      }),
    );
  };

describe('VIDEO-PRIVACY: cleaning a stored video', () => {
  beforeEach(() => {
    forgetCleanedVideos();
    logger.log.mockClear();
    logger.warn.mockClear();
  });

  it('writes the cleaned bytes back at the same key, same type, same length; a second run writes nothing', async () => {
    const original = tagged();
    const key = 'profile/work/u1/a.mp4';
    const store = bucket({ [key]: { body: original, type: 'video/mp4' } });
    const deps = {
      client: store.client,
      bucket: 'b',
      logger,
      putObject: putVia(store.client),
      stillWanted: () => Promise.resolve(true),
    };
    const first = await cleanStoredVideo(deps, key);
    expect(first.result).toBe('cleaned');
    expect(store.puts).toEqual([
      { key, type: 'video/mp4', len: original.length },
    ]);
    const got = (await store.client.send(
      new GetObjectCommand({ Bucket: 'b', Key: key }),
    )) as unknown as { Body: Readable };
    const stored = Buffer.concat(
      (await Readable.from(got.Body).toArray()) as Buffer[],
    );
    expect(stored.length).toBe(original.length);
    expect(stored.includes(Buffer.from('6.4542'))).toBe(false);
    expect(
      stored
        .subarray(0, original.indexOf(Buffer.from('moov')) - 4)
        .equals(
          original.subarray(0, original.indexOf(Buffer.from('moov')) - 4),
        ),
    ).toBe(true);
    forgetCleanedVideos();
    expect((await cleanStoredVideo(deps, key)).result).toBe('already-clean');
    expect(store.puts).toHaveLength(1);
    expect(JSON.stringify(logger.log.mock.calls)).not.toMatch(/6\.4542/);
  });

  it('leaves a file it cannot read exactly as it is, logs it, and does not throw', async () => {
    const junk = Buffer.from(
      'this is not a video but is named like one'.repeat(5),
    );
    const key = 'content/full/u1/x.mp4';
    const store = bucket({ [key]: { body: junk, type: 'video/mp4' } });
    const out = await cleanStoredVideo(
      {
        client: store.client,
        bucket: 'b',
        logger,
        putObject: putVia(store.client),
        stillWanted: () => Promise.resolve(true),
      },
      key,
    );
    expect(out.result).toBe('left');
    expect(store.puts).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('left content/full/u1/x.mp4 as it is'),
    );
  });

  it('leaves the file when the store fails mid-way, and ignores a key that is not a video', async () => {
    const key = 'profile/work/u1/b.mov';
    const store = bucket({
      [key]: { body: tagged(), type: 'video/quicktime' },
    });
    const orig = store.client.send.bind(store.client);
    (store.client as { send: unknown }).send = async (
      c: unknown,
      o?: unknown,
    ) => {
      if (c instanceof PutObjectCommand) throw new Error('503');
      return orig(c as never, o as never);
    };
    const out = await cleanStoredVideo(
      {
        client: store.client,
        bucket: 'b',
        logger,
        putObject: putVia(store.client),
        stillWanted: () => Promise.resolve(true),
      },
      key,
    );
    expect(out.result).toBe('left');
    expect(
      (
        await cleanStoredVideo(
          {
            client: store.client,
            bucket: 'b',
            logger,
            putObject: putVia(store.client),
            stillWanted: () => Promise.resolve(true),
          },
          'avatars/u/a.png',
        )
      ).result,
    ).toBe('not-video');
  });

  it('removes the file again when its upload was released while it was rewritten', async () => {
    const key = 'profile/work/u1/c.mp4';
    const store = bucket({ [key]: { body: tagged(), type: 'video/mp4' } });
    await cleanStoredVideo(
      {
        client: store.client,
        bucket: 'b',
        logger,
        putObject: putVia(store.client),
        stillWanted: () => Promise.resolve(false),
      },
      key,
    );
    expect(store.deletes).toEqual([key]);
  });

  const deps = (store: ReturnType<typeof bucket>, more = {}) => ({
    client: store.client,
    bucket: 'b',
    logger,
    putObject: putVia(store.client),
    stillWanted: () => Promise.resolve(true),
    ...more,
  });

  it('reads only the version it looked at (If-Match), and checks the ETag again before writing', async () => {
    const key = 'profile/work/u1/e1.mp4';
    const store = bucket({ [key]: { body: tagged(), type: 'video/mp4' } });
    expect((await cleanStoredVideo(deps(store), key)).result).toBe('cleaned');
    const gets = store.calls.filter((c) => c instanceof GetObjectCommand);
    expect(gets.length).toBeGreaterThan(1);
    for (const g of gets) expect(g.input.IfMatch).toMatch(/^"e\d+"$/);
    expect(
      store.calls.filter((c) => c instanceof HeadObjectCommand),
    ).toHaveLength(2);
  });

  it('a replacement during the plan, or just before the write, is never patched or overwritten', async () => {
    for (const during of ['plan', 'before-write']) {
      forgetCleanedVideos();
      const key = `profile/work/u1/r-${during}.mp4`;
      const objects = { [key]: { body: tagged(), type: 'video/mp4' } };
      const store = bucket(objects);
      const replacement = tagged();
      replacement[10] ^= 0x55;
      const swap = () => {
        objects[key] = { body: replacement, type: 'video/mp4' };
      };
      if (during === 'plan') store.hooks.onGet = (n) => n === 1 && swap();
      else store.hooks.onHead = (n) => n === 2 && swap();
      const out = await cleanStoredVideo(deps(store), key);
      expect(out.result).toBe('changed');
      expect(store.puts).toEqual([]);
      expect(objects[key].body.equals(replacement)).toBe(true);
    }
  });

  it('a file that cannot be read is tried once; a failing write three times, then no more reads', async () => {
    const junk = 'content/full/u1/j.mp4';
    const good = 'content/full/u1/g.mp4';
    const store = bucket({
      [junk]: { body: Buffer.from('x'.repeat(200)), type: 'video/mp4' },
      [good]: { body: tagged(), type: 'video/mp4' },
    });
    await cleanStoredVideo(deps(store), junk);
    const after1 = store.heads();
    await cleanStoredVideo(deps(store), junk);
    expect(store.heads()).toBe(after1);

    const orig = store.client.send.bind(store.client);
    (store.client as { send: unknown }).send = (c: unknown, o?: unknown) =>
      c instanceof PutObjectCommand
        ? Promise.reject(new Error('503'))
        : orig(c as never, o as never);
    for (let i = 0; i < 3; i += 1)
      expect((await cleanStoredVideo(deps(store), good)).result).toBe('left');
    const before = store.heads();
    const again = await cleanStoredVideo(deps(store), good);
    expect(again.result).toBe('left');
    expect(store.heads()).toBe(before);
  });

  it('a file above the confirm limit is cleaned right after, not while the person waits', async () => {
    const key = 'profile/work/u1/big.mp4';
    const store = bucket({ [key]: { body: tagged(), type: 'video/mp4' } });
    const out = await cleanStoredVideo(
      deps(store, { inlineMaxBytes: 100 }),
      key,
    );
    expect(out.result).toBe('deferred');
    expect(store.puts).toEqual([]);
    await new Promise((r) => setTimeout(r, 600));
    expect(store.puts).toHaveLength(1);
  });

  it('after the cool-down a key that failed three times is tried again, and a missing file costs no try', async () => {
    const key = 'profile/work/u1/cool.mp4';
    const store = bucket({ [key]: { body: tagged(), type: 'video/mp4' } });
    const orig = store.client.send.bind(store.client);
    let down = true;
    (store.client as { send: unknown }).send = (c: unknown, o?: unknown) =>
      c instanceof PutObjectCommand && down
        ? Promise.reject(new Error('503'))
        : orig(c as never, o as never);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now);
      for (let i = 0; i < 3; i += 1) await cleanStoredVideo(deps(store), key);
      const stuck = store.heads();
      await cleanStoredVideo(deps(store), key);
      expect(store.heads()).toBe(stuck);
      down = false; // the outage is over
      clock.mockReturnValue(now + COOL_DOWN_MS + 1000);
      expect((await cleanStoredVideo(deps(store), key)).result).toBe('cleaned');
    } finally {
      clock.mockRestore();
    }
    const absent = await cleanStoredVideo(
      deps(store),
      'profile/work/u1/none.mp4',
    );
    expect(absent.result).toBe('left');
  });
});
