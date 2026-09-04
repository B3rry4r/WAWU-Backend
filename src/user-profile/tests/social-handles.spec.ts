import { normaliseHandle, toHandle, toProfileUrl } from '../social-handles';

describe('social handles', () => {
  it('expands a bare handle into a working profile link', () => {
    expect(toProfileUrl('adaokeke', 'linkedin')).toBe('https://linkedin.com/in/adaokeke');
    expect(toProfileUrl('adaokeke', 'facebook')).toBe('https://facebook.com/adaokeke');
    expect(toProfileUrl('adaokeke', 'youtube')).toBe('https://youtube.com/@adaokeke');
  });

  it('accepts the "@" people type out of habit', () => {
    expect(toProfileUrl('@adaokeke', 'youtube')).toBe('https://youtube.com/@adaokeke');
    expect(toProfileUrl('@adaokeke', 'linkedin')).toBe('https://linkedin.com/in/adaokeke');
  });

  it('leaves a pasted link exactly as it is', () => {
    // A vanity domain or a country subdomain must survive: rewriting a link
    // somebody already checked is worse than accepting it.
    expect(toProfileUrl('https://ng.linkedin.com/in/ada', 'linkedin')).toBe(
      'https://ng.linkedin.com/in/ada',
    );
    expect(toProfileUrl('https://ada.tv', 'youtube')).toBe('https://ada.tv');
  });

  it('stores nothing for an empty field rather than a bare prefix', () => {
    // "https://facebook.com/" looks like a profile link and goes to the
    // platform's homepage, which is worse than no link at all.
    expect(toProfileUrl('', 'facebook')).toBeNull();
    expect(toProfileUrl('   ', 'facebook')).toBeNull();
    expect(toProfileUrl('@', 'facebook')).toBeNull();
    expect(toProfileUrl(null, 'facebook')).toBeNull();
  });

  it('strips a half-pasted leading slash', () => {
    expect(toProfileUrl('/in/ada', 'linkedin')).toBe('https://linkedin.com/in/in/ada');
    expect(toProfileUrl('/ada', 'facebook')).toBe('https://facebook.com/ada');
  });

  it('stores a bare handle so "@ada" and "ada" are the same person', () => {
    expect(normaliseHandle('@ada')).toBe('ada');
    expect(normaliseHandle('ada')).toBe('ada');
    expect(normaliseHandle('  @ada  ')).toBe('ada');
    expect(normaliseHandle('')).toBeNull();
  });

  it('shows the handle back on the edit form, not the URL', () => {
    expect(toHandle('https://linkedin.com/in/ada', 'linkedin')).toBe('ada');
    expect(toHandle('https://youtube.com/@ada', 'youtube')).toBe('ada');
    // A vanity link has no handle to show, so it shows the link.
    expect(toHandle('https://ng.linkedin.com/in/ada', 'linkedin')).toBe(
      'https://ng.linkedin.com/in/ada',
    );
  });
});
