import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Body for POST /content/:id/comments per registry.json Comment contract. */
export class CreateCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;

  @IsOptional()
  @IsUUID()
  replyToId?: string | null;
}
