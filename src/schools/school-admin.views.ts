import type {
  CourseIntake,
  School,
  SchoolCourse,
} from '../../generated/prisma/client';

/** What the dashboard reads back. Money is whole kobo, dates are YYYY-MM-DD. */
export interface AdminIntakeView {
  id: string;
  courseId: string;
  startDate: string;
  schedule: string;
  location: string | null;
  capacity: number;
  seatsTaken: number;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCourseView {
  id: string;
  schoolId: string;
  title: string;
  weeks: number;
  mode: SchoolCourse['mode'];
  syllabus: string[];
  outcomes: string[];
  priceKobo: number;
  hidden: boolean;
  intakes: AdminIntakeView[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminSchoolSummary {
  id: string;
  name: string;
  category: School['category'];
  location: string;
  logo: string | null;
  hidden: boolean;
  courseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSchoolDetail {
  id: string;
  name: string;
  category: School['category'];
  location: string;
  foundedYear: number | null;
  expertise: string[];
  about: string;
  logo: string | null;
  applyUrl: string | null;
  reportEmail: string;
  hidden: boolean;
  courses: AdminCourseView[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminSchoolsPage {
  items: AdminSchoolSummary[];
  nextCursor: string | null;
}

export function intakeView(r: CourseIntake): AdminIntakeView {
  return {
    id: r.id,
    courseId: r.courseId,
    startDate: r.startDate.toISOString().slice(0, 10),
    schedule: r.schedule,
    location: r.location,
    capacity: r.capacity,
    seatsTaken: r.seatsTaken,
    hidden: r.hiddenAt !== null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function courseView(
  r: SchoolCourse & { intakes: CourseIntake[] },
): AdminCourseView {
  return {
    id: r.id,
    schoolId: r.schoolId,
    title: r.title,
    weeks: r.weeks,
    mode: r.mode,
    syllabus: r.syllabus,
    outcomes: r.outcomes,
    priceKobo: r.priceKobo,
    hidden: r.hiddenAt !== null,
    intakes: [...r.intakes]
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
      .map(intakeView),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function schoolSummary(
  r: School & { _count: { courses: number } },
): AdminSchoolSummary {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    location: r.location,
    logo: r.logo,
    hidden: r.hiddenAt !== null,
    courseCount: r._count.courses,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function schoolDetail(
  r: School & { courses: (SchoolCourse & { intakes: CourseIntake[] })[] },
): AdminSchoolDetail {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    location: r.location,
    foundedYear: r.foundedYear,
    expertise: r.expertise,
    about: r.about,
    logo: r.logo,
    applyUrl: r.applyUrl,
    reportEmail: r.reportEmail,
    hidden: r.hiddenAt !== null,
    courses: r.courses.map(courseView),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
