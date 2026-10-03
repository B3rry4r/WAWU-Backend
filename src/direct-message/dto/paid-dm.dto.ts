import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** The cursor-paged query every paid-question list takes. */
export class PaidDmPageQueryDto {
  /** Opaque: send back the `nextCursor` of the previous page as given. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** 1 to 100, 20 when left out. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** GET /paid-dm/threads: which side to read as. Fan when left out. */
export class PaidDmThreadsQueryDto extends PaidDmPageQueryDto {
  @IsOptional()
  @IsIn(['fan', 'creator'])
  as?: 'fan' | 'creator';
}

/** POST /paid-dm/questions/:messageId/replies. */
export class PaidDmReplyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @Matches(/\S/, {
    message: 'text must contain at least one non-space character',
  })
  text: string;
}
