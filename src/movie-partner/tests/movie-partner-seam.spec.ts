/**
 * FLIX-01: the movie partner seam (R-75). Reads files as text and calls the
 * adapters directly; no database, no server, no network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MoviePartnerConfigError,
  readMoviePartnerName,
  selectMovieAdapter,
} from '../movie-partner-config';
import {
  MoviePartnerError,
  type MoviePartner,
  type PartnerMovie,
} from '../movie-partner.interface';
import { OffMoviePartner } from '../off-movie-partner';
import { standinMovies } from '../standin/standin-fixtures';
import { StandinMoviePartner } from '../standin/standin-movie-partner';
import { personOf } from '../../movies/movies.service';
import { trailerKindOf } from '../../movies/movies-mapping';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory())
      return e.name === 'node_modules' ? [] : sourceFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

describe('FLIX-01: MOVIE_PARTNER picks the adapter', () => {
  it('reads unset, blank and off as off, and any case of the other names', () => {
    for (const v of [undefined, null, '', '   ', 'off', 'OFF', ' Off '])
      expect(readMoviePartnerName(v)).toBe('off');
    expect(readMoviePartnerName('standin')).toBe('standin');
    expect(readMoviePartnerName(' StandIn ')).toBe('standin');
    expect(readMoviePartnerName('flixora')).toBe('flixora');
  });

  it('refuses a name it does not know, naming the setting and what it may be', () => {
    expect(() => readMoviePartnerName('banana')).toThrow(
      MoviePartnerConfigError,
    );
    expect(() => readMoviePartnerName('banana')).toThrow(
      /MOVIE_PARTNER must be one of: off, standin, flixora/,
    );
  });

  it('stops the server for a name with no adapter (flixora is FLIX-02) and builds only the one picked', () => {
    const built: string[] = [];
    const adapters = {
      off: () => (built.push('off'), 'OFF'),
      standin: () => (built.push('standin'), 'STANDIN'),
    };
    expect(selectMovieAdapter('standin', adapters)).toBe('STANDIN');
    expect(built).toEqual(['standin']);
    expect(() => selectMovieAdapter('flixora', adapters)).toThrow(
      /not built yet/,
    );
  });
});

describe('FLIX-01: the off adapter reaches nothing', () => {
  it('is not enabled and refuses every call as off', async () => {
    const off: MoviePartner = new OffMoviePartner();
    expect(off.enabled).toBe(false);
    await expect(off.listMovies({ page: 1, limit: 20 })).rejects.toMatchObject({
      kind: 'off',
    });
    await expect(off.getMovie('x')).rejects.toBeInstanceOf(MoviePartnerError);
    await expect(
      off.signedInLink(
        {
          sub: 's',
          email: 'a@b.c',
          firstName: '',
          lastName: '',
          emailVerified: false,
        },
        { id: 'x', path: '/x' },
      ),
    ).rejects.toMatchObject({ kind: 'off' });
  });
});

describe('FLIX-01: the stand-in is shaped on the partner docs', () => {
  const now = new Date('2026-10-22T12:00:00.000Z');
  const fields = [
    'id',
    'title',
    'originalTitle',
    'synopsis',
    'tagline',
    'genre',
    'language',
    'countryOfOrigin',
    'year',
    'runtimeMinutes',
    'ageRating',
    'posterImage',
    'backdropImage',
    'trailerUrl',
    'cast',
    'rating',
    'ratingCount',
    'views',
    'premiering',
    'premierDate',
    'addedAt',
    'flixoraPath',
    'flixoraUrl',
  ];

  it('has every field of the docs movie object on every title, and no other', () => {
    const movies = standinMovies(now);
    expect(movies.length).toBeGreaterThanOrEqual(12);
    for (const m of movies)
      expect(Object.keys(m).sort()).toEqual([...fields].sort());
  });

  it('has file trailers, YouTube trailers, none, and premiering titles, all on hosts that cannot resolve (or YouTube itself, never fetched)', () => {
    const movies = standinMovies(now);
    const kinds = movies.map((m) => trailerKindOf(m.trailerUrl));
    expect(kinds).toContain('file');
    expect(kinds).toContain('youtube');
    expect(kinds).toContain(null);
    const premiering = movies.filter((m) => m.premiering);
    expect(premiering.length).toBeGreaterThanOrEqual(2);
    for (const m of premiering)
      expect(new Date(m.premierDate as string).getTime()).toBeGreaterThan(
        now.getTime(),
      );
    for (const m of movies.filter((x) => !x.premiering))
      expect(m.premierDate).toBeNull();
    const hosts = new Set<string>();
    for (const m of movies)
      for (const u of [
        m.posterImage,
        m.backdropImage,
        m.trailerUrl,
        m.flixoraUrl,
      ])
        if (u) hosts.add(new URL(u).hostname);
    for (const host of hosts)
      expect(host === 'www.youtube.com' || host.endsWith('.invalid')).toBe(
        true,
      );
    expect([...hosts].join(' ')).not.toMatch(/wawuafrica|flixora\.com/);
  });

  it('pages newest first, filters with updatedSince and reports the paging block', async () => {
    const p = new StandinMoviePartner(now);
    const first = await p.listMovies({ page: 1, limit: 5 });
    expect(first).toMatchObject({
      total: 14,
      page: 1,
      limit: 5,
      totalPages: 3,
      hasNextPage: true,
    });
    expect(first.movies).toHaveLength(5);
    const addedAt = first.movies.map((m) => m.addedAt);
    expect(addedAt).toEqual([...addedAt].sort().reverse());
    const last = await p.listMovies({ page: 3, limit: 5 });
    expect(last.hasNextPage).toBe(false);
    expect(last.movies).toHaveLength(4);
    expect(
      (await p.listMovies({ page: 1, limit: 100, updatedSince: new Date(1) }))
        .total,
    ).toBe(0);
    p.setMovie({ ...first.movies[0], views: 1 }, new Date(5000));
    const since = await p.listMovies({
      page: 1,
      limit: 100,
      updatedSince: new Date(1),
    });
    expect(since.movies.map((m) => m.id)).toEqual([first.movies[0].id]);
    expect(await p.getMovie('standin-001')).not.toBeNull();
    expect(await p.getMovie('nope')).toBeNull();
  });

  it('makes a different link each time, with the token after the # and the title as redirect', async () => {
    const p = new StandinMoviePartner(now);
    const person = {
      sub: 's',
      email: 'a@b.c',
      firstName: 'A',
      lastName: 'B',
      emailVerified: true,
    };
    const a = await p.signedInLink(person, {
      id: 'standin-001',
      path: '/stream-movies/standin-001',
    });
    const b = await p.signedInLink(person, {
      id: 'standin-001',
      path: '/stream-movies/standin-001',
    });
    expect(a.url).not.toBe(b.url);
    expect(new URL(a.url).search).toBe('');
    expect(a.url).toMatch(
      /#token=[A-Za-z0-9_-]+&redirect=%2Fstream-movies%2Fstandin-001$/,
    );
    expect(a.url).not.toContain('a@b.c');
    expect(a.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(a.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 61_000);
  });
});

describe('FLIX-01: what the partner is given about a person', () => {
  const claims = {
    sub: '00000000-0000-4000-8000-0000000000aa',
    email: ' Ada@Example.com ',
    phone: '+2348012345678',
    firstName: ' Ada ',
    middleName: 'Middle',
    lastName: 'Example',
    country: 'Nigeria',
    verificationTier: 'verified_user',
    trustScore: 40,
    status: 'active',
    platformRefs: { onboardingRef: 'ref-1' },
    iat: 1,
    exp: 2,
  } as unknown as WawuJwtClaims;

  it('is the permanent id, email, first and last name and whether the email is verified; nothing else', () => {
    expect(personOf(claims)).toEqual({
      sub: claims.sub,
      email: 'Ada@Example.com',
      firstName: 'Ada',
      lastName: 'Example',
      emailVerified: false,
    });
    expect(
      personOf({ ...claims, emailVerified: true } as unknown as WawuJwtClaims)
        ?.emailVerified,
    ).toBe(true);
    // only an exact true counts
    expect(
      personOf({ ...claims, emailVerified: 'true' } as unknown as WawuJwtClaims)
        ?.emailVerified,
    ).toBe(false);
    const sent = JSON.stringify(personOf(claims));
    for (const secret of [
      '2348012345678',
      'Nigeria',
      'Middle',
      'verified_user',
      'ref-1',
    ])
      expect(sent).not.toContain(secret);
  });

  it('is nothing for a person with no email, which the partner requires', () => {
    expect(personOf({ ...claims, email: null })).toBeNull();
    expect(personOf({ ...claims, email: '   ' })).toBeNull();
  });
});

describe('FLIX-01: who may import what', () => {
  const files = sourceFiles(SRC);
  const importsOf = (file: string): string[] =>
    [...fs.readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );

  it('has no file outside src/flixora importing src/flixora (FLIX-02 will put the real adapter there)', () => {
    const offenders = files
      .filter((f) => !f.startsWith(path.join(SRC, 'flixora') + path.sep))
      .filter((f) =>
        importsOf(f).some(
          (i) => /(^|\/)flixora(\/|$)/.test(i) && !i.includes('movie-partner'),
        ),
      )
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('reaches the adapters only from the seam module (the movie code uses MOVIE_PARTNER)', () => {
    const adapterImport = /(^|\/)(off-movie-partner|standin\/[\w-]+)$/;
    const offenders = files
      .filter((f) => !f.startsWith(path.join(SRC, 'movie-partner') + path.sep))
      // specs may build an adapter to test it
      .filter((f) => !/\.spec\.ts$/.test(f))
      .filter((f) => importsOf(f).some((i) => adapterImport.test(i)))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('keeps the wallet providers out of the movie code (only the contract tag `BuiltBy` comes from the money folder)', () => {
    const movieFiles = files.filter(
      (f) =>
        /\/src\/(movies|movie-partner)\//.test(f) && !/\.spec\.ts$/.test(f),
    );
    expect(movieFiles.length).toBeGreaterThan(8);
    for (const f of movieFiles)
      for (const i of importsOf(f)) {
        if (i.endsWith('money/money-contract')) continue;
        expect(i).not.toMatch(/fintava|nuvion|wallet|money\//);
      }
  });

  it('has no em-dash in anything a person reads from the movie code', () => {
    const movieFiles = files.filter(
      (f) =>
        /\/src\/(movies|movie-partner)\//.test(f) && !f.includes('/tests/'),
    );
    for (const f of movieFiles) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // code comments are exempt: nobody using the app reads them
        const code = line.replace(/^\s*(\*|\/\/|\/\*).*/, '');
        if (/—/.test(code))
          throw new Error(
            `${path.relative(SRC, f)}:${i + 1} has an em-dash in code`,
          );
      });
    }
  });
});

export type { PartnerMovie };
