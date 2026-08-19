import { IsArray, IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

/**
 * The generic "short request" the previous platform used for its partner
 * services: the applicant says what they need, attaches anything relevant, and
 * the partner reviews it. Only CAC and NEPC need their own bespoke forms.
 */
export const PARTNER_SERVICE_KINDS = ['loans', 'pension'] as const;
export type PartnerServiceKind = (typeof PARTNER_SERVICE_KINDS)[number];

export class ApplyPartnerServiceDto {
  @IsIn(PARTNER_SERVICE_KINDS as unknown as string[])
  kind!: PartnerServiceKind;

  /** What the applicant wants. Free text, because each partner asks differently. */
  @IsString()
  @MinLength(10, { message: 'Tell the partner a little more about what you need.' })
  @MaxLength(1500)
  note!: string;

  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  documents?: string[];
}
