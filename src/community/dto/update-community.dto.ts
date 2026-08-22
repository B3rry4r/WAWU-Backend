import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
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

  /**
   * The room's cover image. `null` REMOVES it — @IsOptional() in
   * class-validator admits null as well as undefined, so a host who picked a
   * picture they no longer want has a way back to the placeholder. Omitting
   * the field leaves the current image alone (PATCH semantics), which is why
   * the service branches on `!== undefined` rather than on truthiness.
   */
  @IsOptional()
  @IsUrl(
    // `require_tld: false` mirrors CreateContentDto's asset URLs: the storage
    // endpoint in development is a hostname with no dot in it. On its own
    // that also accepts a bare word like "not-a-url" as a hostname, so the
    // scheme is required and restricted — an `imageUrl` is a thing a browser
    // will be pointed at, and `javascript:` is not one of the two answers.
    { require_tld: false, require_protocol: true, protocols: ['http', 'https'] },
    { message: 'imageUrl must be a full link' },
  )
  @MaxLength(500)
  imageUrl?: string | null;
}
