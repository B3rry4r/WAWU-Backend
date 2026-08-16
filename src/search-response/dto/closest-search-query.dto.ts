import { IsNotEmpty, IsString } from 'class-validator';

/** Query for GET /search/closest — same `q` requirement as GET /search. */
export class ClosestSearchQueryDto {
  @IsString()
  @IsNotEmpty()
  q: string;
}
