import type { MoviePartnerMovie, Prisma } from '../../generated/prisma/client';
import type { PartnerMovie } from '../movie-partner/movie-partner.interface';
import type {
  MovieCardView,
  MovieDetailView,
  MovieTrailerView,
} from './movies-view.type';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** `youtube` for a YouTube link, else `file`; null with no trailer (G-FLIX-3). */
export function trailerKindOf(url: string | null): 'file' | 'youtube' | null {
  if (url === null || url.trim() === '') return null;
  try {
    return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase())
      ? 'youtube'
      : 'file';
  } catch {
    return 'file';
  }
}

function dateOrNull(value: string | null): Date | null {
  if (value === null) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The columns of a copied row for one partner title. */
export function rowOf(
  provider: string,
  movie: PartnerMovie,
  seenAt: Date,
): Prisma.MoviePartnerMovieUncheckedCreateInput {
  const trailerUrl =
    movie.trailerUrl !== null && movie.trailerUrl.trim() !== ''
      ? movie.trailerUrl.trim()
      : null;
  return {
    provider,
    partnerMovieId: movie.id,
    title: movie.title,
    titleSort: movie.title.trim().toLowerCase(),
    originalTitle: movie.originalTitle,
    synopsis: movie.synopsis,
    tagline: movie.tagline,
    genre: movie.genre,
    language: movie.language,
    countryOfOrigin: movie.countryOfOrigin,
    year: movie.year,
    runtimeMinutes: movie.runtimeMinutes,
    ageRating: movie.ageRating,
    posterImage: movie.posterImage,
    backdropImage: movie.backdropImage,
    trailerUrl,
    trailerKind: trailerKindOf(trailerUrl),
    castMembers: movie.cast.map((c) => ({
      name: c.name,
      character: c.character,
    })),
    rating: movie.rating,
    ratingCount: movie.ratingCount,
    views: movie.views,
    premiering: movie.premiering,
    premierDate: dateOrNull(movie.premierDate),
    partnerAddedAt: dateOrNull(movie.addedAt) ?? seenAt,
    partnerPath: movie.flixoraPath,
    partnerUrl: movie.flixoraUrl,
    seenAt,
  };
}

/** True while a premiere is still ahead (a premiere date that has passed no longer counts). */
export function isPremiering(row: MoviePartnerMovie, now: Date): boolean {
  return (
    row.premiering &&
    (row.premierDate === null || row.premierDate.getTime() > now.getTime())
  );
}

export function cardOf(row: MoviePartnerMovie, now: Date): MovieCardView {
  return {
    id: row.partnerMovieId,
    title: row.title,
    genre: row.genre,
    language: row.language,
    year: row.year,
    runtimeMinutes: row.runtimeMinutes,
    ageRating: row.ageRating,
    posterImage: row.posterImage,
    backdropImage: row.backdropImage,
    rating: row.rating,
    ratingCount: row.ratingCount,
    views: row.views,
    premiering: isPremiering(row, now),
    premierDate: row.premierDate ? row.premierDate.toISOString() : null,
    addedAt: row.partnerAddedAt.toISOString(),
  };
}

interface StoredCast {
  name?: unknown;
  character?: unknown;
}

export function detailOf(
  row: MoviePartnerMovie,
  now: Date,
  mustAgreeTerms: boolean,
): MovieDetailView {
  const trailer: MovieTrailerView | null =
    row.trailerUrl !== null && row.trailerKind !== null
      ? {
          kind: row.trailerKind === 'youtube' ? 'youtube' : 'file',
          url: row.trailerUrl,
        }
      : null;
  const stored = Array.isArray(row.castMembers)
    ? (row.castMembers as StoredCast[])
    : [];
  return {
    ...cardOf(row, now),
    originalTitle: row.originalTitle,
    synopsis: row.synopsis,
    tagline: row.tagline,
    countryOfOrigin: row.countryOfOrigin,
    cast: stored
      .filter((c) => typeof c.name === 'string')
      .map((c) => ({
        name: c.name as string,
        character: typeof c.character === 'string' ? c.character : null,
      })),
    trailer,
    mustAgreeTerms,
  };
}
