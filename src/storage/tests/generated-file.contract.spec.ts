// AITOOLS-01: the Hub stores a file it made itself for a person (an AI tool's
// audio). The bucket is a small S3-style server on this machine's loopback,
// spoken to by the AWS SDK over real HTTP; every row is this spec's own.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import * as http from 'http';
import type { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CONTENT_FOLDERS, StorageService } from '../storage.service';

const OWNER = 'a1f00000-0000-4000-8000-000000000001';
const BUCKET = 'ai01-bucket';

describe('A file the Hub made for a person (AITOOLS-01, contract)', () => {
  let server: http.Server;
  let prisma: PrismaService;
  let storage: StorageService;
  const objects = new Map<string, Buffer>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const key = decodeURIComponent((req.url ?? '').split('?')[0]).replace(
          `/${BUCKET}/`,
          '',
        );
        if (req.method === 'PUT') {
          objects.set(key, Buffer.concat(chunks));
          res.statusCode = 200;
        } else if (req.method === 'DELETE') {
          objects.delete(key);
          res.statusCode = 204;
        } else res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    prisma = new PrismaService();
    await prisma.$connect();
    storage = new StorageService(
      new ConfigService({
        STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
        STORAGE_ACCESS_KEY_ID: 'k',
        STORAGE_SECRET_ACCESS_KEY: 's',
        STORAGE_BUCKET: BUCKET,
        STORAGE_FORCE_PATH_STYLE: 'true',
      }),
      prisma,
      {} as never,
      {} as never,
    );
    await prisma.storageObject.deleteMany({ where: { wawuUserId: OWNER } });
  });
  afterAll(async () => {
    await prisma.storageObject.deleteMany({ where: { wawuUserId: OWNER } });
    await prisma.$disconnect();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("stores the file under the person's folder as a confirmed object that no allowance counts, and serves it as audio to play", async () => {
    const audio = Buffer.from('ID3 pretend audio');
    const key = await storage.putGenerated(
      OWNER,
      'ai/voiceover',
      'job-1',
      audio,
      'audio/mpeg',
    );
    expect(key).toBe(`ai/voiceover/${OWNER}/job-1.mp3`);
    expect(objects.get(key)).toEqual(audio);
    const row = await prisma.storageObject.findUnique({ where: { key } });
    expect(row).toMatchObject({
      wawuUserId: OWNER,
      bytes: audio.length,
      contentType: 'audio/mpeg',
      folder: 'ai/voiceover',
      status: 'confirmed',
    });
    expect(row!.confirmedAt).not.toBeNull();
    // A link the app can play from: audio is served in place, with its type.
    const link = new URL(await storage.readUrlFor(key));
    expect(link.pathname).toContain(key);
    expect(link.searchParams.get('response-content-type')).toBe('audio/mpeg');
    expect(link.searchParams.get('response-content-disposition')).toBe(
      'inline',
    );
    // The R-7 allowance counts creator content only.
    expect(CONTENT_FOLDERS).not.toContain(row!.folder);
  });

  it('writing the same name again replaces the file and keeps one row', async () => {
    const key = await storage.putGenerated(
      OWNER,
      'ai/voiceover',
      'job-2',
      Buffer.from('one'),
      'audio/mpeg',
    );
    await storage.putGenerated(
      OWNER,
      'ai/voiceover',
      'job-2',
      Buffer.from('two two'),
      'audio/mpeg',
    );
    expect(objects.get(key)!.toString()).toBe('two two');
    const rows = await prisma.storageObject.findMany({ where: { key } });
    expect(rows).toHaveLength(1);
    expect(rows[0].bytes).toBe(7);
  });

  it('removes the file and its row, and again changes nothing', async () => {
    const key = await storage.putGenerated(
      OWNER,
      'ai/voiceover',
      'job-3',
      Buffer.from('x'),
      'audio/mpeg',
    );
    await storage.removeGenerated(key);
    expect(objects.has(key)).toBe(false);
    expect(
      await prisma.storageObject.findUnique({ where: { key } }),
    ).toBeNull();
    await expect(storage.removeGenerated(key)).resolves.toBeUndefined();
  });

  it('refuses a type the Hub does not serve and a name that is not a plain file name', async () => {
    await expect(
      storage.putGenerated(
        OWNER,
        'ai/voiceover',
        'x',
        Buffer.from('x'),
        'text/html',
      ),
    ).rejects.toThrow();
    for (const name of ['..', 'a/b', '', 'a b'])
      await expect(
        storage.putGenerated(
          OWNER,
          'ai/voiceover',
          name,
          Buffer.from('x'),
          'audio/mpeg',
        ),
      ).rejects.toThrow();
    expect([...objects.keys()].filter((k) => k.includes('/x.'))).toEqual([]);
  });
});
