import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * S4's meter check. `code` is one of the codes `GET /bills/electricity/billers` listed; the plan comes from it, so the
 * app never sends one. `meterNumber` is digits: spaces and dashes the person typed are taken out first, and the length
 * is left to Fintava (a number it does not know is a 400 there, which is S10 here).
 */
export class MeterPreviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_]+$/)
  code!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  )
  @IsString()
  @Matches(/^[0-9]{1,20}$/, {
    message: 'meterNumber must be digits only, at most 20',
  })
  meterNumber!: string;
}
