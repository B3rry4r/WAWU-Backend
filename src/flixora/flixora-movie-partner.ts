import { Logger, type OnModuleInit } from '@nestjs/common';
import {
  MoviePartnerError,
  type ListMoviesRequest,
  type MoviePartner,
  type PartnerLink,
  type PartnerLinkTarget,
  type PartnerMovie,
  type PartnerMoviePage,
  type PartnerPerson,
} from '../movie-partner/movie-partner.interface';
import { FlixoraClient, type FlixoraClientOptions } from './flixora-client';
import { movieOf, pageOf } from './flixora-mapping';
import { readFlixoraSettings, type FlixoraSettings } from './flixora-settings';
import { signInLink, signInToken } from './flixora-token';

export interface FlixoraAdapterOptions extends FlixoraClientOptions {
  /** A fixed `jti` for a spec; the real one is a new random id per tap. */
  newJti?: () => string;
}

/**
 * The real movie partner (FLIX-02; `MOVIE_PARTNER=flixora`): Flixora's partner
 * API for the catalog and a signed HS256 link for "Watch on Flixora". Nothing
 * outside `src/movie-partner/movie-partner.module.ts` (the one wiring line)
 * imports this folder.
 *
 * The catalog calls need the partner key; the link needs only the sign-in
 * secret and makes no call at all. Every tap signs a new token (a new `jti`,
 * `exp` 60 seconds), and neither the token nor the link is stored or logged.
 */
export class FlixoraMoviePartner implements MoviePartner, OnModuleInit {
  readonly name = 'flixora' as const;
  readonly enabled = true;

  private readonly logger = new Logger('Flixora');
  private readonly client: FlixoraClient;
  private readonly now: () => number;
  private readonly newJti: (() => string) | undefined;

  /**
   * The adapter for the server's settings. Throws `FlixoraConfigError`,
   * naming each setting that is missing, so a `flixora` server stops at boot.
   * The seam module calls this one method and imports nothing else here.
   */
  static fromConfig(
    get: (key: string) => string | undefined,
  ): FlixoraMoviePartner {
    return new FlixoraMoviePartner(readFlixoraSettings(get));
  }

  constructor(
    private readonly settings: FlixoraSettings,
    options: FlixoraAdapterOptions = {},
  ) {
    this.client = new FlixoraClient(settings, options);
    this.now = options.now ?? Date.now;
    this.newJti = options.newJti;
  }

  /** At boot: one small request, so the log says which Flixora environment this server's key reaches. A failure is logged and never stops the server. */
  onModuleInit(): void {
    void this.logEnvironment();
  }

  /** Returns the `X-Flixora-Environment` the key reaches, or null when Flixora did not answer. */
  async logEnvironment(): Promise<string | null> {
    try {
      const answer = await this.client.get('/v1/movies', { limit: 1 });
      this.logger.log(
        `Flixora partner API reached. X-Flixora-Environment: ${answer.environment ?? 'not sent'}. Region ${this.settings.region}.`,
      );
      return answer.environment;
    } catch (err) {
      this.logger.warn(
        `Flixora partner API not reached at boot: ${err instanceof MoviePartnerError ? err.kind : 'error'}. Movies will retry on the next sync.`,
      );
      return null;
    }
  }

  async listMovies(req: ListMoviesRequest): Promise<PartnerMoviePage> {
    const page = Math.max(1, Math.floor(req.page));
    const limit = Math.min(100, Math.max(1, Math.floor(req.limit)));
    const answer = await this.client.get('/v1/movies', {
      page,
      limit,
      region: this.settings.region,
      updatedSince: req.updatedSince?.toISOString(),
    });
    if (answer.status === 404) {
      throw new MoviePartnerError(
        'rejected',
        'The movie partner has no catalog at that address. Check FLIXORA_API_BASE_URL.',
      );
    }
    const mapped = pageOf(answer.json, { page, limit }, this.settings.siteUrl);
    if (mapped === null) {
      throw new MoviePartnerError(
        'unavailable',
        'The movie partner sent an answer the Hub could not read.',
      );
    }
    if (mapped.skipped > 0) {
      this.logger.warn(
        `${mapped.skipped} titles in a Flixora answer had no id or title and were left out.`,
      );
    }
    return mapped.page;
  }

  async getMovie(id: string): Promise<PartnerMovie | null> {
    const answer = await this.client.get(
      `/v1/movies/${encodeURIComponent(id)}`,
    );
    if (answer.status === 404) return null;
    const body = answer.json as { data?: unknown } | null;
    const movie = movieOf(body?.data, this.settings.siteUrl);
    if (movie === null) {
      throw new MoviePartnerError(
        'unavailable',
        'The movie partner sent an answer the Hub could not read.',
      );
    }
    return movie;
  }

  signedInLink(
    person: PartnerPerson,
    target: PartnerLinkTarget,
  ): Promise<PartnerLink> {
    if (person.email.trim() === '') {
      return Promise.reject(
        new MoviePartnerError('rejected', 'The movie partner needs an email.'),
      );
    }
    const { token, expiresAt } = signInToken(
      this.settings,
      person,
      new Date(this.now()),
      this.newJti?.(),
    );
    return Promise.resolve({
      url: signInLink(this.settings, token, target.path),
      expiresAt,
    });
  }
}
