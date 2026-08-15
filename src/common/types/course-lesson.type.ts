import type { CourseLessonModel } from '../../../generated/prisma/models';

export type CourseLesson = CourseLessonModel;

/**
 * Wire response nested under ContentPiece (content-detail screen).
 * `locked` (registry note: "derived from purchase state") is computed
 * per-requester at read time, never a stored column.
 */
export type CourseLessonResponse = CourseLesson & {
  locked: boolean;
};
