import { ConfigService } from '@nestjs/config';
import {
  AI_INPUT_IMAGE_FOLDER,
  AI_INPUT_IMAGE_MAX_BYTES,
  FOLDER_CONTENT_TYPES,
  UPLOAD_FOLDERS,
} from '../dto/presign-upload.dto';
import {
  CONTENT_FOLDERS,
  KEY_FOLDERS,
  StorageService,
} from '../storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  publishingOver,
  publishingTables,
} from '../../plans/tests/publishing-fakes';

/**
 * AITOOLS-08 (R-109): the private folder a person's photo for Edit a photo,
 * Make a video or Talking photo goes in. It takes the three picture types the
 * Hub serves, at most 25 MB (the provider's inline limit), and is not creator
 * content (the 5 item allowance and the storage allowance never see it).
 */
function serviceWith(): {
  service: StorageService;
  created: { folder: string; key: string; bytes: number }[];
} {
  const values: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://example-bucket.t3.storageapi.dev',
    STORAGE_ACCESS_KEY_ID: 'tid_test',
    STORAGE_SECRET_ACCESS_KEY: 'secret_test',
    STORAGE_BUCKET: 'example-bucket',
    STORAGE_REGION: 'sjc',
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  const created: { folder: string; key: string; bytes: number }[] = [];
  const prisma = {
    storageObject: {
      // The account is FULL: a creator content file would be refused.
      aggregate: () =>
        Promise.resolve({ _sum: { bytes: 5 * 1024 * 1024 * 1024 } }),
      create: ({ data }: { data: (typeof created)[number] }) => {
        created.push(data);
        return Promise.resolve({});
      },
      findMany: () => Promise.resolve([]),
      update: () => Promise.resolve({}),
    },
    ...publishingTables({ slotsUsed: 5 }, 'user-1'),
  } as unknown as PrismaService;
  const { allowance, gate } = publishingOver(prisma);
  return {
    service: new StorageService(config, prisma, allowance, gate),
    created,
  };
}

describe("AITOOLS-08: the folder for a person's photo (ai/input-image)", () => {
  it('is offered by the presign, takes the three picture types, and is not creator content', () => {
    expect(UPLOAD_FOLDERS).toContain(AI_INPUT_IMAGE_FOLDER);
    expect(KEY_FOLDERS).toContain(AI_INPUT_IMAGE_FOLDER);
    expect(CONTENT_FOLDERS).not.toContain(AI_INPUT_IMAGE_FOLDER);
    expect(FOLDER_CONTENT_TYPES[AI_INPUT_IMAGE_FOLDER]).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
    expect(AI_INPUT_IMAGE_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it("signs a key under the person's own id with the extension of the validated type, and counts in no allowance even when the account is full", async () => {
    const { service, created } = serviceWith();
    const png = await service.presignUpload(
      'user-1',
      AI_INPUT_IMAGE_FOLDER,
      'image/png',
      'exe',
      1_000_000,
    );
    expect(png.key).toMatch(/^ai\/input-image\/user-1\/[0-9a-f-]{36}\.png$/);
    const jpeg = await service.presignUpload(
      'user-1',
      AI_INPUT_IMAGE_FOLDER,
      'image/jpeg',
      'png',
      AI_INPUT_IMAGE_MAX_BYTES,
    );
    expect(jpeg.key).toMatch(/\.jpg$/);
    expect(created.map((c) => c.folder)).toEqual([
      AI_INPUT_IMAGE_FOLDER,
      AI_INPUT_IMAGE_FOLDER,
    ]);
  });

  it('refuses a type the folder does not take (a page, a vector picture, a GIF, a video) and a photo over 25 MB', async () => {
    const { service } = serviceWith();
    for (const type of [
      'image/svg+xml',
      'image/gif',
      'text/html',
      'video/mp4',
      'application/pdf',
    ])
      await expect(
        service.presignUpload('user-1', AI_INPUT_IMAGE_FOLDER, type, 'x', 1000),
      ).rejects.toThrow(/is not allowed in/);
    await expect(
      service.presignUpload(
        'user-1',
        AI_INPUT_IMAGE_FOLDER,
        'image/png',
        'png',
        AI_INPUT_IMAGE_MAX_BYTES + 1,
      ),
    ).rejects.toThrow(/can be at most 25MB/);
  });
});
