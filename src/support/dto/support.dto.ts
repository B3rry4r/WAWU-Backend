import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsUUID, ValidateNested } from 'class-validator';

/** What a support thread can be about: a wallet transaction or a payment. */
export const SUPPORT_REFERENCE_KINDS = ['transaction', 'payment'] as const;

export class SupportReferenceDto {
  /**
   * `transaction` is a row of the wallet's history (W27's id); `payment` is a
   * payment the person made, such as an unlock (the id the unlock answered).
   */
  @IsIn(SUPPORT_REFERENCE_KINDS)
  kind: (typeof SUPPORT_REFERENCE_KINDS)[number];

  @IsUUID()
  id: string;
}

/** POST /support/thread. */
export class OpenSupportThreadDto {
  /** What the person wants help with. Left out: the thread opens with nothing attached. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SupportReferenceDto)
  reference?: SupportReferenceDto;
}
