import {
  objectKeyFrom,
  type StorageService,
  type Thumbs,
} from './storage.service';

/**
 * A stored profile image, made readable again (HUB-IMG-LINKS: Explore and creator suggestions share this one rule).
 * Stored values are often 7-day signed URLs. Only a key shaped `<folder>/<this owner>/<file>` is signed (through
 * `StorageService.freshUrlFor`, so it gets the day-stable, browser-cacheable link); a key of another account, or one
 * that cannot be read as a key, is never signed (a link from our own storage that is not theirs is dropped, a link to
 * somewhere else passes through untouched).
 */
export async function freshOwnImage(
  storage: Pick<StorageService, 'freshUrlFor'>,
  stored: string | null,
  folder: string,
  ownerId: string,
): Promise<string | null> {
  if (!stored) return null;
  const key = objectKeyFrom(stored);
  if (key === stored) {
    return /^https?:\/\//i.test(stored) ? stored : null;
  }
  const prefix = `${folder}/${ownerId}/`;
  if (!key.startsWith(prefix) || key.slice(prefix.length).includes('/')) {
    return null;
  }
  return storage.freshUrlFor(stored);
}

/**
 * HUB-THUMBS: the small copies of a list of profile images, in order, each only when it is a key of its OWN
 * owner in `folder` (the same rule as `freshOwnImage`). Null for the rest, and for every request that is not the
 * app's (`StorageService.thumbsFor`).
 */
export function ownThumbs(
  storage: Pick<StorageService, 'thumbsFor'>,
  items: ReadonlyArray<{
    stored: string | null;
    folder: string;
    ownerId: string;
  }>,
): Promise<Array<Thumbs | null>> {
  return storage.thumbsFor(
    items.map(({ stored, folder, ownerId }) => {
      if (!stored) return null;
      const key = objectKeyFrom(stored);
      return key !== stored && key.startsWith(`${folder}/${ownerId}/`)
        ? stored
        : null;
    }),
  );
}
