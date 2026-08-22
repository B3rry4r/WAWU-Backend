import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class ValidateCustomerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  itemCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  customer!: string;
}

export class InitBillDto {
  @IsString() @IsNotEmpty() @MaxLength(60) category!: string;
  @IsString() @IsNotEmpty() @MaxLength(40) billerCode!: string;
  @IsString() @IsNotEmpty() @MaxLength(40) itemCode!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) billerName!: string;

  /** Phone, meter or smartcard number. */
  @IsString() @IsNotEmpty() @MaxLength(60) customerRef!: string;

  /**
   * Naira, whole numbers only. The ₦50 floor keeps obviously-bogus charges out;
   * the ceiling is a blast radius limit, not a product rule.
   */
  @Type(() => Number)
  @IsInt()
  @Min(50)
  amount!: number;
}

export class VerifyBillDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  transactionId!: string;
}

export class ListBillersQueryDto {
  @IsOptional() @IsString() @MaxLength(4) country?: string;
}

/**
 * Operator action: record a refund that has ALREADY been paid back to the
 * customer.
 *
 * `FulfilmentStatus.refunded` had no writer anywhere, while the failure
 * message the customer sees says verbatim "our team will refund you". This
 * closes that, but it does not perform a refund: nothing in this codebase can
 * move money back to a card — there is no Flutterwave refund adapter — so the
 * reference of the refund a human actually made is mandatory. Without one the
 * status would be a claim about money that never moved, which is exactly the
 * lie this endpoint exists to stop.
 */
export class RecordRefundDto {
  /**
   * The provider/bank reference for the refund that was actually sent. Not
   * optional, on purpose.
   */
  @IsString() @IsNotEmpty() @MaxLength(120) refundReference!: string;
}
