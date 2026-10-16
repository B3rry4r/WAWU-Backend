import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** GET /inbox. */
export class InboxPageQueryDto {
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

  /** Only rows of this kind (the Paid DMs and Communities chips). All kinds when left out. */
  @IsOptional()
  @IsIn(['chat', 'paid_dm', 'community'])
  kind?: 'chat' | 'paid_dm' | 'community';
}
