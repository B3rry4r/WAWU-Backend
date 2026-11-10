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

function bucket(objects: Record<string, { body: Buffer; type: string }>) {
  const puts: { key: string; type?: string; len?: number }[] = [];
  const deletes: string[] = [];
  const client = {
    send: async (cmd: unknown, opts?: unknown) => {
      void opts;
      if (cmd instanceof HeadObjectCommand) {
        const o = objects[cmd.input.Key!];
        if (!o) throw new Error('NoSuchKey');
        return { ContentLength: o.body.length, ContentType: o.type };
      }
      if (cmd instanceof GetObjectCommand) {
        const o = objects[cmd.input.Key!];
        if (!o) throw new Error('NoSuchKey');
        const m = /bytes=(\d+)-(\d+)/.exec(cmd.input.Range ?? '');
        const part = m
          ? o.body.subarray(Number(m[1]), Number(m[2]) + 1)
          : o.body;
        return {
          ContentLength: part.length,
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
  return { client, puts, deletes };
}
const logger = { log: jest.fn(), warn: jest.fn() };

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
        stillWanted: () => Promise.resolve(false),
      },
      key,
    );
    expect(store.deletes).toEqual([key]);
  });
});
