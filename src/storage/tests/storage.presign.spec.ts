import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage.service';
import { serveAs } from '../dto/presign-upload.dto';

/**
 * Regression cover for the bug that made EVERY upload in the product fail.
 *
 * The AWS SDK changed a default: since v3.729 `requestChecksumCalculation`
 * is 'WHEN_SUPPORTED', so PutObject carries an integrity checksum. Presigning
 * has no body, so the SDK checksummed nothing and signed
 * `x-amz-checksum-crc32=AAAAAA==` — CRC32 of zero bytes — into the URL. The
 * browser then PUT the real file and storage rejected it with 400. Nothing
 * in the codebase noticed, because nothing tested the shape of the URL.
 *
 * These assertions are about the URL we hand the browser, so they need no
 * bucket and no network.
 */
const CRC32_OF_NOTHING = 'AAAAAA==';

function serviceWith(): StorageService {
  const values: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://example-bucket.t3.storageapi.dev',
    STORAGE_ACCESS_KEY_ID: 'tid_test',
    STORAGE_SECRET_ACCESS_KEY: 'secret_test',
    STORAGE_BUCKET: 'example-bucket',
    STORAGE_REGION: 'sjc',
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new StorageService(config);
}

describe('StorageService presigning', () => {
  const service = serviceWith();

  describe('upload URLs', () => {
    it('carries no checksum parameter', async () => {
      const { uploadUrl } = await service.presignUpload(
        'user-1', 'kyc/id-document', 'image/jpeg', 'jpeg', 12345,
      );
      const q = new URL(uploadUrl).searchParams;
      expect(q.get('x-amz-checksum-crc32')).toBeNull();
      expect(q.get('x-amz-sdk-checksum-algorithm')).toBeNull();
      expect(uploadUrl).not.toContain(CRC32_OF_NOTHING);
    });

    it('signs only headers a browser actually sends', async () => {
      const { uploadUrl } = await service.presignUpload(
        'user-1', 'kyc/id-document', 'image/jpeg', 'jpeg', 12345,
      );
      const signed = new URL(uploadUrl).searchParams.get('X-Amz-SignedHeaders');
      // A browser sets Content-Length itself and forbids scripts from setting
      // it, so signing it is safe and enforces the size cap. Anything else
      // signed here has to be sent by our uploader by hand, or the PUT fails
      // signature verification — which is what Content-Disposition did.
      expect(signed).toBe('content-length;host');
      expect(signed).not.toContain('content-disposition');
    });

    it('names the object from the validated type, not the caller extension', async () => {
      const { key } = await service.presignUpload(
        // A caller claiming an .html extension for an allowed image type.
        'user-1', 'content/preview', 'image/png', 'html', 100,
      );
      expect(key.endsWith('.png')).toBe(true);
      expect(key).not.toContain('html');
    });

    it('rejects a type the destination does not allow', async () => {
      await expect(
        service.presignUpload('user-1', 'avatars', 'text/html', 'html', 100),
      ).rejects.toThrow(/not allowed in avatars/);
    });

    it('namespaces the key by the caller, so one account cannot overwrite another', async () => {
      const a = await service.presignUpload('user-a', 'avatars', 'image/png', 'png', 10);
      const b = await service.presignUpload('user-b', 'avatars', 'image/png', 'png', 10);
      expect(a.key.startsWith('avatars/user-a/')).toBe(true);
      expect(b.key.startsWith('avatars/user-b/')).toBe(true);
    });
  });

  describe('read URLs force how the bytes are served', () => {
    it('serves an image inline as its own type', async () => {
      const url = await service.readUrlFor('content/preview/user-1/cover.png');
      const q = new URL(url).searchParams;
      expect(q.get('response-content-type')).toBe('image/png');
      expect(q.get('response-content-disposition')).toBe('inline');
    });

    it('never serves a PDF inline', async () => {
      const url = await service.readUrlFor('content/full/user-1/guide.pdf');
      const q = new URL(url).searchParams;
      expect(q.get('response-content-disposition')).toBe('attachment');
    });

    it('serves an unrecognised extension as an opaque download', async () => {
      const url = await service.readUrlFor('content/full/user-1/legacy.bin');
      const q = new URL(url).searchParams;
      expect(q.get('response-content-type')).toBe('application/octet-stream');
      expect(q.get('response-content-disposition')).toBe('attachment');
    });

    it('always sends a KYC document as an attachment', async () => {
      const url = await service.signedReadUrl('kyc/id-document/user-1/id.jpg');
      expect(new URL(url).searchParams.get('response-content-disposition')).toBe('attachment');
    });

    it('expires a KYC read URL far sooner than a content one', async () => {
      const kyc = await service.signedReadUrl('kyc/id-document/user-1/id.jpg');
      const content = await service.readUrlFor('content/preview/user-1/cover.png');
      const secs = (u: string) => Number(new URL(u).searchParams.get('X-Amz-Expires'));
      expect(secs(kyc)).toBeLessThan(secs(content));
    });
  });

  describe('serveAs', () => {
    it.each([
      ['a.png', 'image/png', true],
      ['a.jpg', 'image/jpeg', true],
      ['a.pdf', 'application/pdf', false],
      ['a.mp4', 'video/mp4', false],
      ['a.html', 'application/octet-stream', false],
      ['no-extension', 'application/octet-stream', false],
    ])('%s -> %s (inline: %s)', (key, contentType, inline) => {
      expect(serveAs(key)).toEqual({ contentType, inline });
    });
  });
});
