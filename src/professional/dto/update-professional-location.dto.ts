import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Starts with a letter; holds letters, marks, spaces, full stops, apostrophes
 * and hyphens; no invisible or filler character; at most 3 marks in a row; at
 * least 2 letters.
 */
const CITY_RULE =
  /^(?!.*\p{Default_Ignorable_Code_Point})(?!.*\p{M}{4})(?=(?:.*?\p{L}){2})\p{L}[\p{L}\p{M}'’. -]*$/u;

/**
 * PUT /professionals/location: the city on your card and in the directory.
 * Trimmed and its inner runs of white space collapsed to one space before it
 * is checked, so "  Ikeja " is saved as "Ikeja". It must be a place name
 * to read on a card: it starts with a letter and holds letters, marks,
 * spaces, full stops, apostrophes and hyphens only. Digits, new lines,
 * control and invisible (zero-width) characters, and markup are refused.
 * So are letters that draw nothing (the Hangul and half-width fillers and
 * every other Default_Ignorable_Code_Point), more than 3 combining marks in
 * a row (a smeared glyph), and a name with fewer than 2 letters.
 */
export class UpdateProfessionalLocationDto {
  /** Where you work, as people will read it: "Ikeja", "Port Harcourt". */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(CITY_RULE, {
    message:
      'city must be a place name: letters, spaces, full stops, apostrophes and hyphens only',
  })
  city!: string;
}
