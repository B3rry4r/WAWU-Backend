import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Which slice of the refund ledger to show. Defaults to the one that needs a human. */
export const DM_REFUND_QUEUE_STATUSES = [
  'failed',
  'owed',
  'submitted',
  'settled',
] as const;
export type DmRefundQueueStatus = (typeof DM_REFUND_QUEUE_STATUSES)[number];

export class AdminDmRefundQueueQueryDto {
  /**
   * Defaults to `failed` — the only slice that cannot resolve itself. `owed`
   * and `submitted` clear on their own within minutes, and listing them by
   * default would bury the rows a person actually has to act on.
   */
  @IsOptional()
  @IsIn(DM_REFUND_QUEUE_STATUSES)
  status?: DmRefundQueueStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number;
}
