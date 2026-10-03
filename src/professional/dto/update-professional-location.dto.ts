import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * PUT /professionals/location: the city on your card and in the directory.
 * Trimmed before it is checked, so "  Ikeja " is saved as "Ikeja" and a
 * value of spaces alone is refused.
 */
export class UpdateProfessionalLocationDto {
  /** Where you work, as people will read it: "Ikeja", "Port Harcourt". */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  city!: string;
}
