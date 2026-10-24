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

  /**
   * The lesson's file: the key (or link) of an upload this person made under `content/full`. A new lesson with none has no file yet.
   * A lesson kept by `id` keeps the file it has when this is left out (FIX-111: the editor does not know the key of a file it did not
   * upload), takes a new one when a key is sent, and loses its file only when this is `null`.
   */
  @IsOptional()
  @IsString()
  assetKey?: string | null;
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
