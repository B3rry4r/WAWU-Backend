import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/**
 * GET /events/from-prices?ids=<uuid>,<uuid>: one page of the calendar at a
 * time, so at most as many ids as a page can hold.
 */
export class EventFromPricesQueryDto {
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.split(',').filter((v) => v.length > 0)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ids: string[] = [];
}
