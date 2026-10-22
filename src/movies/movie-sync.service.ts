import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  MOVIE_PARTNER,
  MoviePartnerError,
  type MoviePartner,
} from '../movie-partner/movie-partner.interface';
import { rowOf } from './movies-mapping';
import {
  DEFAULT_SYNC_FULL_EVERY_HOURS,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  DEFAULT_SYNC_MAX_PAGES,
  DEFAULT_SYNC_PAGE_SIZE,
  MOVIE_SYNC_FULL_EVERY_KEY,
  MOVIE_SYNC_INTERVAL_KEY,
  MOVIE_SYNC_MAX_PAGES_KEY,
  MOVIE_SYNC_PAGE_SIZE_KEY,
  readPositiveInt,
} from './movies-settings';

/** An incremental pass asks for changes since a little before the last pass began, so a title changed while that pass ran is not missed. */
const OVERLAP_MS = 5 * 60 * 1000;
/** One server holds a pass this long; a crash frees it. */
const LEASE_MS = 10 * 60 * 1000;

export interface MovieSyncResult {
  mode: 'full' | 'incremental' | 'skipped';
  /** Why nothing ran, or how the pass ended when it did not finish. */
  note:
    | 'off'
    | 'busy'
    | 'not_due'
    | 'partner_unavailable'
    | 'partner_rejected'
    | 'too_many_pages'
    | 'empty_catalog_kept'
    | null;
  pages: number;
  seen: number;
  created: number;
  updated: number;
  removed: number;
}

const NOTHING: Omit<MovieSyncResult, 'mode' | 'note'> = {
  pages: 0,
  seen: 0,
  created: 0,
  updated: 0,
  removed: 0,
};

/**
 * Keeps the Hub's copy of the partner's catalog current (FLIX-01), so no
 * screen ever calls the partner and its 1,000 requests per 15 minutes is
 * never near: an incremental pass asks for what changed since the last one
 * (`updatedSince`; one request when nothing did), and a full pass now and
 * then also removes the titles the partner no longer lists. A pass holds no
 * transaction or lock while it calls the partner: it takes a lease row,
 * calls, and writes each page in its own short transaction.
 *
 * `off` never runs (no call is made). A pass that fails keeps the copy as it
 * was and records a short code; the next pass tries again from the same
 * place.
 */
@Injectable()
export class MovieSyncService {
  private readonly logger = new Logger(MovieSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(MOVIE_PARTNER) private readonly partner: MoviePartner,
  ) {}

  /** Looks every five minutes whether a pass is due (the interval is a setting). */
  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    try {
      await this.runIfDue();
    } catch (err) {
      this.logger.error(
        `The movie sync stopped: ${err instanceof Error ? err.name : 'unknown'}.`,
      );
    }
  }

  async runIfDue(now: Date = new Date()): Promise<MovieSyncResult> {
    if (!this.partner.enabled) return skipped('off');
    const interval = readPositiveInt(
      this.config,
      MOVIE_SYNC_INTERVAL_KEY,
      DEFAULT_SYNC_INTERVAL_MINUTES,
      24 * 60,
    );
    const row = await this.prisma.moviePartnerSync.findUnique({
      where: { provider: this.partner.name },
    });
    if (
      row?.lastPassAt &&
      now.getTime() - row.lastPassAt.getTime() < interval * 60_000
    ) {
      return skipped('not_due');
    }
    return this.runPass({ now });
  }

  /** One pass. `full` forces a full pass; otherwise it is full when none has run lately. */
  async runPass(
    opts: { full?: boolean; now?: Date } = {},
  ): Promise<MovieSyncResult> {
    if (!this.partner.enabled) return skipped('off');
    const provider = this.partner.name;
    const startedAt = opts.now ?? new Date();

    // Take the lease under a short write; nothing is held after it.
    await this.prisma.moviePartnerSync.upsert({
      where: { provider },
      create: { provider },
      update: {},
    });
    const claimed = await this.prisma.moviePartnerSync.updateMany({
      where: {
        provider,
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: startedAt } }],
      },
      data: { claimedUntil: new Date(startedAt.getTime() + LEASE_MS) },
    });
    if (claimed.count === 0) return skipped('busy');

    const state = await this.prisma.moviePartnerSync.findUniqueOrThrow({
      where: { provider },
    });
    const fullEveryMs =
      readPositiveInt(
        this.config,
        MOVIE_SYNC_FULL_EVERY_KEY,
        DEFAULT_SYNC_FULL_EVERY_HOURS,
        24 * 365,
      ) *
      60 *
      60_000;
    const full =
      opts.full ??
      (state.lastFullPassAt === null ||
        state.lastPassStartedAt === null ||
        startedAt.getTime() - state.lastFullPassAt.getTime() >= fullEveryMs);
    const updatedSince = full
      ? undefined
      : new Date((state.lastPassStartedAt as Date).getTime() - OVERLAP_MS);
    const limit = readPositiveInt(
      this.config,
      MOVIE_SYNC_PAGE_SIZE_KEY,
      DEFAULT_SYNC_PAGE_SIZE,
      100,
    );
    const maxPages = readPositiveInt(
      this.config,
      MOVIE_SYNC_MAX_PAGES_KEY,
      DEFAULT_SYNC_MAX_PAGES,
      10_000,
    );
    const mode = full ? 'full' : 'incremental';

    const tally = { ...NOTHING };
    let note: MovieSyncResult['note'] = null;
    try {
      for (let page = 1; ; page++) {
        if (page > maxPages) {
          note = 'too_many_pages';
          break;
        }
        // The partner call holds nothing.
        const answer = await this.partner.listMovies({
          page,
          limit,
          updatedSince,
        });
        tally.pages++;
        const ids = answer.movies.map((m) => m.id);
        const existing = new Set(
          (
            await this.prisma.moviePartnerMovie.findMany({
              where: { provider, partnerMovieId: { in: ids } },
              select: { partnerMovieId: true },
            })
          ).map((r) => r.partnerMovieId),
        );
        await this.prisma.$transaction(
          answer.movies.map((movie) => {
            const data = rowOf(provider, movie, startedAt);
            return this.prisma.moviePartnerMovie.upsert({
              where: {
                provider_partnerMovieId: { provider, partnerMovieId: movie.id },
              },
              create: data,
              update: data,
            });
          }),
        );
        for (const id of ids) {
          if (existing.has(id)) tally.updated++;
          else tally.created++;
        }
        tally.seen += answer.movies.length;
        if (!answer.hasNextPage || answer.movies.length === 0) break;
      }
    } catch (err) {
      note =
        err instanceof MoviePartnerError && err.kind === 'rejected'
          ? 'partner_rejected'
          : 'partner_unavailable';
    }

    if (note === null && full) {
      // A full pass that saw nothing never empties a copy that has titles: an empty answer is more likely a fault than every title gone.
      const held = await this.prisma.moviePartnerMovie.count({
        where: { provider },
      });
      if (tally.seen === 0 && held > 0) {
        note = 'empty_catalog_kept';
      } else {
        const gone = await this.prisma.moviePartnerMovie.deleteMany({
          where: { provider, seenAt: { lt: startedAt } },
        });
        tally.removed = gone.count;
      }
    }

    const finished = note === null;
    await this.prisma.moviePartnerSync.update({
      where: { provider },
      data: {
        claimedUntil: null,
        lastError: note,
        ...(finished
          ? {
              lastPassStartedAt: startedAt,
              lastPassAt: new Date(),
              lastCount: tally.seen,
              ...(full ? { lastFullPassAt: startedAt } : {}),
            }
          : {}),
      },
    });
    if (!finished) {
      this.logger.warn(`A ${mode} movie sync pass did not finish: ${note}.`);
    }
    return { mode, note, ...tally };
  }
}

function skipped(note: 'off' | 'busy' | 'not_due'): MovieSyncResult {
  return { mode: 'skipped', note, ...NOTHING };
}
