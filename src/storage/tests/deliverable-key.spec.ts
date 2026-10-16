import { ConfigService } from '@nestjs/config';
import {
  DELIVERABLE_KEY_FOLDERS,
  StorageService,
  deliverableKeyFrom,
  type BucketLocation,
} from '../storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * LEGAL-03 round 5 (N1): a delivered legal file is a bare key or a link on
 * this bucket's own host, under `legal/document/`, and nothing else. These
 * are the pure rule and the bucket location the rule is given; the route is
 * covered in `legal-consultations-round5.contract.spec.ts`.
 */

function serviceWith(extra: Record<string, string> = {}): StorageService {
  const values: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://storage.example.dev',
    STORAGE_ACCESS_KEY_ID: 'tid_test',
    STORAGE_SECRET_ACCESS_KEY: 'secret_test',
    STORAGE_BUCKET: 'wawu-docs',
    STORAGE_REGION: 'auto',
    ...extra,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new StorageService(config, {} as PrismaService);
}

const AT: BucketLocation = {
  origin: 'https://wawu-docs.storage.example.dev',
  pathPrefix: '/',
};
const KEY = 'legal/document/u1/11111111-2222-3333-4444-555555555555.pdf';
const LINK = `${AT.origin}/${KEY}?X-Amz-Expires=604800&X-Amz-Signature=abc`;
const KYC = 'kyc/id-document/u2/22222222-3333-4444-5555-666666666666.jpg';

describe('LEGAL-03 round 5: which delivered files may be signed', () => {
  it('reads the bucket host from the storage client (virtual-hosted)', async () => {
    await expect(serviceWith().bucketLocation()).resolves.toEqual(AT);
  });

  it('reads the bucket host from the storage client (path style)', async () => {
    await expect(
      serviceWith({ STORAGE_FORCE_PATH_STYLE: 'true' }).bucketLocation(),
    ).resolves.toEqual({
      origin: 'https://storage.example.dev',
      pathPrefix: '/wawu-docs/',
    });
  });

  it('has no bucket host when storage is not configured', async () => {
    await expect(
      serviceWith({ STORAGE_BUCKET: '' }).bucketLocation(),
    ).resolves.toBeNull();
  });

  it('a link the real presigner makes for a legal document is accepted', async () => {
    const storage = serviceWith();
    const link = await storage.readUrlFor(KEY);
    expect(deliverableKeyFrom(link, await storage.bucketLocation())).toBe(KEY);
  });

  it('takes the key from a link on our bucket, and a bare key', () => {
    expect(deliverableKeyFrom(LINK, AT)).toBe(KEY);
    expect(deliverableKeyFrom(`${AT.origin}/${KEY}`, AT)).toBe(KEY);
    expect(deliverableKeyFrom(KEY, AT)).toBe(KEY);
    expect(deliverableKeyFrom(KEY, null)).toBe(KEY);
    expect(
      deliverableKeyFrom(`https://storage.example.dev/wawu-docs/${KEY}`, {
        origin: 'https://storage.example.dev',
        pathPrefix: '/wawu-docs/',
      }),
    ).toBe(KEY);
  });

  it('accepts only legal/document today; LEGAL-07 adds its folder to the list', () => {
    expect(DELIVERABLE_KEY_FOLDERS).toEqual(['legal/document']);
  });

  it.each([
    // The verifier's probe: a KYC key, on any host.
    ['the KYC key on another host', `https://not-the-bucket.example/${KYC}`],
    ['the KYC key on our host', `${AT.origin}/${KYC}`],
    ['the KYC key, bare', KYC],
    ['the KYC key, signed', `${AT.origin}/${KYC}?X-Amz-Signature=x`],
    // Other folders.
    ['an avatar', 'avatars/u1/a.png'],
    ['a content file', `${AT.origin}/content/full/u1/a.pdf`],
    ['a professional document', 'professional/document/u1/a.pdf'],
    ['the folder itself', 'legal/document'],
    ['the folder with a slash', 'legal/document/'],
    ['a look-alike folder', 'legal/documents/u1/a.pdf'],
    ['a prefix inside', 'x/legal/document/u1/a.pdf'],
    ['an absolute key', `/${KEY}`],
    // Another host.
    ['another host', `https://files.example.com/${KEY}`],
    ['our endpoint, not the bucket', `https://storage.example.dev/${KEY}`],
    ['userinfo', `https://wawu-docs.storage.example.dev@evil.example/${KEY}`],
    [
      'userinfo on our host',
      `https://u:p@wawu-docs.storage.example.dev/${KEY}`,
    ],
    [
      'a longer host',
      `https://wawu-docs.storage.example.dev.evil.example/${KEY}`,
    ],
    ['a subdomain', `https://x.wawu-docs.storage.example.dev/${KEY}`],
    ['a port', `https://wawu-docs.storage.example.dev:8443/${KEY}`],
    [
      'the default port written',
      `https://wawu-docs.storage.example.dev:443/${KEY}`,
    ],
    ['http', `http://wawu-docs.storage.example.dev/${KEY}`],
    ['protocol-relative', `//wawu-docs.storage.example.dev/${KEY}`],
    ['javascript', `javascript:alert(1)//${KEY}`],
    ['data', `data:text/html,${KEY}`],
    ['upper-case host', `https://WAWU-DOCS.storage.example.dev/${KEY}`],
    ['a trailing dot host', `https://wawu-docs.storage.example.dev./${KEY}`],
    // Path tricks.
    ['a backslash', `${AT.origin}\\${KEY}`],
    ['a backslash in the key', 'legal/document/u1\\..\\..\\kyc/a.jpg'],
    ['dot-dot', 'legal/document/../../kyc/id-document/u2/a.jpg'],
    ['dot-dot in a link', `${AT.origin}/legal/document/../../${KYC}`],
    ['a dot segment', 'legal/document/./u1/a.pdf'],
    ['an empty segment', 'legal/document//u1/a.pdf'],
    ['a segment of three dots', 'legal/document/u1/...'],
    [
      'a segment of three dots, linked',
      `${AT.origin}/legal/document/.../a.pdf`,
    ],
    ['one segment after the folder', 'legal/document/a.pdf'],
    ['three segments after the folder', 'legal/document/u1/x/a.pdf'],
    ['encoded slash', `${AT.origin}/legal%2Fdocument/u1/a.pdf`],
    ['encoded dot-dot', `${AT.origin}/legal/document/%2e%2e/%2e%2e/${KYC}`],
    ['encoded backslash', `${AT.origin}/legal/document/u1%5c..%5ca.pdf`],
    ['double-encoded dot-dot', `${AT.origin}/legal/document/%252e%252e/a.pdf`],
    [
      'encoded host part',
      `https://wawu-docs.storage.example.dev%2f@evil/${KEY}`,
    ],
    // Odd paths: never a key, never stored whole.
    ['a NUL', `${AT.origin}/legal/document/u1/a%00.pdf`],
    ['a lone surrogate', `${AT.origin}/legal/document/u1/a%ED%A0%80.pdf`],
    ['invalid UTF-8', `${AT.origin}/legal/document/u1/a%FF.pdf`],
    ['a newline', `${AT.origin}/legal/document/u1/a%0a.pdf`],
    ['a raw newline', `${AT.origin}/legal/document/u1/a\n.pdf`],
    ['a raw NUL', 'legal/document/u1/a\u0000.pdf'],
    ['a raw space', 'legal/document/u1/a b.pdf'],
    ['a raw non-ASCII letter', 'legal/document/u1/é.pdf'],
    ['a lone surrogate, raw', 'legal/document/u1/\ud800.pdf'],
    ['too long', `legal/document/u1/${'a'.repeat(2100)}`],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(deliverableKeyFrom(value, AT)).toBeNull();
  });

  it('refuses any link when the bucket is not known', () => {
    expect(deliverableKeyFrom(LINK, null)).toBeNull();
  });

  it.each([[undefined], [null], [5], [{}], [[KEY]]])(
    'never throws on %j',
    (value) => {
      expect(deliverableKeyFrom(value, AT)).toBeNull();
    },
  );
});
