import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_TICKETS_PER_ORDER } from '../event-ticketing.constants';
import { MAX_ORDER_LINES } from './event-wallet-order-rules';

const MAX_EXACT_KOBO = Number.MAX_SAFE_INTEGER;

/** One tier of the basket: the stepper of E2 for that tier. */
export class EventOrderLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ticketTypeId!: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_TICKETS_PER_ORDER })
  @IsInt()
  @Min(1)
  @Max(MAX_TICKETS_PER_ORDER)
  quantity!: number;
}

/**
 * POST /events/{id}/orders/wallet: make an order for tickets. One line per
 * ticket type, so a Regular and a VIP ticket are bought in one payment (E2).
 * At most 50 tickets in all. Header: Idempotency-Key (optional, one per tap).
 */
export class CreateEventWalletOrderDto {
  @ApiProperty({ type: () => [EventOrderLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => EventOrderLineDto)
  lines!: EventOrderLineDto[];

  /** The referral link this buyer arrived through, when there was one. */
  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  referralCode?: string;
}

/**
 * POST /events/orders/wallet/pay. Headers: Idempotency-Key, X-Transaction-Pin.
 * The order is in the body, not the path, so the key's fingerprint covers
 * which order it pays.
 */
export class PayEventWalletOrderDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  orderId!: string;

  /** `payment.totalKobo` from the quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  expectedTotalKobo!: number;

  /** `payment.quoteToken` from that quote. */
  @ApiProperty()
  @IsString()
  @Length(1, 1024)
  quoteToken!: string;
}
