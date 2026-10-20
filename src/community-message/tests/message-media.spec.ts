import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../storage/storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { PublishingAllowanceService } from '../../plans/publishing-allowance.service';
import type { PublishingGate } from '../../plans/publishing-gate.service';
import {
  MESSAGE_MEDIA_FOLDERS,
  ownMediaKey,
  withFreshMedia,
  type MessageMediaRow,
} from '../message-media';

/**
 * FIX-71 (G-INBOX-22-2). A community message's photo, video and voice note are
 * stored as the 7-day signed link the app sent. These specs cover the two
 * halves of signing them again on the way out: which key is ever signed (only
 * the sender's own, in the folder for that kind), and what comes back for it (a
 * link signed now, so a message stored 8 days ago loads). They need no
 * database and no bucket: a presigned link is computed locally.
 */
const HOST = 'https://fix71-bucket.test.invalid';
const SENDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FILE = '0a1b2c3d-0a1b-4c3d-8a1b-0a1b2c3d4e5f';

function storage(configured = true): StorageService {
  const values: Record<string, string> = configured
    ? {
        STORAGE_ENDPOINT: HOST,
        STORAGE_ACCESS_KEY_ID: 'tid_test',
        STORAGE_SECRET_ACCESS_KEY: 'secret_test',
        STORAGE_BUCKET: 'fix71-bucket',
        STORAGE_REGION: 'sjc',
      }
    : {};
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new StorageService(
    config,
    {} as unknown as PrismaService,
    {} as unknown as PublishingAllowanceService,
    {} as unknown as PublishingGate,
  );
}

/** The link `POST /uploads/presign` handed back 8 days ago: signed for 7 days, so dead today. */
function eightDayOldLink(key: string): string {
  const stamp =
    new Date(Date.now() - 8 * 24 * 3600 * 1000)
      .toISOString()
      .replace(/[-:]/g, '')
      .slice(0, 15) + 'Z';
  return (
    `${HOST}/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${stamp}` +
    `&X-Amz-Expires=604800&X-Amz-Signature=dead0000beef`
  );
}

function row(over: Partial<MessageMediaRow> = {}): MessageMediaRow {
  return {
    senderWawuId: SENDER,
    imageUrl: null,
    videoUrl: null,
    voiceUrl: null,
    ...over,
  };
}

/** True when `link` is signed now, for 7 days, for exactly `key`. */
function expectSignedNowFor(link: string | null, key: string): void {
  expect(link).not.toBeNull();
  const url = new URL(link as string);
  expect(decodeURIComponent(url.pathname)).toBe(`/${key}`);
  expect(url.searchParams.get('X-Amz-Signature')).not.toBe('dead0000beef');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
  const date = url.searchParams.get('X-Amz-Date') as string;
  const signedAt = Date.parse(
    date.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  );
  expect(Math.abs(Date.now() - signedAt)).toBeLessThan(5 * 60 * 1000);
}

describe('community message media, signed again on read (FIX-71)', () => {
  const imageKey = `community/message/${SENDER}/${FILE}.jpg`;
  const videoKey = `community/message-video/${SENDER}/${FILE}.mp4`;
  const voiceKey = `community/message-voice/${SENDER}/${FILE}.m4a`;

  describe('a message stored 8 days ago', () => {
    it('gets a link signed now for its photo, video and voice note', async () => {
      const s = storage();
      const photo = await withFreshMedia(
        s,
        row({ imageUrl: eightDayOldLink(imageKey) }),
      );
      expectSignedNowFor(photo.imageUrl, imageKey);

      const video = await withFreshMedia(
        s,
        row({ videoUrl: eightDayOldLink(videoKey) }),
      );
      expectSignedNowFor(video.videoUrl, videoKey);

      const voice = await withFreshMedia(
        s,
        row({ voiceUrl: eightDayOldLink(voiceKey) }),
      );
      expectSignedNowFor(voice.voiceUrl, voiceKey);
    });

    it('plays in place: a video and a voice note are signed to open inline', async () => {
      const s = storage();
      const video = await withFreshMedia(
        s,
        row({ videoUrl: eightDayOldLink(videoKey) }),
      );
      const url = new URL(video.videoUrl as string);
      expect(url.searchParams.get('response-content-disposition')).toBe(
        'inline',
      );
      expect(url.searchParams.get('response-content-type')).toBe('video/mp4');
    });

    it('works for a path-style link as well (the bucket name before the key)', async () => {
      const stored = `https://storage.test.invalid/fix71-bucket/${imageKey}?X-Amz-Signature=dead0000beef`;
      const out = await withFreshMedia(storage(), row({ imageUrl: stored }));
      expectSignedNowFor(out.imageUrl, imageKey);
    });

    it('works when the row holds the bare key', async () => {
      const out = await withFreshMedia(storage(), row({ imageUrl: imageKey }));
      expectSignedNowFor(out.imageUrl, imageKey);
    });

    it('changes nothing else on the row', async () => {
      const original = row({ imageUrl: eightDayOldLink(imageKey) });
      const out = await withFreshMedia(storage(), original);
      expect(out.senderWawuId).toBe(SENDER);
      expect(out.videoUrl).toBeNull();
      expect(out.voiceUrl).toBeNull();
      // The row that was read is not rewritten.
      expect(original.imageUrl).toContain('dead0000beef');
    });
  });

  describe('a link is signed for the sender own file only', () => {
    const FOREIGN: Array<[string, keyof typeof MESSAGE_MEDIA_FOLDERS, string]> =
      [
        [
          "another person's photo",
          'imageUrl',
          `community/message/${OTHER}/${FILE}.jpg`,
        ],
        [
          "another person's video",
          'videoUrl',
          `community/message-video/${OTHER}/${FILE}.mp4`,
        ],
        [
          "another person's voice note",
          'voiceUrl',
          `community/message-voice/${OTHER}/${FILE}.m4a`,
        ],
        [
          'an identity document',
          'imageUrl',
          `kyc/id-document/${SENDER}/${FILE}.jpg`,
        ],
        [
          "another person's identity document",
          'imageUrl',
          `kyc/id-document/${OTHER}/${FILE}.jpg`,
        ],
        ['an avatar', 'imageUrl', `avatars/${SENDER}/${FILE}.jpg`],
        ['a chat attachment', 'imageUrl', `chat/media/${SENDER}/${FILE}.jpg`],
        [
          'a legal document',
          'imageUrl',
          `legal/document/${SENDER}/${FILE}.pdf`,
        ],
        [
          'a video file in the photo field',
          'imageUrl',
          `community/message-video/${SENDER}/${FILE}.mp4`,
        ],
        [
          'a photo file in the video field',
          'videoUrl',
          `community/message/${SENDER}/${FILE}.jpg`,
        ],
        [
          'a voice note file in the video field',
          'videoUrl',
          `community/message-voice/${SENDER}/${FILE}.m4a`,
        ],
        [
          'a file deeper in the sender folder',
          'imageUrl',
          `community/message/${SENDER}/sub/${FILE}.jpg`,
        ],
      ];

    for (const [what, field, key] of FOREIGN) {
      it(`never signs ${what}, as a link or as a bare key`, async () => {
        const s = storage();
        const sign = jest.spyOn(s, 'freshUrlFor');
        const read = jest.spyOn(s, 'readUrlFor');
        const asLink = eightDayOldLink(key);
        for (const stored of [asLink, key]) {
          const out = await withFreshMedia(s, row({ [field]: stored }));
          expect(out[field]).toBe(stored);
        }
        expect(sign).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      });
    }

    it('never signs a link to somewhere else, and leaves it as it was', async () => {
      const s = storage();
      const sign = jest.spyOn(s, 'freshUrlFor');
      const external = 'https://cdn.example.com/some/other/image.png';
      const out = await withFreshMedia(s, row({ imageUrl: external }));
      expect(out.imageUrl).toBe(external);
      expect(sign).not.toHaveBeenCalled();
    });

    it('never signs a key that climbs out of the folder', async () => {
      const s = storage();
      const sign = jest.spyOn(s, 'freshUrlFor');
      for (const stored of [
        `${HOST}/community/message/${SENDER}/../${OTHER}/${FILE}.jpg?sig=1`,
        `${HOST}/community/message/${SENDER}/%2e%2e/${OTHER}/${FILE}.jpg?sig=1`,
        `community/message/${SENDER}/../${OTHER}/${FILE}.jpg`,
      ]) {
        const out = await withFreshMedia(s, row({ imageUrl: stored }));
        expect(out.imageUrl).toBe(stored);
      }
      expect(sign).not.toHaveBeenCalled();
    });

    it('does not mistake a sender id for a prefix of another', async () => {
      const s = storage();
      const sign = jest.spyOn(s, 'freshUrlFor');
      const stored = `community/message/${SENDER}9/${FILE}.jpg`;
      const out = await withFreshMedia(s, row({ imageUrl: stored }));
      expect(out.imageUrl).toBe(stored);
      expect(sign).not.toHaveBeenCalled();
    });
  });

  describe('ownMediaKey', () => {
    it('returns the key of the sender own file, from a link or a key', () => {
      expect(ownMediaKey(eightDayOldLink(imageKey), 'imageUrl', SENDER)).toBe(
        imageKey,
      );
      expect(ownMediaKey(voiceKey, 'voiceUrl', SENDER)).toBe(voiceKey);
    });

    it('returns null for anything else', () => {
      expect(ownMediaKey(imageKey, 'imageUrl', OTHER)).toBeNull();
      expect(ownMediaKey(imageKey, 'videoUrl', SENDER)).toBeNull();
      expect(ownMediaKey('not a key', 'imageUrl', SENDER)).toBeNull();
      expect(ownMediaKey('', 'imageUrl', SENDER)).toBeNull();
    });
  });

  describe('when storage cannot sign', () => {
    it('leaves the stored link as it was when storage is not configured', async () => {
      const stored = eightDayOldLink(imageKey);
      const out = await withFreshMedia(
        storage(false),
        row({ imageUrl: stored }),
      );
      expect(out.imageUrl).toBe(stored);
    });

    it('leaves the stored link as it was when signing fails, and does not throw', async () => {
      const s = storage();
      jest.spyOn(s, 'readUrlFor').mockRejectedValue(new Error('no keys'));
      const stored = eightDayOldLink(imageKey);
      const out = await withFreshMedia(s, row({ imageUrl: stored }));
      expect(out.imageUrl).toBe(stored);
    });
  });

  describe('a message with nothing to sign', () => {
    it('is returned as the same row', async () => {
      const s = storage();
      const sign = jest.spyOn(s, 'freshUrlFor');
      const plain = row();
      expect(await withFreshMedia(s, plain)).toBe(plain);
      expect(sign).not.toHaveBeenCalled();
    });
  });
});
