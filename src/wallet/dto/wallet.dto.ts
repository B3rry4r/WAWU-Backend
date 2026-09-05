import { IsInt, IsString, Length, Matches, Min } from 'class-validator';
import { MIN_WITHDRAWAL_NGN } from '../wallet.service';

export class WithdrawDto {
  /** Whole naira, like every other amount in this codebase. */
  @IsInt()
  @Min(MIN_WITHDRAWAL_NGN)
  amount!: number;

  /** A bank CODE ("044"), never a bank name. Transfers cannot use a name. */
  @IsString()
  @Matches(/^[0-9]{3,6}$/, { message: 'bankCode must be a numeric bank code' })
  bankCode!: string;

  /** NUBAN. Ten digits in Nigeria, and never anything but digits. */
  @IsString()
  @Matches(/^[0-9]{10}$/, { message: 'accountNumber must be 10 digits' })
  accountNumber!: string;
}

export class ResolveAccountDto {
  @IsString()
  @Matches(/^[0-9]{3,6}$/, { message: 'bankCode must be a numeric bank code' })
  bankCode!: string;

  @IsString()
  @Matches(/^[0-9]{10}$/, { message: 'accountNumber must be 10 digits' })
  accountNumber!: string;
}

export class OpenWalletDto {
  /** Falls back to the caller's own country when absent. */
  @IsString()
  @Length(2, 2)
  country!: string;
}
