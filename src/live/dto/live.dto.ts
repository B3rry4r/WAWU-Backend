import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LIVE_LIMITS } from '../live-limits';

/** `GET /live/catch-up` */
export class LiveCatchUpQueryDto {
  /**
   * The newest `cursor` the app holds: from an event, from the socket's
   * `ready` frame, or from the last catch-up. Left out, nothing is returned
   * and the cursor in the answer is where "now" is.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** 1 to 100, 50 when left out. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIVE_LIMITS.catchUpMaxLimit)
  limit?: number;
}
