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
