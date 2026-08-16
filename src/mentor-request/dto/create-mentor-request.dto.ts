import { ArrayNotEmpty, IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body for POST /services/mentors/:id/requests per registry.json MentorRequest contract. */
export class CreateMentorRequestDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  topics: string[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note: string;

  @IsString()
  @IsNotEmpty()
  slot: string;
}
