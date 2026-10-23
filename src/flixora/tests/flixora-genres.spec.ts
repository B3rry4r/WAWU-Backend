import { genresOf, movieOf } from '../flixora-mapping';

/**
 * FIX-99 (FLIX-02 L1): Flixora serves some genres as one string with pipes.
 * The values below are the ones Flixora's TEST catalog really served (the
 * mobile repo's docs/flixora/TEST-RESPONSES.md lists them). The Hub's genre
 * filter matches one whole entry, so a title served as "Drama | Music |
 * Thriller" was missing from the "Music" chip.
 */
const SITE = 'https://www.flixora.invalid';

const raw = (genre: unknown) => ({
  id: 'abc123',
  title: 'A Made Up Film',
  genre,
});

describe('the genres of a Flixora title are single words', () => {
  it('splits "Drama | Music | Thriller" into its three genres, in order', () => {
    expect(movieOf(raw(['Drama | Music | Thriller']), SITE)?.genre).toEqual([
      'Drama',
      'Music',
      'Thriller',
    ]);
  });

  it('splits "Comedy | Thriller" and "Horror | Sci-Fi | Thriller"', () => {
    expect(genresOf(['Comedy | Thriller'])).toEqual(['Comedy', 'Thriller']);
    expect(genresOf(['Horror | Sci-Fi | Thriller'])).toEqual([
      'Horror',
      'Sci-Fi',
      'Thriller',
    ]);
  });

  it('keeps a plain list as it came', () => {
    expect(genresOf(['Action', 'Animation'])).toEqual(['Action', 'Animation']);
  });

  it('trims, drops empties and non-strings, and removes repeats across entries', () => {
    expect(
      genresOf([
        ' Drama ',
        'Drama | Music |',
        '|',
        '',
        7,
        null,
        'Music|Thriller',
      ]),
    ).toEqual(['Drama', 'Music', 'Thriller']);
  });

  it('answers an empty list when genre is not a list', () => {
    expect(genresOf(undefined)).toEqual([]);
    expect(genresOf('Drama | Music')).toEqual([]);
    expect(movieOf(raw(undefined), SITE)?.genre).toEqual([]);
  });
});
