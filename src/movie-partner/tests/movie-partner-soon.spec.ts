/**
 * FLIX-04 (R-77): `MOVIE_PARTNER=soon` keeps Flix movies visible as "not live
 * yet" and does nothing. These specs pin the seam half: the setting is read,
 * the adapter is built from nothing, and it reaches nobody.
 */
import {
  MoviePartnerConfigError,
  readMoviePartnerName,
  selectMovieAdapter,
} from '../movie-partner-config';
import {
  MOVIE_PARTNER_NAMES,
  MoviePartnerError,
  type MoviePartner,
} from '../movie-partner.interface';
import { OffMoviePartner } from '../off-movie-partner';
import { SoonMoviePartner } from '../soon-movie-partner';
import { StandinMoviePartner } from '../standin/standin-movie-partner';

describe('FLIX-04: MOVIE_PARTNER=soon', () => {
  it('is a name the setting accepts, in any case, and stays listed in the boot error', () => {
    expect(readMoviePartnerName('soon')).toBe('soon');
    expect(readMoviePartnerName(' Soon ')).toBe('soon');
    expect(MOVIE_PARTNER_NAMES).toContain('soon');
    expect(() => readMoviePartnerName('banana')).toThrow(
      /MOVIE_PARTNER must be one of: off, standin, flixora, soon/,
    );
  });

  it('builds the soon adapter and no other', () => {
    const built: string[] = [];
    const adapters = {
      off: () => (built.push('off'), 'OFF'),
      standin: () => (built.push('standin'), 'STANDIN'),
      soon: () => (built.push('soon'), 'SOON'),
    };
    expect(selectMovieAdapter('soon', adapters)).toBe('SOON');
    expect(built).toEqual(['soon']);
  });

  it('is not enabled, says soon, and refuses every call as off with a plain sentence', async () => {
    const soon: MoviePartner = new SoonMoviePartner();
    expect(soon.name).toBe('soon');
    expect(soon.enabled).toBe(false);
    expect(soon.soon).toBe(true);
    const person = {
      sub: 's',
      email: 'a@b.c',
      firstName: '',
      lastName: '',
      emailVerified: false,
    };
    const calls = [
      soon.listMovies({ page: 1, limit: 20 }),
      soon.getMovie('x'),
      soon.signedInLink(person, { id: 'x', path: '/x' }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(MoviePartnerError);
      await expect(call).rejects.toMatchObject({
        kind: 'off',
        message: 'Movies are not live yet.',
      });
    }
  });

  it('is the only adapter that says soon', () => {
    const others: MoviePartner[] = [
      new OffMoviePartner(),
      new StandinMoviePartner(),
    ];
    for (const other of others) expect(other.soon).toBeUndefined();
  });

  it('still refuses a name that has no adapter, so flixora cannot slip in by this change', () => {
    expect(() =>
      selectMovieAdapter('flixora', { soon: () => new SoonMoviePartner() }),
    ).toThrow(MoviePartnerConfigError);
  });
});
