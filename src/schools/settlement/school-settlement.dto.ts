import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SETTLEMENT_ACTIONS,
  SETTLEMENT_STATUSES,
  type SettlementAction,
  type SettlementStatus,
} from './school-settlement-rules';

/** PUT /admin/schools/{id}/payee: the bank account the school is paid at. */
export class SetPayeeDto {
  /** The bank's code in the provider's list. */
  @ApiProperty({ example: '058' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^[A-Za-z0-9]{3,12}$/)
  bankCode!: string;

  /** Ten digits. The bank is asked for the holder's name before anything is saved. */
  @ApiProperty({ example: '0123456789' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^\d{10}$/)
  accountNumber!: string;
}

/** GET /admin/school-settlements. */
export class ListSettlementsDto {
  @ApiPropertyOptional({ enum: SETTLEMENT_STATUSES })
  @IsOptional()
  @IsIn(SETTLEMENT_STATUSES)
  status?: SettlementStatus;

  @ApiPropertyOptional({ enum: SETTLEMENT_ACTIONS })
  @IsOptional()
  @IsIn(SETTLEMENT_ACTIONS)
  action?: SettlementAction;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  schoolId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
