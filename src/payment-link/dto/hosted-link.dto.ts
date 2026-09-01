import { IsEmail, IsIn, IsInt, IsOptional, IsString, IsUrl, MaxLength, Min, MinLength } from 'class-validator';

/**
 * A hosted-checkout link request.
 *
 * The AMOUNT is accepted here and that is deliberate, but it is not trusted:
 * the link is only ever minted for a `txRef` that a real init endpoint already
 * recorded a PendingCharge for, and the amount is re-read from that row. See
 * PaymentLinkService.
 */
export class HostedLinkDto {
  @IsString()
  @MinLength(6)
  @MaxLength(120)
  txRef!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsIn(['NGN'])
  currency?: 'NGN';

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  /** Prefills the payer's email on Flutterwave's page. Not trusted for anything else. */
  @IsEmail()
  customerEmail!: string;

  /** Where Flutterwave sends the payer back. Same-origin only, checked in the service. */
  @IsUrl({ require_protocol: true })
  redirectUrl!: string;
}
