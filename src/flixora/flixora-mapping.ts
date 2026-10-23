import type {
  PartnerCastMember,
  PartnerMovie,
  PartnerMoviePage,
} from '../movie-partner/movie-partner.interface';

/**
 * Flixora's movie object to the seam's `PartnerMovie` (docs/flixora/PARTNER-API.md
 * "Movie object"; checked against real test responses). A title with no id or
 * no title is not a title and is skipped. Every other field falls back to the
 * value that means "nothing" rather than failing the whole page.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

function whole(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function count(v: unknown): number {
  const n = whole(v);
  return n !== null && n >= 0 ? n : 0;
}

function dateText(v: unknown): string | null {
  const s = text(v);
  return s !== null && !Number.isNaN(new Date(s).getTime()) ? s : null;
}

function castOf(v: unknown): PartnerCastMember[] {
  if (!Array.isArray(v)) return [];
  const out: PartnerCastMember[] = [];
  for (const c of v as unknown[]) {
    if (!isObject(c)) continue;
    const name = text(c.name);
    if (name !== null) out.push({ name, character: text(c.character) });
  }
  return out;
}

/** One title, or null when it has no id or no title. */
export function movieOf(raw: unknown, siteUrl: string): PartnerMovie | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  const title = text(raw.title);
  if (id === null || title === null) return null;
  // The docs' own example redirect is /stream-movies/<movie id>.
  const rawPath = text(raw.flixoraPath);
  const flixoraPath =
    rawPath !== null && rawPath.startsWith('/')
      ? rawPath
      : `/stream-movies/${id}`;
  const rating = typeof raw.rating === 'number' ? raw.rating : 0;
  return {
    id,
    title,
    originalTitle: text(raw.originalTitle),
    synopsis: typeof raw.synopsis === 'string' ? raw.synopsis : '',
    tagline: text(raw.tagline),
    genre: Array.isArray(raw.genre)
      ? (raw.genre as unknown[]).filter(
          (g): g is string => typeof g === 'string' && g.trim() !== '',
        )
      : [],
    language: text(raw.language),
    countryOfOrigin: text(raw.countryOfOrigin),
    year: whole(raw.year),
    runtimeMinutes: whole(raw.runtimeMinutes),
    ageRating: text(raw.ageRating),
    posterImage: text(raw.posterImage),
    backdropImage: text(raw.backdropImage),
    trailerUrl: text(raw.trailerUrl),
    cast: castOf(raw.cast),
    rating: Number.isFinite(rating) ? rating : 0,
    ratingCount: count(raw.ratingCount),
    views: count(raw.views),
    premiering: raw.premiering === true,
    premierDate: dateText(raw.premierDate),
    addedAt: dateText(raw.addedAt) ?? '',
    flixoraPath,
    flixoraUrl: text(raw.flixoraUrl) ?? `${siteUrl}${flixoraPath}`,
  };
}

export interface MappedPage {
  page: PartnerMoviePage;
  /** Titles in the answer that were not usable and were left out. */
  skipped: number;
}

/** `{ data: [movie], pagination: { total, page, limit, totalPages, hasNextPage } }`; null when the answer is not that shape. */
export function pageOf(
  json: unknown,
  asked: { page: number; limit: number },
  siteUrl: string,
): MappedPage | null {
  if (!isObject(json) || !Array.isArray(json.data)) return null;
  const movies: PartnerMovie[] = [];
  let skipped = 0;
  for (const raw of json.data as unknown[]) {
    const movie = movieOf(raw, siteUrl);
    if (movie === null) skipped++;
    else movies.push(movie);
  }
  const p = isObject(json.pagination) ? json.pagination : {};
  const page = whole(p.page) ?? asked.page;
  const limit = whole(p.limit) ?? asked.limit;
  const total = whole(p.total) ?? movies.length + skipped;
  const totalPages =
    whole(p.totalPages) ?? Math.ceil(total / Math.max(1, limit));
  return {
    page: {
      movies,
      total,
      page,
      limit,
      totalPages,
      hasNextPage:
        typeof p.hasNextPage === 'boolean' ? p.hasNextPage : page < totalPages,
    },
    skipped,
  };
}
