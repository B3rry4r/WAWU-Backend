import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * PUT /professionals/location: the city on your card and in the directory.
 * Trimmed and its inner runs of white space collapsed to one space before it
 * is checked, so "  Ikeja " is saved as "Ikeja". It must be a place name
 * to read on a card: it starts with a letter and holds letters, marks,
 * spaces, full stops, apostrophes and hyphens only. Digits, new lines,
 * control and invisible (zero-width) characters, and markup are refused.
 */
export class UpdateProfessionalLocationDto {
  /** Where you work, as people will read it: "Ikeja", "Port Harcourt". */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^\p{L}[\p{L}\p{M}'’. -]*$/u, {
    message:
      'city must be a place name: letters, spaces, full stops, apostrophes and hyphens only',
  })
  city!: string;
}
