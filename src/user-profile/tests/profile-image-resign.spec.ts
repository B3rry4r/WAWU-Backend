import { objectKeyFrom } from '../../storage/storage.service';

/**
 * The profile-picture bug, as a test.
 *
 * WHAT WENT WRONG. An avatar or cover is uploaded through
 * StorageService.presignUpload, whose `fileUrl` is a SEVEN-DAY presigned read
 * URL, and that whole string is what the profile row stores. The bucket is
 * private. Seven days later the signature expires, every fetch of it 403s,
 * and both pictures render as broken-image placeholders -- which is what the
 * Edit Profile screen in the build brief's bug evidence shows. The object was
 * never gone. Only the signature was.
 *
 * THE FIX. UserProfileService re-signs on the way out: `objectKeyFrom`
 * recovers the key from the stored string and the URL is signed again for
 * that response.
 *
 * This suite covers the recovery half, which is where the fix can silently
 * stop working -- if `objectKeyFrom` ever fails to recognise a stored URL,
 * re-signing quietly becomes a no-op and the bug comes back with no test
 * failing. It needs no database and no bucket.
 */
describe('profile image re-signing', () => {
  const HOST = 'https://wawu.sfo3.digitaloceanspaces.com';

  it('recovers the object key from an expired avatar URL', () => {
    const stored = `${HOST}/avatars/user-1/1a2b3c.jpg?X-Amz-Expires=604800&X-Amz-Signature=dead`;
    expect(objectKeyFrom(stored)).toBe('avatars/user-1/1a2b3c.jpg');
  });

  it('recovers the object key from an expired cover URL', () => {
    const stored = `${HOST}/profile/cover/user-1/9f8e7d.png?X-Amz-Signature=beef`;
    expect(objectKeyFrom(stored)).toBe('profile/cover/user-1/9f8e7d.png');
  });

  it('passes a bare key through unchanged, so a re-signed value never double-wraps', () => {
    expect(objectKeyFrom('avatars/user-1/1a2b3c.jpg')).toBe(
      'avatars/user-1/1a2b3c.jpg',
    );
  });

  it("leaves somebody's own external image alone", () => {
    const external = 'https://example.com/me.png';
    expect(objectKeyFrom(external)).toBe(external);
  });

  /**
   * The regression that would reintroduce the bug: a folder added to
   * UPLOAD_FOLDERS but not recognised here means its URLs are never
   * re-signed, and pictures in that folder start breaking a week later with
   * nothing failing.
   */
  it('recognises every folder a profile image can live in', () => {
    for (const folder of ['avatars', 'profile/cover']) {
      const stored = `${HOST}/${folder}/user-1/x.jpg?sig=1`;
      expect(objectKeyFrom(stored)).toBe(`${folder}/user-1/x.jpg`);
    }
  });
});
