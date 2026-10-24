import { ConfigService } from '@nestjs/config';
import {
  AI_INPUT_FOLDERS,
  AI_INPUT_MAX_BYTES,
  FOLDER_CONTENT_TYPES,
  UPLOAD_FOLDERS,
} from '../dto/presign-upload.dto';
import {
  CONTENT_FOLDERS,
  KEY_FOLDERS,
  StorageService,
} from '../storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  publishingOver,
  publishingTables,
} from '../../plans/tests/publishing-fakes';

/**
 * AITOOLS-04: the two private folders a person's file for Captions or Clean
 * audio goes in. They take the audio and video types the Hub already serves,
 * are capped by the setting `ai.input_max_bytes`, and are not creator content
 * (the 5 item allowance and the storage allowance never see them).
 */
function serviceWith(maxBytes: number | null): {
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
  const settings =
    maxBytes === null
      ? undefined
      : ({ number: () => maxBytes } as unknown as PlanSettingsService);
  return {
    service: new StorageService(config, prisma, allowance, gate, settings),
    created,
  };
}

describe("AITOOLS-04: the folders for a person's own file", () => {
  it('are offered by the presign, take the served audio and video types, and are not creator content', () => {
    expect([...AI_INPUT_FOLDERS]).toEqual(['ai/input-audio', 'ai/input-video']);
    for (const f of AI_INPUT_FOLDERS) {
      expect(UPLOAD_FOLDERS).toContain(f);
      expect(KEY_FOLDERS).toContain(f);
      expect(CONTENT_FOLDERS).not.toContain(f);
    }
    expect(FOLDER_CONTENT_TYPES['ai/input-audio']).toEqual([
      'audio/mpeg',
      'audio/wav',
      'audio/mp4',
      'audio/aac',
    ]);
    expect(FOLDER_CONTENT_TYPES['ai/input-video']).toEqual([
      'video/mp4',
      'video/quicktime',
      'video/webm',
    ]);
  });

  it("sign a key under the person's own id with the extension of the validated type, and count in no allowance even when the account is full", async () => {
    const { service, created } = serviceWith(AI_INPUT_MAX_BYTES);
    const audio = await service.presignUpload(
      'user-1',
      'ai/input-audio',
      'audio/wav',
      'exe',
      1_000_000,
    );
    expect(audio.key).toMatch(/^ai\/input-audio\/user-1\/[0-9a-f-]{36}\.wav$/);
    const video = await service.presignUpload(
      'user-1',
      'ai/input-video',
      'video/quicktime',
      'mp4',
      1_000_000,
    );
    expect(video.key).toMatch(/^ai\/input-video\/user-1\/[0-9a-f-]{36}\.mov$/);
    expect(created.map((c) => c.folder)).toEqual([
      'ai/input-audio',
      'ai/input-video',
    ]);
  });

  it('refuse a type the folder does not take (a video in the audio folder, an ogg, a page)', async () => {
    const { service } = serviceWith(AI_INPUT_MAX_BYTES);
    for (const [folder, type] of [
      ['ai/input-audio', 'video/mp4'],
      ['ai/input-audio', 'audio/ogg'],
      ['ai/input-audio', 'text/html'],
      ['ai/input-video', 'audio/mpeg'],
      ['ai/input-video', 'image/svg+xml'],
    ] as const)
      await expect(
        service.presignUpload('user-1', folder, type, 'x', 1000),
      ).rejects.toThrow(/is not allowed in/);
  });

  it('refuse a file over the setting `ai.input_max_bytes`, which an admin may only lower', async () => {
    const lowered = serviceWith(5_000_000).service;
    await expect(
      lowered.presignUpload(
        'user-1',
        'ai/input-audio',
        'audio/mpeg',
        'mp3',
        5_000_001,
      ),
    ).rejects.toThrow(/at most 5 MB|at most 4\.\d+ MB|can be at most/);
    await expect(
      lowered.presignUpload(
        'user-1',
        'ai/input-audio',
        'audio/mpeg',
        'mp3',
        5_000_000,
      ),
    ).resolves.toHaveProperty('key');
    // A setting above the folder's ceiling does not raise it.
    const raised = serviceWith(900 * 1024 * 1024).service;
    await expect(
      raised.presignUpload(
        'user-1',
        'ai/input-video',
        'video/mp4',
        'mp4',
        AI_INPUT_MAX_BYTES + 1,
      ),
    ).rejects.toThrow(/can be at most/);
    // Without the settings (a hand-built service) the folder's own ceiling holds.
    const bare = serviceWith(null).service;
    await expect(
      bare.presignUpload(
        'user-1',
        'ai/input-video',
        'video/mp4',
        'mp4',
        AI_INPUT_MAX_BYTES + 1,
      ),
    ).rejects.toThrow(/can be at most/);
  });
});
