import { ConfigService } from '@nestjs/config';
import {
  EXTENSION_FOR_CONTENT_TYPE,
  MAX_UPLOAD_BYTES,
  PresignUploadDto,
} from '../dto/presign-upload.dto';
import { StorageService } from '../storage.service';
import {
  UPLOAD_FORMAT_IDS,
  UPLOAD_FORMATS,
  uploadFormatsView,
} from '../upload-formats';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  publishingOver,
  publishingTables,
} from '../../plans/tests/publishing-fakes';

/**
 * ME-04: what each content format may upload (M20 to M22). The table is served
 * by GET /uploads/formats and applied by POST /uploads/presign when a call
 * names a `format`; a call that names none is checked exactly as before.
 */
const MB = 1024 * 1024;

function serviceWith(): StorageService {
  const values: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://example-bucket.t3.storageapi.dev',
    STORAGE_ACCESS_KEY_ID: 'tid_test',
    STORAGE_SECRET_ACCESS_KEY: 'secret_test',
    STORAGE_BUCKET: 'example-bucket',
    STORAGE_REGION: 'sjc',
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  const prisma = {
    storageObject: {
      aggregate: () => Promise.resolve({ _sum: { bytes: 0 } }),
      create: () => Promise.resolve({}),
      findMany: () => Promise.resolve([]),
      update: () => Promise.resolve({}),
    },
    // `user-1` holds a running tier with room, so a content file may be
    // signed for it (TIER-02): these tests are about the format caps.
    ...publishingTables(
      { tier: { endsInDays: 30, productsIncluded: 3 }, slotsUsed: 0 },
      'user-1',
    ),
  } as unknown as PrismaService;
  const { allowance, gate } = publishingOver(prisma);
  return new StorageService(config, prisma, allowance, gate);
}

describe('the format table', () => {
  it('covers every format the create call takes, once each', () => {
    expect(UPLOAD_FORMATS.map((f) => f.id)).toEqual([...UPLOAD_FORMAT_IDS]);
  });

  it('only lists types the Hub stores and serves under a known extension', () => {
    for (const f of UPLOAD_FORMATS) {
      for (const type of [...f.full.contentTypes, ...f.preview.contentTypes]) {
        expect(EXTENSION_FOR_CONTENT_TYPE[type]).toBeTruthy();
        // Never a page that can run: markup and vector images stay out.
        expect(type).not.toMatch(
          /^(text\/(html|xml|javascript)|image\/svg|application\/(xhtml|xml|javascript))/,
        );
      }
    }
  });

  it('serves the table with an extension for every type', () => {
    const { formats } = uploadFormatsView();
    const video = formats.find((f) => f.id === 'video');
    expect(video?.full.extensions).toEqual(['mp4', 'mov']);
    const audio = formats.find((f) => f.id === 'audio');
    expect(audio?.full.extensions).toEqual(['mp3', 'wav']);
    expect(audio?.preview.seconds).toEqual({ min: 30, max: 60 });
    expect(formats.find((f) => f.id === 'pdf')?.full.maxBytes).toBe(100 * MB);
  });

  it('never sizes a format above the one cap the Hub has', () => {
    for (const f of UPLOAD_FORMATS) {
      expect(f.full.maxBytes).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
      expect(f.preview.maxBytes).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    }
  });
});

describe('POST /uploads/presign with a format', () => {
  const service = serviceWith();

  it('takes a PDF up to its cap, and refuses one byte over', async () => {
    const ok = await service.presignUpload(
      'user-1',
      'content/full',
      'application/pdf',
      'pdf',
      100 * MB,
      'pdf',
    );
    expect(ok.key).toMatch(/^content\/full\/user-1\/.+\.pdf$/);
    await expect(
      service.presignUpload(
        'user-1',
        'content/full',
        'application/pdf',
        'pdf',
        100 * MB + 1,
        'pdf',
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('leaves a call with no format on the one global cap', async () => {
    const ok = await service.presignUpload(
      'user-1',
      'content/full',
      'application/pdf',
      'pdf',
      100 * MB + 1,
    );
    expect(ok.key).toMatch(/\.pdf$/);
  });

  it('refuses a type the format does not take, though the folder does', async () => {
    await expect(
      service.presignUpload(
        'user-1',
        'content/full',
        'application/pdf',
        'pdf',
        1000,
        'video',
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.presignUpload(
        'user-1',
        'content/full',
        'video/webm',
        'webm',
        1000,
        'video',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('takes an MP3 or WAV clip as the preview of an audio piece', async () => {
    const mp3 = await service.presignUpload(
      'user-1',
      'content/preview',
      'audio/mpeg',
      'mp3',
      1000,
      'audio',
    );
    expect(mp3.key).toMatch(/^content\/preview\/user-1\/.+\.mp3$/);
    const wav = await service.presignUpload(
      'user-1',
      'content/preview',
      'audio/wav',
      'wav',
      1000,
      'audio',
    );
    expect(wav.key).toMatch(/\.wav$/);
  });

  it('still refuses audio in the preview folder when no format is named', async () => {
    await expect(
      service.presignUpload(
        'user-1',
        'content/preview',
        'audio/mpeg',
        'mp3',
        1000,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a format on any other folder', async () => {
    await expect(
      service.presignUpload(
        'user-1',
        'avatars',
        'image/png',
        'png',
        1000,
        'image',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('PresignUploadDto format', () => {
  const body = {
    folder: 'content/full',
    contentType: 'application/pdf',
    extension: 'pdf',
    contentLength: 1000,
  };

  it('is optional, and one of the six formats when given', async () => {
    expect(
      await validate(plainToInstance(PresignUploadDto, body)),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(PresignUploadDto, { ...body, format: 'pdf' }),
      ),
    ).toHaveLength(0);
    const bad = await validate(
      plainToInstance(PresignUploadDto, { ...body, format: 'gif' }),
    );
    expect(bad.map((e) => e.property)).toEqual(['format']);
  });
});
