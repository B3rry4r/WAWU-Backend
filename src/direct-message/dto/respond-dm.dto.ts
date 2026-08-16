import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body for POST /dm/:messageId/respond per the task brief's frozen contract. */
export class RespondDmDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;
}
