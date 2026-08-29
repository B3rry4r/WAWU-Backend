import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TicketTier } from '../../../generated/prisma/enums';
import { MAX_TICKETS_PER_ORDER } from '../event-ticketing.constants';

export class TicketTypeDto {
  @IsEnum(TicketTier)
  tier!: TicketTier;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  /**
   * Naira. Zero is allowed — a `free` tier is a real thing — but the service
   * refuses a zero price on a paid tier, because a "VIP" ticket costing
   * nothing is a mistake somebody will only notice after it sells out.
   */
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceNaira!: number;

  /** No unlimited option: a venue has a capacity and somebody must state it. */
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;

  @IsOptional()
  @IsString()
  salesStartAt?: string;

  @IsOptional()
  @IsString()
  salesEndAt?: string;
}

export class SetTicketTypesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TicketTypeDto)
  types!: TicketTypeDto[];
}

export class BuyTicketsDto {
  @IsString()
  ticketTypeId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_TICKETS_PER_ORDER)
  quantity!: number;

  /** The referral link this buyer arrived through, when there was one. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  referralCode?: string;
}

export class VerifyOrderDto {
  @IsString()
  transaction_id!: string;

  @IsString()
  tx_ref!: string;
}

export class ScanTicketDto {
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  code!: string;
}

export class CreateReferralDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  label!: string;
}

export class CancelEventDto {
  /**
   * Required, and shown to every ticket holder. Somebody who has bought a
   * ticket and arranged their day around it is owed a sentence, not a status
   * change.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
