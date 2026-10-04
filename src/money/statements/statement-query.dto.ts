import { ApiProperty } from '@nestjs/swagger';
import { IsIn, Matches } from 'class-validator';
import { STATEMENT_FORMATS, type StatementFormat } from './statement-view.type';

/** A calendar day, YYYY-MM-DD. Whether the day exists is checked by the service. */
export const STATEMENT_DAY_PATTERN =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

/**
 * GET /money/statements (task WALLET-27, W38).
 *
 * The period is two calendar days in Africa/Lagos time, and BOTH days are
 * in it: `from=2026-09-01&to=2026-09-30` is every movement from 00:00 on
 * 1 September to 23:59:59.999 on 30 September, Lagos time (UTC+1), so a
 * movement at 23:30 UTC on 31 August (00:30 on 1 September in Lagos) is in
 * it and one at 23:30 UTC on 30 September (1 October in Lagos) is not.
 */
export class StatementQueryDto {
  /** The first day of the statement, YYYY-MM-DD in Africa/Lagos time, included. */
  @ApiProperty({ pattern: STATEMENT_DAY_PATTERN.source, example: '2026-09-01' })
  @Matches(STATEMENT_DAY_PATTERN, { message: 'from must look like 2026-09-01' })
  from!: string;

  /**
   * The last day of the statement, YYYY-MM-DD in Africa/Lagos time,
   * included. On or after `from`, not after today in Lagos, and at most
   * 366 days from `from`, both days counted (STATEMENT_MAX_DAYS).
   */
  @ApiProperty({ pattern: STATEMENT_DAY_PATTERN.source, example: '2026-09-30' })
  @Matches(STATEMENT_DAY_PATTERN, { message: 'to must look like 2026-09-30' })
  to!: string;

  /**
   * The file. Only `csv` today: Fintava issues no stamped statement
   * (WALLET-27, BACKEND_GAPS G-68), so there is no `pdf`.
   */
  @ApiProperty({ enum: STATEMENT_FORMATS })
  @IsIn(STATEMENT_FORMATS)
  format!: StatementFormat;
}
