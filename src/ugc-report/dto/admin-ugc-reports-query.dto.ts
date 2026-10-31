import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { UGC_KINDS, type UgcKind } from '../ugc-report.kinds';

/** GET /admin/reports. Open reports only, one row per reported item, oldest first. */
export class AdminUgcReportsQueryDto extends PaginationQueryDto {
  /** Only this kind of item. */
  @IsOptional()
  @IsIn(UGC_KINDS)
  kind?: UgcKind;
}
