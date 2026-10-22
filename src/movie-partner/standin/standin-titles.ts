import type { PartnerMovie } from '../movie-partner.interface';

/**
 * Made-up titles for the stand-in (FLIX-01): every field of the partner's
 * movie object, some with a file trailer, some with a YouTube trailer, some
 * with none, some premiering. None is a real film. Hosts end in `.invalid`,
 * which never resolves, so nothing here can reach anyone.
 */
const DAY = 24 * 60 * 60 * 1000;

interface Seed {
  n: number;
  title: string;
  original?: string;
  genre: string[];
  language: string | null;
  country: string | null;
  year: number | null;
  runtime: number | null;
  age: string | null;
  rating: number;
  ratingCount: number;
  views: number;
  /** Days before now it was added. */
  addedDaysAgo: number;
  trailer: 'file' | 'youtube' | null;
  /** Days from now the premiere is; null: not premiering. */
  premiereInDays: number | null;
  tagline: string | null;
  poster: boolean;
  backdrop: boolean;
}

const SEEDS: Seed[] = [
  {
    n: 1,
    title: 'The Salt Road',
    genre: ['Drama'],
    language: 'English',
    country: 'Nigeria',
    year: 2024,
    runtime: 112,
    age: 'PG-13',
    rating: 4.6,
    ratingCount: 812,
    views: 90210,
    addedDaysAgo: 3,
    trailer: 'file',
    premiereInDays: null,
    tagline: 'Some roads only run one way.',
    poster: true,
    backdrop: true,
  },
  {
    n: 2,
    title: 'Lagos After Rain',
    genre: ['Drama', 'Romance'],
    language: 'English',
    country: 'Nigeria',
    year: 2023,
    runtime: 98,
    age: 'PG-13',
    rating: 4.1,
    ratingCount: 455,
    views: 150400,
    addedDaysAgo: 40,
    trailer: 'youtube',
    premiereInDays: null,
    tagline: null,
    poster: true,
    backdrop: true,
  },
  {
    n: 3,
    title: 'Kofi and the Drum',
    genre: ['Family', 'Adventure'],
    language: 'Twi',
    country: 'Ghana',
    year: 2022,
    runtime: 87,
    age: 'G',
    rating: 4.8,
    ratingCount: 1290,
    views: 320050,
    addedDaysAgo: 120,
    trailer: 'file',
    premiereInDays: null,
    tagline: 'A small boy. A very loud drum.',
    poster: true,
    backdrop: false,
  },
  {
    n: 4,
    title: 'Midnight Market',
    genre: ['Thriller'],
    language: 'English',
    country: 'Nigeria',
    year: 2025,
    runtime: 104,
    age: 'R',
    rating: 3.9,
    ratingCount: 210,
    views: 40500,
    addedDaysAgo: 9,
    trailer: 'youtube',
    premiereInDays: null,
    tagline: 'Everything is for sale.',
    poster: true,
    backdrop: true,
  },
  {
    n: 5,
    title: 'Ìyá Àgbà',
    original: 'Ìyá Àgbà',
    genre: ['Drama'],
    language: 'Yoruba',
    country: 'Nigeria',
    year: 2021,
    runtime: 121,
    age: 'PG',
    rating: 4.4,
    ratingCount: 633,
    views: 210800,
    addedDaysAgo: 200,
    trailer: 'file',
    premiereInDays: null,
    tagline: null,
    poster: true,
    backdrop: true,
  },
  {
    n: 6,
    title: 'Harmattan Hearts',
    genre: ['Romance', 'Comedy'],
    language: 'English',
    country: 'Nigeria',
    year: 2024,
    runtime: 95,
    age: 'PG',
    rating: 3.7,
    ratingCount: 178,
    views: 22300,
    addedDaysAgo: 15,
    trailer: null,
    premiereInDays: null,
    tagline: 'Dry season. Wet eyes.',
    poster: true,
    backdrop: false,
  },
  {
    n: 7,
    title: 'Eko Heist',
    genre: ['Action', 'Comedy'],
    language: 'English',
    country: 'Nigeria',
    year: 2025,
    runtime: 109,
    age: 'PG-16',
    rating: 4.2,
    ratingCount: 402,
    views: 128900,
    addedDaysAgo: 5,
    trailer: 'file',
    premiereInDays: null,
    tagline: null,
    poster: true,
    backdrop: true,
  },
  {
    n: 8,
    title: 'Sunrise Over Kumasi',
    genre: ['Documentary'],
    language: 'English',
    country: 'Ghana',
    year: 2023,
    runtime: 74,
    age: 'G',
    rating: 4.0,
    ratingCount: 96,
    views: 8800,
    addedDaysAgo: 60,
    trailer: 'youtube',
    premiereInDays: null,
    tagline: null,
    poster: true,
    backdrop: true,
  },
  {
    n: 9,
    title: 'The Last Griot',
    genre: ['Drama', 'Historical'],
    language: 'English',
    country: 'Senegal',
    year: 2026,
    runtime: 133,
    age: 'PG-13',
    rating: 0,
    ratingCount: 0,
    views: 0,
    addedDaysAgo: 2,
    trailer: 'file',
    premiereInDays: 21,
    tagline: 'The story ends with him.',
    poster: true,
    backdrop: true,
  },
  {
    n: 10,
    title: 'Bush Taxi',
    genre: ['Comedy'],
    language: 'Pidgin',
    country: 'Nigeria',
    year: 2026,
    runtime: 90,
    age: 'PG-13',
    rating: 0,
    ratingCount: 0,
    views: 0,
    addedDaysAgo: 1,
    trailer: 'youtube',
    premiereInDays: 7,
    tagline: 'Fare is fare.',
    poster: true,
    backdrop: false,
  },
  {
    n: 11,
    title: 'Queen of the Delta',
    genre: ['Action', 'Drama'],
    language: 'English',
    country: 'Nigeria',
    year: 2026,
    runtime: 118,
    age: 'PG-16',
    rating: 0,
    ratingCount: 0,
    views: 0,
    addedDaysAgo: 4,
    trailer: 'file',
    premiereInDays: 60,
    tagline: null,
    poster: true,
    backdrop: true,
  },
  {
    n: 12,
    title: 'Ash and Ankara',
    genre: ['Fantasy'],
    language: 'English',
    country: 'Nigeria',
    year: null,
    runtime: null,
    age: null,
    rating: 3.2,
    ratingCount: 41,
    views: 3100,
    addedDaysAgo: 300,
    trailer: null,
    premiereInDays: null,
    tagline: null,
    poster: false,
    backdrop: false,
  },
  {
    n: 13,
    title: 'Mama Put',
    genre: ['Comedy', 'Family'],
    language: 'Igbo',
    country: 'Nigeria',
    year: 2020,
    runtime: 101,
    age: 'PG',
    rating: 4.5,
    ratingCount: 744,
    views: 187000,
    addedDaysAgo: 400,
    trailer: 'file',
    premiereInDays: null,
    tagline: 'Rice, stew, and trouble.',
    poster: true,
    backdrop: true,
  },
  {
    n: 14,
    title: 'Zanzibar Nights',
    genre: ['Thriller', 'Romance'],
    language: 'Swahili',
    country: 'Tanzania',
    year: 2024,
    runtime: 107,
    age: 'NC-17',
    rating: 3.5,
    ratingCount: 122,
    views: 17600,
    addedDaysAgo: 75,
    trailer: 'youtube',
    premiereInDays: null,
    tagline: null,
    poster: true,
    backdrop: true,
  },
];

/** The stand-in's catalog as of `now`: the same made-up titles, dates counted from `now`. */
export function standinMovies(now: Date): PartnerMovie[] {
  return SEEDS.map((s): PartnerMovie => {
    const id = `standin-${String(s.n).padStart(3, '0')}`;
    const slug = s.title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return {
      id,
      title: s.title,
      originalTitle: s.original ?? null,
      synopsis: `${s.title} is a made-up film for testing. Nothing about it is real.`,
      tagline: s.tagline,
      genre: s.genre,
      language: s.language,
      countryOfOrigin: s.country,
      year: s.year,
      runtimeMinutes: s.runtime,
      ageRating: s.age,
      posterImage: s.poster
        ? `https://standin.invalid/posters/${slug}.jpg`
        : null,
      backdropImage: s.backdrop
        ? `https://standin.invalid/backdrops/${slug}.jpg`
        : null,
      trailerUrl:
        s.trailer === 'file'
          ? `https://standin.invalid/trailers/${slug}.mp4`
          : s.trailer === 'youtube'
            ? `https://www.youtube.com/watch?v=standin${String(s.n).padStart(3, '0')}`
            : null,
      cast: [
        { name: 'Ada Example', character: 'Lead' },
        { name: 'Tunde Sample', character: null },
      ],
      rating: s.rating,
      ratingCount: s.ratingCount,
      views: s.views,
      premiering: s.premiereInDays !== null,
      premierDate:
        s.premiereInDays !== null
          ? new Date(now.getTime() + s.premiereInDays * DAY).toISOString()
          : null,
      addedAt: new Date(now.getTime() - s.addedDaysAgo * DAY).toISOString(),
      flixoraPath: `/stream-movies/${id}`,
      flixoraUrl: `https://flixora-standin.invalid/stream-movies/${id}`,
    };
  });
}
