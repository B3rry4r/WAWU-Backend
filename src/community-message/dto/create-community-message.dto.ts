import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body for POST /communities/:id/messages per the frozen CommunityMessage contract. */
export class CreateCommunityMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;
}
