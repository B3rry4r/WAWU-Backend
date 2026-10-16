import { linkNamesStorage, type BucketLocation } from '../storage.service';

/**
 * FIX-24: which links the older single-file delivery route judges by the
 * delivery rule. A link that names this bucket's host, the storage
 * endpoint's host, or a host under either, could read one of our objects, so
 * it is judged; a link on any other host cannot, and is taken as before.
 */

const ENDPOINT = 'https://storage.example.dev';
const VIRTUAL: BucketLocation = {
  origin: 'https://wawu-docs.storage.example.dev',
  pathPrefix: '/',
};
const PATH_STYLE: BucketLocation = {
  origin: 'http://127.0.0.1:5833',
  pathPrefix: '/wawu-docs/',
};
const KEY = 'legal/document/u1/a.pdf';

describe('FIX-24: linkNamesStorage', () => {
  it.each([
    ['the bucket host', `https://wawu-docs.storage.example.dev/${KEY}`],
    [
      'the bucket host over http',
      `http://wawu-docs.storage.example.dev/${KEY}`,
    ],
    [
      'the bucket host on another port',
      `https://wawu-docs.storage.example.dev:8443/${KEY}`,
    ],
    [
      'the bucket host in capitals',
      `https://WAWU-DOCS.Storage.Example.Dev/${KEY}`,
    ],
    [
      'the bucket host with a trailing dot',
      `https://wawu-docs.storage.example.dev./${KEY}`,
    ],
    [
      'the bucket host with userinfo',
      `https://evil@wawu-docs.storage.example.dev/${KEY}`,
    ],
    [
      'a host under the bucket',
      `https://x.wawu-docs.storage.example.dev/${KEY}`,
    ],
    [
      'the endpoint host (path style)',
      `https://storage.example.dev/wawu-docs/${KEY}`,
    ],
    [
      'another bucket under the endpoint',
      `https://other.storage.example.dev/${KEY}`,
    ],
    [
      'a bucket name that ends like ours',
      `https://evilwawu-docs.storage.example.dev/${KEY}`,
    ],
    [
      'a signed link',
      `https://wawu-docs.storage.example.dev/${KEY}?X-Amz-Signature=x`,
    ],
  ])('names our storage: %s', (_l, link) => {
    expect(linkNamesStorage(link, VIRTUAL, ENDPOINT)).toBe(true);
  });

  it.each([
    ['another host', `https://cdn.wawu.test/${KEY}`],
    [
      'our host as a suffix of another',
      `https://wawu-docs.storage.example.dev.evil.example/${KEY}`,
    ],
    [
      'the endpoint host glued to another name',
      `https://evil-storage.example.dev/${KEY}`,
    ],
    [
      'our host as userinfo',
      `https://wawu-docs.storage.example.dev@evil.example/${KEY}`,
    ],
    [
      'our host in the path',
      `https://evil.example/wawu-docs.storage.example.dev/${KEY}`,
    ],
    [
      'our host in the query',
      `https://evil.example/?u=https://wawu-docs.storage.example.dev/${KEY}`,
    ],
    [
      'the endpoint as a suffix of a longer name',
      `https://xstorage.example.dev/${KEY}`,
    ],
    ['not a link', KEY],
    ['an empty string', ''],
    ['a number', 7],
    ['null', null],
  ])('does not name our storage: %s', (_l, link) => {
    expect(linkNamesStorage(link, VIRTUAL, ENDPOINT)).toBe(false);
  });

  it('reads a path-style bucket by its IP host, whatever form the IP is written in', () => {
    for (const link of [
      `http://127.0.0.1:5833/wawu-docs/${KEY}`,
      `http://2130706433:5833/wawu-docs/${KEY}`,
      `http://0x7f.0.0.1/wawu-docs/${KEY}`,
    ]) {
      expect(linkNamesStorage(link, PATH_STYLE, 'http://127.0.0.1:5833')).toBe(
        true,
      );
    }
    expect(
      linkNamesStorage(`http://127.0.0.2/${KEY}`, PATH_STYLE, undefined),
    ).toBe(false);
  });

  it('names nothing when storage is not configured', () => {
    expect(
      linkNamesStorage(
        `https://wawu-docs.storage.example.dev/${KEY}`,
        null,
        undefined,
      ),
    ).toBe(false);
    expect(
      linkNamesStorage(`https://storage.example.dev/${KEY}`, null, ''),
    ).toBe(false);
  });

  it('reads the endpoint alone when the bucket location is unknown', () => {
    expect(
      linkNamesStorage(
        `https://wawu-docs.storage.example.dev/${KEY}`,
        null,
        ENDPOINT,
      ),
    ).toBe(true);
  });
});
