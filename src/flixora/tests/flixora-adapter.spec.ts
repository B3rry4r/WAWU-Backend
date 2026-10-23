/**
 * FLIX-02: the Flixora adapter. Unit specs, no database, no server and no
 * network: the sign-in token is checked with a known (made-up) secret and an
 * independent HS256 verifier, and the HTTP answers are fed in by hand so that
 * 401, 403, 404 and 429 can each be tried. The real Flixora test environment
 * is checked by hand, with the test key (see the task's builder report).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import {
  MOVIE_PARTNER,
  MoviePartnerError,
  type MoviePartner,
  type PartnerPerson,
} from '../../movie-partner/movie-partner.interface';
import { MoviePartnerModule } from '../../movie-partner/movie-partner.module';
import {
  FLIXORA_LOW_WATER,
  FlixoraClient,
  type FetchLike,
} from '../flixora-client';
import { FlixoraMoviePartner } from '../flixora-movie-partner';
import {
  FlixoraConfigError,
  readFlixoraSettings,
  type FlixoraSettings,
} from '../flixora-settings';
import {
  SIGN_IN_TOKEN_SECONDS,
  safeRedirect,
  signInLink,
  signInToken,
} from '../flixora-token';

// Made up for this spec. Not a Flixora key, not a Flixora secret.
const KEY = 'flx_test_0123456789abcdefSPECONLY';
const SECRET = 'spec-only-sign-in-secret-0123456789';
const SLUG = 'spec-partner';
const settings: FlixoraSettings = {
  apiBaseUrl: 'https://api.flixora.invalid/api/partners',
  apiKey: KEY,
  ssoSecret: SECRET,
  partnerSlug: SLUG,
  siteUrl: 'https://www.flixora.com',
  region: 'NG',
};
const env = (over: Record<string, string | undefined> = {}) => {
  const all: Record<string, string | undefined> = {
    FLIXORA_API_BASE_URL: settings.apiBaseUrl,
    FLIXORA_API_KEY: KEY,
    FLIXORA_SSO_SECRET: SECRET,
    FLIXORA_PARTNER_SLUG: SLUG,
    FLIXORA_SITE_URL: settings.siteUrl,
    ...over,
  };
  return (k: string) => all[k];
};

const person: PartnerPerson = {
  sub: '00000000-0000-4000-8000-0000000000aa',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Example',
  emailVerified: true,
};
const NOW = new Date('2026-10-23T12:00:00.000Z');
const IAT = Math.floor(NOW.getTime() / 1000);

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that records every call and answers from a queue (the last answer repeats). */
function fakeFetch(
  ...answers: Array<
    | {
        status: number;
        body?: unknown;
        raw?: string;
        headers?: Record<string, string>;
      }
    | Error
  >
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers });
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) return Promise.reject(a);
    const headers = new Map(
      Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return Promise.resolve({
      status: a.status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: () =>
        Promise.resolve(
          a.raw ?? (a.body === undefined ? '' : JSON.stringify(a.body)),
        ),
    });
  };
  return { fetch, calls };
}

const TEST_HEADERS = { 'x-flixora-environment': 'test' };

const movieJson = (over: Record<string, unknown> = {}) => ({
  id: 'abc123',
  title: 'A Made Up Film',
  originalTitle: null,
  synopsis: 'Nothing real.',
  tagline: null,
  genre: ['Drama'],
  language: 'English',
  countryOfOrigin: 'Nigeria',
  year: 2026,
  runtimeMinutes: 95,
  ageRating: 'PG-13',
  posterImage: 'https://img.flixora.invalid/p.png',
  backdropImage: null,
  trailerUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  cast: [{ name: 'Someone', character: 'Lead' }],
  rating: 4.5,
  ratingCount: 2,
  views: 10,
  premiering: false,
  premierDate: null,
  addedAt: '2026-10-19T12:18:34.524Z',
  flixoraPath: '/stream-movies/abc123',
  flixoraUrl: 'https://www.flixora.com/stream-movies/abc123',
  ...over,
});

const adapterWith = (
  f: ReturnType<typeof fakeFetch>,
  extra: { now?: () => number; newJti?: () => string } = {},
) => new FlixoraMoviePartner(settings, { fetch: f.fetch, ...extra });

describe('FLIX-02: settings', () => {
  it('names every missing setting together, and none of the optional ones', () => {
    expect(() => readFlixoraSettings(() => undefined)).toThrow(
      /MOVIE_PARTNER=flixora needs FLIXORA_API_BASE_URL, FLIXORA_API_KEY, FLIXORA_SSO_SECRET, FLIXORA_PARTNER_SLUG, FLIXORA_SITE_URL\. Set them and restart/,
    );
    expect(() => readFlixoraSettings(() => undefined)).not.toThrow(
      /FLIXORA_REGION/,
    );
    expect(() =>
      readFlixoraSettings(
        env({ FLIXORA_SSO_SECRET: '  ', FLIXORA_PARTNER_SLUG: '' }),
      ),
    ).toThrow(/needs FLIXORA_SSO_SECRET, FLIXORA_PARTNER_SLUG\./);
    expect(() =>
      readFlixoraSettings(env({ FLIXORA_API_KEY: undefined })),
    ).toThrow(/needs FLIXORA_API_KEY\. Set it and restart/);
    expect(() => readFlixoraSettings(() => undefined)).toThrow(
      FlixoraConfigError,
    );
  });

  it('reads all six, trims, drops a trailing slash and defaults the region to NG', () => {
    const got = readFlixoraSettings(
      env({
        FLIXORA_API_BASE_URL: ' https://api.flixora.invalid/api/partners/ ',
        FLIXORA_SITE_URL: 'https://www.flixora.com/',
      }),
    );
    expect(got).toEqual({ ...settings, region: 'NG' });
    expect(readFlixoraSettings(env({ FLIXORA_REGION: ' uk ' })).region).toBe(
      'UK',
    );
    expect(readFlixoraSettings(env({ FLIXORA_REGION: '' })).region).toBe('NG');
  });

  it('refuses a value it cannot run with, naming the setting and never quoting a secret', () => {
    const bad = (over: Record<string, string>) => {
      try {
        readFlixoraSettings(env(over));
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('expected a refusal');
    };
    expect(bad({ FLIXORA_REGION: 'FR' })).toMatch(
      /FLIXORA_REGION must be one of: NG, UK, US/,
    );
    expect(bad({ FLIXORA_API_KEY: 'not-a-flixora-key-SECRETVALUE' })).toMatch(
      /FLIXORA_API_KEY must be a Flixora key/,
    );
    expect(bad({ FLIXORA_API_BASE_URL: 'http://api.flixora.invalid' })).toMatch(
      /FLIXORA_API_BASE_URL must start with https/,
    );
    expect(bad({ FLIXORA_SITE_URL: 'nope' })).toMatch(
      /FLIXORA_SITE_URL must be a web address/,
    );
    expect(bad({ FLIXORA_PARTNER_SLUG: 'a/b' })).toMatch(
      /FLIXORA_PARTNER_SLUG must be the partner slug only/,
    );
    expect(
      readFlixoraSettings(env({ FLIXORA_API_BASE_URL: 'http://localhost:9' }))
        .apiBaseUrl,
    ).toBe('http://localhost:9');
    for (const m of [
      bad({ FLIXORA_API_KEY: 'not-a-flixora-key-SECRETVALUE' }),
      bad({ FLIXORA_REGION: 'FR' }),
    ]) {
      expect(m).not.toContain('SECRETVALUE');
      expect(m).not.toContain(SECRET);
      expect(m).not.toMatch(/—/);
    }
  });

  it('stops the server when the module is built for a flixora server with a setting missing', async () => {
    const keep = { ...process.env };
    for (const k of Object.keys(process.env))
      if (k.startsWith('FLIXORA_')) delete process.env[k];
    process.env.MOVIE_PARTNER = 'flixora';
    try {
      await expect(
        Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({ ignoreEnvFile: true }),
            MoviePartnerModule,
          ],
        }).compile(),
      ).rejects.toThrow(/FLIXORA_API_BASE_URL.*FLIXORA_SITE_URL/);
      Object.assign(process.env, {
        FLIXORA_API_BASE_URL: settings.apiBaseUrl,
        FLIXORA_API_KEY: KEY,
        FLIXORA_SSO_SECRET: SECRET,
        FLIXORA_PARTNER_SLUG: SLUG,
        FLIXORA_SITE_URL: settings.siteUrl,
      });
      // compile() builds the adapter and makes no call (the boot check runs on init only).
      const ok = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ ignoreEnvFile: true }),
          MoviePartnerModule,
        ],
      }).compile();
      const partner = ok.get<MoviePartner>(MOVIE_PARTNER);
      expect(partner.name).toBe('flixora');
      expect(partner.enabled).toBe(true);
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });
});

describe('FLIX-02: the sign-in token', () => {
  it('is HS256, verifies with the secret, and holds exactly the documented claims', () => {
    const { token, expiresAt } = signInToken(
      settings,
      person,
      NOW,
      'jti-fixed',
    );
    const claims = jwt.verify(token, SECRET, {
      algorithms: ['HS256'],
      audience: 'flixora',
      issuer: SLUG,
      clockTimestamp: IAT,
    }) as Record<string, unknown>;
    expect(claims).toEqual({
      iss: SLUG,
      aud: 'flixora',
      sub: person.sub,
      email: 'ada@example.test',
      given_name: 'Ada',
      family_name: 'Example',
      email_verified: true,
      jti: 'jti-fixed',
      iat: IAT,
      exp: IAT + 60,
    });
    expect(SIGN_IN_TOKEN_SECONDS).toBe(60);
    expect(expiresAt.getTime()).toBe((IAT + 60) * 1000);
    const header = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    ) as unknown;
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(token.split('.')).toHaveLength(3);
  });

  it('is refused by a verifier with the wrong secret, and once tampered with', () => {
    const { token } = signInToken(settings, person, NOW, 'j');
    expect(() =>
      jwt.verify(token, 'another-secret', { algorithms: ['HS256'] }),
    ).toThrow(/invalid signature/);
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as object),
        email: 'someone.else@example.test',
      }),
    ).toString('base64url');
    expect(() =>
      jwt.verify(`${h}.${forged}.${s}`, SECRET, { algorithms: ['HS256'] }),
    ).toThrow(/invalid signature/);
  });

  it('is expired 60 seconds on, and not before', () => {
    const { token } = signInToken(settings, person, NOW, 'j');
    expect(() =>
      jwt.verify(token, SECRET, { clockTimestamp: IAT + 59 }),
    ).not.toThrow();
    expect(() =>
      jwt.verify(token, SECRET, { clockTimestamp: IAT + 61 }),
    ).toThrow(/jwt expired/);
  });

  it('leaves a blank name out instead of sending an empty one, and sends only true for a verified email', () => {
    const claims = (p: PartnerPerson) =>
      jwt.decode(signInToken(settings, p, NOW).token) as Record<
        string,
        unknown
      >;
    const noNames = claims({
      ...person,
      firstName: ' ',
      lastName: '',
      emailVerified: false,
    });
    expect(noNames).not.toHaveProperty('given_name');
    expect(noNames).not.toHaveProperty('family_name');
    expect(noNames.email_verified).toBe(false);
  });

  it('carries nothing but what the seam was given: a phone, BVN, NIN or wallet value riding on the object never reaches the token', () => {
    const rider = {
      ...person,
      phone: '+2348012345678',
      bvn: '22212345678',
      nin: '12345678901',
      walletBalance: 99900,
      idDocument: 'passport.png',
    } as unknown as PartnerPerson;
    const decoded = jwt.decode(
      signInToken(settings, rider, NOW).token,
    ) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(
      [
        'aud',
        'email',
        'email_verified',
        'exp',
        'family_name',
        'given_name',
        'iat',
        'iss',
        'jti',
        'sub',
      ].sort(),
    );
    const raw = JSON.stringify(decoded);
    for (const secret of [
      '2348012345678',
      '22212345678',
      '12345678901',
      'passport',
      '99900',
    ])
      expect(raw).not.toContain(secret);
  });
});

describe('FLIX-02: the sign-in link', () => {
  it('is the documented link: the token after the #, then the title path as redirect', async () => {
    const adapter = adapterWith(fakeFetch({ status: 200 }), {
      now: () => NOW.getTime(),
      newJti: () => 'jti-1',
    });
    const link = await adapter.signedInLink(person, {
      id: 'abc123',
      path: '/stream-movies/abc123',
    });
    const [base, fragment] = link.url.split('#');
    expect(base).toBe('https://www.flixora.com/partner/spec-partner/login');
    expect(new URL(link.url).search).toBe('');
    const params = new URLSearchParams(fragment);
    expect([...params.keys()]).toEqual(['token', 'redirect']);
    expect(params.get('redirect')).toBe('/stream-movies/abc123');
    expect(fragment).toMatch(
      /^token=[\w-]+\.[\w-]+\.[\w-]+&redirect=\/stream-movies\/abc123$/,
    );
    const claims = jwt.verify(params.get('token') as string, SECRET, {
      algorithms: ['HS256'],
      audience: 'flixora',
      issuer: SLUG,
      clockTimestamp: IAT,
    }) as Record<string, unknown>;
    expect(claims.jti).toBe('jti-1');
    expect(link.expiresAt.getTime()).toBe((IAT + 60) * 1000);
    // the email is in the signed token only, never readable in the link
    expect(link.url).not.toContain('ada@example.test');
  });

  it('makes a new token with a new jti on every tap (V8), each valid for 60 seconds', async () => {
    const adapter = adapterWith(fakeFetch({ status: 200 }), {
      now: () => NOW.getTime(),
    });
    const target = { id: 'abc123', path: '/stream-movies/abc123' };
    const links = await Promise.all([
      adapter.signedInLink(person, target),
      adapter.signedInLink(person, target),
      adapter.signedInLink(person, target),
    ]);
    const claims = links.map(
      (l) =>
        jwt.decode(
          new URLSearchParams(l.url.split('#')[1]).get('token') as string,
        ) as { jti: string; iat: number; exp: number },
    );
    expect(new Set(links.map((l) => l.url)).size).toBe(3);
    expect(new Set(claims.map((c) => c.jti)).size).toBe(3);
    for (const c of claims) expect(c.exp - c.iat).toBe(60);
  });

  it('makes no call to Flixora to make a link', async () => {
    const f = fakeFetch({ status: 200 });
    await adapterWith(f).signedInLink(person, {
      id: 'x',
      path: '/stream-movies/x',
    });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a person with no email, as Flixora requires one', async () => {
    await expect(
      adapterWith(fakeFetch({ status: 200 })).signedInLink(
        { ...person, email: ' ' },
        { id: 'x', path: '/x' },
      ),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('drops a redirect that does not start with a single /, and escapes what could end the fragment', () => {
    for (const bad of [
      'https://evil.invalid/x',
      '//evil.invalid/x',
      'stream-movies/x',
      '/a\\b',
      '/a\nb',
      '',
      null,
      undefined,
    ])
      expect(safeRedirect(bad)).toBeNull();
    expect(signInLink(settings, 'T.T.T', '//evil.invalid')).toBe(
      'https://www.flixora.com/partner/spec-partner/login#token=T.T.T',
    );
    const link = signInLink(settings, 'T.T.T', '/stream-movies/a&b#c d%');
    expect(link).toBe(
      'https://www.flixora.com/partner/spec-partner/login#token=T.T.T&redirect=/stream-movies/a%26b%23c%20d%25',
    );
    expect(new URLSearchParams(link.split('#')[1]).get('redirect')).toBe(
      '/stream-movies/a&b#c d%',
    );
    expect(signInLink({ ...settings, partnerSlug: 'a b' }, 'T', null)).toBe(
      'https://www.flixora.com/partner/a%20b/login#token=T',
    );
  });
});

describe('FLIX-02: the catalog calls', () => {
  it('asks for a page with the key in a header, the region, updatedSince and nothing else', async () => {
    const f = fakeFetch({
      status: 200,
      headers: TEST_HEADERS,
      body: {
        data: [movieJson()],
        pagination: {
          total: 1,
          page: 2,
          limit: 50,
          totalPages: 2,
          hasNextPage: false,
        },
      },
    });
    const page = await adapterWith(f).listMovies({
      page: 2,
      limit: 50,
      updatedSince: new Date('2026-10-20T00:00:00.000Z'),
    });
    const url = new URL(f.calls[0].url);
    expect(url.origin + url.pathname).toBe(
      'https://api.flixora.invalid/api/partners/v1/movies',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '2',
      limit: '50',
      region: 'NG',
      updatedSince: '2026-10-20T00:00:00.000Z',
    });
    expect(f.calls[0].url).not.toContain(KEY);
    expect(f.calls[0].headers['x-partner-key']).toBe(KEY);
    expect(page).toMatchObject({
      total: 1,
      page: 2,
      limit: 50,
      totalPages: 2,
      hasNextPage: false,
    });
    expect(page.movies[0]).toMatchObject({
      id: 'abc123',
      title: 'A Made Up Film',
      genre: ['Drama'],
      trailerUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      cast: [{ name: 'Someone', character: 'Lead' }],
      flixoraPath: '/stream-movies/abc123',
    });
  });

  it('uses FLIXORA_REGION, leaves updatedSince out when none is asked, and keeps the limit between 1 and 100', async () => {
    const f = fakeFetch({
      status: 200,
      headers: TEST_HEADERS,
      body: { data: [], pagination: {} },
    });
    const adapter = new FlixoraMoviePartner(
      { ...settings, region: 'UK' },
      { fetch: f.fetch },
    );
    await adapter.listMovies({ page: 0, limit: 500 });
    const q = Object.fromEntries(new URL(f.calls[0].url).searchParams);
    expect(q).toEqual({ page: '1', limit: '100', region: 'UK' });
  });

  it('copes with an empty page the way Flixora sends one (totalPages 0)', async () => {
    const f = fakeFetch({
      status: 200,
      headers: TEST_HEADERS,
      body: {
        data: [],
        pagination: {
          total: 0,
          page: 1,
          limit: 100,
          totalPages: 0,
          hasNextPage: false,
        },
      },
    });
    expect(await adapterWith(f).listMovies({ page: 1, limit: 100 })).toEqual({
      movies: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
      hasNextPage: false,
    });
  });

  it('maps null and missing fields to the seam shape, skips a title with no id or title, and fills a missing path from the docs example', async () => {
    const f = fakeFetch({
      status: 200,
      headers: TEST_HEADERS,
      body: {
        data: [
          movieJson({
            id: 'ok',
            flixoraPath: undefined,
            flixoraUrl: undefined,
            genre: undefined,
            cast: [{ name: 'A' }, 7],
            trailerUrl: '  ',
            views: -3,
            premierDate: 'not a date',
            rating: 'x',
          }),
          { title: 'no id' },
          movieJson({ id: 'two', title: '' }),
          'junk',
        ],
        pagination: {
          total: 4,
          page: 1,
          limit: 100,
          totalPages: 1,
          hasNextPage: false,
        },
      },
    });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const page = await adapterWith(f).listMovies({ page: 1, limit: 100 });
    warn.mockRestore();
    expect(page.movies).toHaveLength(1);
    expect(page.movies[0]).toMatchObject({
      id: 'ok',
      genre: [],
      cast: [{ name: 'A', character: null }],
      trailerUrl: null,
      views: 0,
      premierDate: null,
      rating: 0,
      flixoraPath: '/stream-movies/ok',
      flixoraUrl: 'https://www.flixora.com/stream-movies/ok',
    });
  });

  it('reads one title, encodes its id in the path, and answers null for a 404', async () => {
    const f = fakeFetch(
      { status: 200, headers: TEST_HEADERS, body: { data: movieJson() } },
      {
        status: 404,
        headers: TEST_HEADERS,
        body: { message: 'Movie not found.' },
      },
    );
    const adapter = adapterWith(f);
    expect((await adapter.getMovie('a/b c'))?.id).toBe('abc123');
    expect(new URL(f.calls[0].url).pathname).toBe(
      '/api/partners/v1/movies/a%2Fb%20c',
    );
    expect(new URL(f.calls[0].url).search).toBe('');
    expect(await adapter.getMovie('gone')).toBeNull();
  });

  it('treats a 200 that is not a catalog as unavailable', async () => {
    await expect(
      adapterWith(
        fakeFetch({ status: 200, headers: TEST_HEADERS, body: { nope: 1 } }),
      ).listMovies({ page: 1, limit: 5 }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      adapterWith(
        fakeFetch({ status: 200, headers: TEST_HEADERS, body: { data: {} } }),
      ).getMovie('x'),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('FLIX-02: errors become plain answers (401, 403, 404, 429 and the rest)', () => {
  const quiet = () => {
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    return () => spies.forEach((s) => s.mockRestore());
  };
  const fail = async (
    answer: Parameters<typeof fakeFetch>[0],
  ): Promise<MoviePartnerError> => {
    const restore = quiet();
    try {
      await adapterWith(fakeFetch(answer)).listMovies({ page: 1, limit: 10 });
    } catch (e) {
      return e as MoviePartnerError;
    } finally {
      restore();
    }
    throw new Error('expected a refusal');
  };

  it('401: the key was not accepted, a refusal that trying again will not fix', async () => {
    const e = await fail({
      status: 401,
      body: { message: 'Invalid or revoked partner API key.' },
    });
    expect(e).toBeInstanceOf(MoviePartnerError);
    expect(e.kind).toBe('rejected');
    expect(e.message).toBe(
      'The movie partner did not accept the Hub key. Check FLIXORA_API_KEY.',
    );
  });

  it('403: not approved yet, or switched off', async () => {
    const e = await fail({
      status: 403,
      headers: TEST_HEADERS,
      body: { message: 'Partner account is not approved.' },
    });
    expect(e.kind).toBe('rejected');
    expect(e.message).toBe(
      'The movie partner has not approved this account yet, or has switched it off.',
    );
  });

  it('404 on the catalog: the address is wrong, a refusal; on one title it is null (above)', async () => {
    const e = await fail({
      status: 404,
      headers: TEST_HEADERS,
      body: { message: 'x' },
    });
    expect(e.kind).toBe('rejected');
    expect(e.message).toMatch(/FLIXORA_API_BASE_URL/);
  });

  it('429: unavailable, and no call is made until the limit resets', async () => {
    let t = 1_000_000;
    const f = fakeFetch(
      {
        status: 429,
        headers: { ...TEST_HEADERS, 'retry-after': '30' },
        body: { message: 'Too many requests.' },
      },
      {
        status: 200,
        headers: TEST_HEADERS,
        body: { data: [], pagination: {} },
      },
    );
    const adapter = adapterWith(f, { now: () => t });
    const restore = quiet();
    const first = await adapter
      .listMovies({ page: 1, limit: 10 })
      .catch((e: unknown) => e as MoviePartnerError);
    expect(first).toMatchObject({
      kind: 'unavailable',
      message:
        'The movie partner asked the Hub to slow down. Calls wait until its limit resets.',
    });
    t += 10_000;
    await expect(
      adapter.listMovies({ page: 1, limit: 10 }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(f.calls).toHaveLength(1);
    t += 21_000;
    await expect(
      adapter.listMovies({ page: 1, limit: 10 }),
    ).resolves.toMatchObject({ movies: [] });
    expect(f.calls).toHaveLength(2);
    restore();
  });

  it('stops spending the last requests of the 15 minute window, and goes on after the reset', async () => {
    let t = 5_000_000;
    const f = fakeFetch({
      status: 200,
      headers: {
        ...TEST_HEADERS,
        'ratelimit-remaining': String(FLIXORA_LOW_WATER),
        'ratelimit-reset': '120',
      },
      body: { data: [], pagination: {} },
    });
    const adapter = adapterWith(f, { now: () => t });
    await adapter.listMovies({ page: 1, limit: 10 });
    await expect(adapter.getMovie('x')).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(f.calls).toHaveLength(1);
    t += 121_000;
    await adapter.listMovies({ page: 1, limit: 10 });
    expect(f.calls).toHaveLength(2);
  });

  it('5xx, no answer, a timeout and a body that is not JSON are all unavailable', async () => {
    expect((await fail({ status: 500, body: { message: 'boom' } })).kind).toBe(
      'unavailable',
    );
    expect(
      (await fail({ status: 502, raw: '<html>bad gateway</html>' })).kind,
    ).toBe('unavailable');
    expect((await fail(new TypeError('fetch failed'))).kind).toBe(
      'unavailable',
    );
    expect(
      (await fail(Object.assign(new Error('x'), { name: 'TimeoutError' })))
        .kind,
    ).toBe('unavailable');
    expect(
      (await fail({ status: 200, headers: TEST_HEADERS, raw: 'not json' }))
        .kind,
    ).toBe('unavailable');
    expect((await fail({ status: 400, body: {} })).kind).toBe('rejected');
  });

  it('refuses an answer from the other environment than the key belongs to (a test key must never reach live)', async () => {
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const e = await fail({
      status: 200,
      headers: { 'x-flixora-environment': 'live' },
      body: { data: [], pagination: {} },
    });
    expect(e.kind).toBe('rejected');
    expect(e.message).toMatch(/different environment/);
    errorLog.mockRestore();
  });

  it('never puts the key, a response body or a secret in an error or a log line', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (m) =>
        jest
          .spyOn(Logger.prototype, m)
          .mockImplementation((...a: unknown[]) => {
            lines.push(a.map(String).join(' '));
          }),
    );
    const messages: string[] = [];
    const bodyMarker = 'BODYMARKER-do-not-log';
    for (const answer of [
      { status: 401, body: { message: bodyMarker } },
      { status: 403, headers: TEST_HEADERS, body: { message: bodyMarker } },
      { status: 429, headers: TEST_HEADERS, body: { message: bodyMarker } },
      { status: 500, raw: bodyMarker },
      { status: 200, headers: TEST_HEADERS, raw: bodyMarker },
      new Error(`connect failed for ${KEY} at ${settings.apiBaseUrl}`),
    ]) {
      try {
        await adapterWith(fakeFetch(answer)).listMovies({ page: 1, limit: 1 });
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    const adapter = adapterWith(fakeFetch({ status: 200 }), {
      now: () => NOW.getTime(),
    });
    const link = await adapter.signedInLink(person, {
      id: 'x',
      path: '/stream-movies/x',
    });
    spies.forEach((s) => s.mockRestore());
    const token = new URLSearchParams(link.url.split('#')[1]).get(
      'token',
    ) as string;
    const all = [...lines, ...messages].join('\n');
    expect(messages).toHaveLength(6);
    for (const secret of [
      KEY,
      SECRET,
      bodyMarker,
      token,
      link.url,
      'ada@example.test',
    ])
      expect(all).not.toContain(secret);
    expect(all).not.toMatch(/—/);
  });

  it('does not follow a redirect, which could carry the key to another host', async () => {
    let seen: string | undefined;
    const fetch: FetchLike = (_url, init) => {
      seen = init.redirect;
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve('{"data":[],"pagination":{}}'),
      });
    };
    await new FlixoraClient(settings, { fetch }).get('/v1/movies');
    expect(seen).toBe('error');
  });
});

describe('FLIX-02: the boot check', () => {
  it('logs the X-Flixora-Environment header and nothing secret, and never throws when Flixora does not answer', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
      }),
    );
    const f = fakeFetch(
      {
        status: 200,
        headers: TEST_HEADERS,
        body: { data: [], pagination: {} },
      },
      new TypeError('fetch failed'),
    );
    const adapter = adapterWith(f);
    expect(await adapter.logEnvironment()).toBe('test');
    expect(new URL(f.calls[0].url).searchParams.get('limit')).toBe('1');
    expect(await adapter.logEnvironment()).toBeNull();
    spies.forEach((s) => s.mockRestore());
    expect(lines[0]).toMatch(/X-Flixora-Environment: test/);
    expect(lines.some((l) => /not reached at boot/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain(KEY);
  });
});

describe('FLIX-02: who may import what, and what a spec or a file may hold', () => {
  const SRC = path.resolve(__dirname, '../..');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(full);
      return e.name.endsWith('.ts') ? [full] : [];
    });
  const all = files(SRC);
  const importsOf = (f: string): string[] =>
    [...fs.readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );

  it('has one file outside src/flixora importing it: the seam module (the wiring line)', () => {
    const importers = all
      .filter((f) => !f.startsWith(path.join(SRC, 'flixora') + path.sep))
      .filter((f) => importsOf(f).some((i) => /(^|\/)flixora\//.test(i)))
      .map((f) => path.relative(SRC, f));
    expect(importers).toEqual(['movie-partner/movie-partner.module.ts']);
  });

  it('imports nothing from the wallet providers, Fintava or Nuvion', () => {
    const own = all.filter((f) =>
      f.startsWith(path.join(SRC, 'flixora') + path.sep),
    );
    expect(own.length).toBeGreaterThanOrEqual(6);
    for (const f of own)
      for (const i of importsOf(f))
        expect(i).not.toMatch(/fintava|nuvion|wallet|money\//);
  });

  it('has no em-dash in the code a person can read from it', () => {
    const own = all.filter(
      (f) =>
        f.startsWith(path.join(SRC, 'flixora') + path.sep) &&
        !f.includes('/tests/'),
    );
    for (const f of own)
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.replace(/^\s*(\*|\/\/|\/\*).*/, '');
          if (/—/.test(code))
            throw new Error(
              `${path.relative(SRC, f)}:${i + 1} has an em-dash in code`,
            );
        });
  });

  it('holds no Flixora key anywhere in src: no live key and no test key of real length', () => {
    const real = new RegExp(
      ['flx_(?:live|test)_', '[A-Za-z0-9]{40,}'].join(''),
    );
    const live = new RegExp(['flx_', 'live_', '[A-Za-z0-9]{8,}'].join(''));
    for (const f of all) {
      const text = fs.readFileSync(f, 'utf8');
      expect({ f: path.relative(SRC, f), real: real.test(text) }).toEqual({
        f: path.relative(SRC, f),
        real: false,
      });
      expect({ f: path.relative(SRC, f), live: live.test(text) }).toEqual({
        f: path.relative(SRC, f),
        live: false,
      });
    }
  });
});
