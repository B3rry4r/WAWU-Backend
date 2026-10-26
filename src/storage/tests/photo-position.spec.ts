import { ConfigService } from '@nestjs/config';
import { StorageService, objectKeyFrom } from '../storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  publishingOver,
  publishingTables,
} from '../../plans/tests/publishing-fakes';
import {
  cleanPhotoLink,
  cutFragment,
  formatPhotoPosition,
  hasPhotoPosition,
  keepPhotoPosition,
  parsePhotoPosition,
  withPhotoPosition,
} from '../photo-position';

/**
 * Where a person put their picture in its frame (R-96): the grammar of the
 * `#wmt-pos=x,y,zoom,ratio` fragment, and that signing a stored link again
 * (the profile re-sign, StorageService.freshUrlFor) keeps it. No database.
 */
const HOST = 'https://wawu.sfo3.digitaloceanspaces.com';

function storageWithSigner(): StorageService {
  const values: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://example-bucket.t3.storageapi.dev',
    STORAGE_ACCESS_KEY_ID: 'tid_test',
    STORAGE_SECRET_ACCESS_KEY: 'secret_test',
    STORAGE_BUCKET: 'example-bucket',
    STORAGE_REGION: 'sjc',
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  const prisma = {
    storageObject: { aggregate: () => Promise.resolve({ _sum: { bytes: 0 } }) },
    ...publishingTables(
      { tier: { endsInDays: 30, productsIncluded: 3 }, slotsUsed: 0 },
      'user-1',
    ),
  } as unknown as PrismaService;
  const { allowance, gate } = publishingOver(prisma);
  return new StorageService(config, prisma, allowance, gate);
}

describe('photo position fragment', () => {
  it('reads a well formed position', () => {
    expect(parsePhotoPosition('wmt-pos=0.52,0.41,1.8,1.3333')).toEqual({
      x: 0.52,
      y: 0.41,
      zoom: 1.8,
      ratio: 1.3333,
    });
    expect(parsePhotoPosition('wmt-pos=0,1,1,1')).toEqual({
      x: 0,
      y: 1,
      zoom: 1,
      ratio: 1,
    });
    expect(parsePhotoPosition('wmt-pos=0.5,0.5,4,20')).toEqual({
      x: 0.5,
      y: 0.5,
      zoom: 4,
      ratio: 20,
    });
  });

  it.each([
    ['x above 1', 'wmt-pos=1.01,0.5,1,1'],
    ['y above 1', 'wmt-pos=0.5,1.2,1,1'],
    ['zoom below 1', 'wmt-pos=0.5,0.5,0.99,1'],
    ['zoom above 4', 'wmt-pos=0.5,0.5,4.01,1'],
    ['a ratio of 0', 'wmt-pos=0.5,0.5,1,0'],
    ['a ratio above 20', 'wmt-pos=0.5,0.5,1,21'],
    ['a negative number', 'wmt-pos=-0.1,0.5,1,1'],
    ['only three numbers', 'wmt-pos=0.5,0.5,1'],
    ['five numbers', 'wmt-pos=0.5,0.5,1,1,1'],
    ['words', 'wmt-pos=a,b,c,d'],
    ['an exponent', 'wmt-pos=5e-1,0.5,1,1'],
    ['a trailing piece', 'wmt-pos=0.5,0.5,1,1#x'],
    ['nothing', ''],
  ])('refuses %s', (_name, fragment) => {
    expect(parsePhotoPosition(fragment)).toBeNull();
  });

  it('writes the shortest canonical form', () => {
    expect(formatPhotoPosition({ x: 0.5, y: 0.5, zoom: 1, ratio: 1 })).toBe(
      'wmt-pos=0.5,0.5,1,1',
    );
    expect(
      formatPhotoPosition({
        x: 0.123456,
        y: 0.987654,
        zoom: 2.34567,
        ratio: 1.333333,
      }),
    ).toBe('wmt-pos=0.1235,0.9877,2.346,1.3333');
  });

  it('puts a position on a link and takes none off', () => {
    const base = `${HOST}/avatars/u1/a.jpg?X-Amz-Signature=s`;
    expect(withPhotoPosition(base, null)).toBe(base);
    const placed = withPhotoPosition(base, {
      x: 0.3,
      y: 0.6,
      zoom: 2,
      ratio: 0.75,
    });
    expect(placed).toBe(`${base}#wmt-pos=0.3,0.6,2,0.75`);
    expect(cutFragment(placed)).toEqual({
      base,
      fragment: 'wmt-pos=0.3,0.6,2,0.75',
    });
    expect(hasPhotoPosition(placed)).toBe(true);
    expect(hasPhotoPosition(base)).toBe(false);
  });

  it('keeps a stored link with no position, or with a # that is not ours, exactly as it came', () => {
    const plain = `${HOST}/avatars/u1/a.jpg?X-Amz-Signature=s`;
    expect(cleanPhotoLink(plain)).toBe(plain);
    expect(cleanPhotoLink(`${plain}#other`)).toBe(`${plain}#other`);
  });

  it('stores a well formed position in its canonical form and refuses a broken one', () => {
    const plain = `${HOST}/avatars/u1/a.jpg?X-Amz-Signature=s`;
    expect(cleanPhotoLink(`${plain}#wmt-pos=0.50000,0.5,1.0,1.50`)).toBe(
      `${plain}#wmt-pos=0.5,0.5,1,1.5`,
    );
    expect(cleanPhotoLink(`${plain}#wmt-pos=9,0.5,1,1.5`)).toBeNull();
    expect(cleanPhotoLink(`${plain}#wmt-pos=oops`)).toBeNull();
  });

  it('still finds the object key of a link that carries a position', () => {
    const stored = `${HOST}/avatars/user-1/1a2b3c.jpg?X-Amz-Signature=dead#wmt-pos=0.4,0.4,2,1`;
    expect(objectKeyFrom(stored)).toBe('avatars/user-1/1a2b3c.jpg');
  });

  it('puts the stored position on a freshly signed link, and only then', () => {
    const fresh = `${HOST}/avatars/u1/a.jpg?X-Amz-Signature=NEW`;
    expect(
      keepPhotoPosition(
        `${HOST}/avatars/u1/a.jpg?X-Amz-Signature=old#wmt-pos=0.4,0.4,2,1`,
        fresh,
      ),
    ).toBe(`${fresh}#wmt-pos=0.4,0.4,2,1`);
    expect(
      keepPhotoPosition(`${HOST}/avatars/u1/a.jpg?X-Amz-Signature=old`, fresh),
    ).toBe(fresh);
    expect(
      keepPhotoPosition(
        `${HOST}/avatars/u1/a.jpg?X-Amz-Signature=old#other`,
        fresh,
      ),
    ).toBe(fresh);
  });
});

describe('StorageService.freshUrlFor with a positioned picture', () => {
  const service = storageWithSigner();

  it('signs the picture again and keeps where it was placed', async () => {
    const stale = await service.readUrlFor('avatars/user-1/1a2b3c.jpg');
    const fresh = await service.freshUrlFor(`${stale}#wmt-pos=0.25,0.75,3,1.5`);
    expect(fresh).not.toBeNull();
    const { base, fragment } = cutFragment(fresh!);
    expect(fragment).toBe('wmt-pos=0.25,0.75,3,1.5');
    expect(new URL(base).pathname).toBe(new URL(stale).pathname);
    expect(new URL(base).searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('gives a picture with no position no fragment at all', async () => {
    const stale = await service.readUrlFor('avatars/user-1/1a2b3c.jpg');
    const fresh = await service.freshUrlFor(stale);
    expect(fresh).not.toContain('#');
  });

  it('leaves a link that is not ours, with a # that is not ours, untouched', async () => {
    const external = 'https://cdn.example.com/hotlinked.png#t=30';
    await expect(service.freshUrlFor(external)).resolves.toBe(external);
  });
});
