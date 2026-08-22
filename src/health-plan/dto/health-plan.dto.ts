import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class InitHealthSubscriptionDto {
  @IsString() @IsNotEmpty() @MaxLength(40) planCode!: string;

  @IsString() @IsNotEmpty() @MaxLength(60) firstName!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) lastName!: string;

  /** Nigerian mobile number. WellaHealth keys the enrollee on this. */
  @Matches(/^(\+?234|0)[789][01]\d{8}$/, {
    message: 'Enter a valid Nigerian phone number.',
  })
  phoneNumber!: string;

  @IsIn(['Male', 'Female'])
  gender!: string;

  @IsISO8601({}, { message: 'dateOfBirth must be a date like 1994-05-21.' })
  dateOfBirth!: string;

  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
}

export class VerifyHealthSubscriptionDto {
  @Type(() => String)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  transactionId!: string;
}

/**
 * Operator action: record a refund already paid back by hand.
 *
 * Same contract as WAWUPay's — see bill.dto.ts. Nothing here moves money;
 * `refundReference` is the reference of the refund a human actually sent, and
 * `refunded` is never written without it.
 */
export class RecordCareRefundDto {
  @IsString() @IsNotEmpty() @MaxLength(120) refundReference!: string;
}
