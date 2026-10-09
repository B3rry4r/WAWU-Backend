import type {
  CourseIntake,
  School,
  SchoolCourse,
} from '../../generated/prisma/client';

/**
 * What the app reads (SC1 to SC3, SC10). Money is whole kobo, dates are
 * YYYY-MM-DD. There is no rating field: no review system exists (R-32).
 * `reportEmail` and `hidden` never leave the server.
 */
export interface PublicIntakeView {
  id: string;
  startDate: string;
  schedule: string;
  location: string | null;
  capacity: number;
  seatsLeft: number;
  full: boolean;
}

export interface PublicSchoolCourseCard {
  id: string;
  title: string;
  weeks: number;
  mode: SchoolCourse['mode'];
  priceKobo: number;
  nextIntake: PublicIntakeView | null;
}

export interface PublicSchoolCard {
  id: string;
  name: string;
  category: School['category'];
  location: string;
  logo: string | null;
  foundedYear: number | null;
  expertise: string[];
  courseCount: number;
  /** The lowest fee among the shown courses, or null with none. */
  fromPriceKobo: number | null;
  /** Titles of shown courses that matched the search term (at most 3). */
  matchedCourses: string[];
}

export interface PublicSchoolsPage {
  items: PublicSchoolCard[];
  nextCursor: string | null;
}

export interface PublicSchoolDetail extends PublicSchoolCard {
  about: string;
  applyUrl: string | null;
  courses: PublicSchoolCourseCard[];
}

export interface PublicCourseDetail {
  id: string;
  title: string;
  weeks: number;
  mode: SchoolCourse['mode'];
  syllabus: string[];
  outcomes: string[];
  priceKobo: number;
  school: {
    id: string;
    name: string;
    category: School['category'];
    location: string;
    logo: string | null;
    applyUrl: string | null;
  };
  intakes: PublicIntakeView[];
}

/** Seats left come from capacity minus the seats taken, never below 0. */
export function intakeView(r: CourseIntake): PublicIntakeView {
  const seatsLeft = Math.max(0, r.capacity - r.seatsTaken);
  return {
    id: r.id,
    startDate: r.startDate.toISOString().slice(0, 10),
    schedule: r.schedule,
    location: r.location,
    capacity: r.capacity,
    seatsLeft,
    full: seatsLeft === 0,
  };
}

type CourseWithIntakes = SchoolCourse & { intakes: CourseIntake[] };

/** Intakes are passed in already filtered to the shown ones, soonest first. */
export function courseCard(r: CourseWithIntakes): PublicSchoolCourseCard {
  const next = r.intakes[0];
  return {
    id: r.id,
    title: r.title,
    weeks: r.weeks,
    mode: r.mode,
    priceKobo: r.priceKobo,
    nextIntake: next ? intakeView(next) : null,
  };
}

export function schoolCard(
  r: School & { courses: Pick<SchoolCourse, 'title' | 'priceKobo'>[] },
  matchedCourses: string[] = [],
): PublicSchoolCard {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    location: r.location,
    logo: r.logo,
    foundedYear: r.foundedYear,
    expertise: r.expertise,
    courseCount: r.courses.length,
    fromPriceKobo: r.courses.length
      ? Math.min(...r.courses.map((c) => c.priceKobo))
      : null,
    matchedCourses,
  };
}
