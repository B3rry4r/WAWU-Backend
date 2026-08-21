import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body for PATCH /communities/:id — the host edits the community's
 * presentation. Both fields optional (PATCH semantics: send only what
 * changes); an empty body is rejected in the service so a no-op PATCH
 * doesn't read as a successful edit.
 *
 * `kind` is deliberately NOT editable. Flipping `private` -> `open` would
 * retroactively expose a private community's whole message history to
 * everyone, and `open` -> `private` would strand existing `joined` members
 * inside a community they were never approved for. Neither is a rename; both
 * are a different product decision that needs its own endpoint and its own
 * membership re-consent rules. Bounds mirror CreateCommunityDto exactly —
 * see its doc comments for why 80 / 500.
 */
export class UpdateCommunityDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(80)
  @Matches(/\S/, {
    message: 'name must contain at least one non-space character',
  })
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(/\S/, {
    message: 'description must contain at least one non-space character',
  })
  description?: string;
}
