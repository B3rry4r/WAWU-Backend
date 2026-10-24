import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DURATION_PATTERN } from './set-media.dto';

/**
 * PROVISIONAL(COURSE-MAX-LESSONS, owner=YOU, why=no ruling or design names how many lessons a course may hold; H25 draws 12)
 *
 * The most lessons one course may hold. A bound against abuse; the 400 message follows this number.
 */
export const MAX_LESSONS = 60;

/** One lesson of a course, as the creator states it. */
export class LessonInputDto {
  /** An existing lesson of this course to keep (its progress and place stay); left out, a new lesson is made. */
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @Length(1, 120)
  title!: string;

  /** The lesson's length as a player writes it: `4:12` or `1:20:05`. */
  @IsOptional()
  @IsString()
  @Matches(DURATION_PATTERN, {
    message: 'durationLabel must look like 4:12 or 1:20:05',
  })
  durationLabel?: string;

  /** The lesson's file: the key (or link) of an upload this person made under `content/full`. Left out, the lesson has no file yet. */
  @IsOptional()
  @IsString()
  assetKey?: string;
}

/** Body for PUT /content/:id/lessons: the whole list, in the order the lessons are taken. */
export class SetLessonsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LESSONS, {
    message: `a course holds at most ${MAX_LESSONS} lessons`,
  })
  @ValidateNested({ each: true })
  @Type(() => LessonInputDto)
  lessons!: LessonInputDto[];
}
