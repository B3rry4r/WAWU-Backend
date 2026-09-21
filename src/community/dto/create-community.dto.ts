import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `CommunityKind` (prisma/schema.prisma) — the enum's real members, not an
 * invented set. Both kinds are open to every creator account. `private` used
 * to be a Pro-tier feature enforced in CommunityService.create; the tier that
 * sold it is gone, and so is the check.
 */
const COMMUNITY_KINDS = ['open', 'private'] as const;

/** Body for POST /communities — a creator opens a community they host. */
export class CreateCommunityDto {
  /**
   * Bound: 3-80 characters. A community name is a list-row heading on both
   * the mobile and desktop community surfaces, so it is deliberately far
   * shorter than ContentPiece.title (200) — anything longer is a
   * description, not a name. `\S` rejects an all-whitespace name, which
   * @IsNotEmpty alone lets through and which renders as a blank, unclickable
   * row.
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(80)
  @Matches(/\S/, {
    message: 'name must contain at least one non-space character',
  })
  name: string;

  /**
   * Bound: 1-500 characters. This is the "what this community is for" blurb
   * shown on the community card / join screen, not long-form content — an
   * order of magnitude shorter than ContentPiece.description (5000), which
   * backs a full detail page. Required, because `Community.description` is
   * a non-nullable column and a community with no stated purpose is the
   * thing nobody joins.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(/\S/, {
    message: 'description must contain at least one non-space character',
  })
  description: string;

  @IsIn(COMMUNITY_KINDS)
  kind: (typeof COMMUNITY_KINDS)[number];

  /**
   * The room's cover image, as the `fileUrl` handed back by
   * `POST /uploads/presign` for the `community/image` folder. Optional — a
   * community without one is normal and the client falls back to its
   * placeholder tile, so hosting is never blocked on finding a picture.
   *
   * No `@MaxLength` here, matching every other asset-URL field in this
   * backend (CreateContentDto's previewAssetUrl/fullAssetUrl, CreateEventDto's
   * bannerUrl — neither caps length). A presigned S3 GET URL carries the
   * bucket, region, path and a full signed query string, routinely well past
   * 500 characters; a cap this field alone had meant every community created
   * with a picture 400'd against this backend's own presign output.
   */
  @IsOptional()
  @IsUrl(
    // `require_tld: false` mirrors CreateContentDto's asset URLs: the storage
    // endpoint in development is a hostname with no dot in it. On its own
    // that also accepts a bare word like "not-a-url" as a hostname, so the
    // scheme is required and restricted — an `imageUrl` is a thing a browser
    // will be pointed at, and `javascript:` is not one of the two answers.
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'imageUrl must be a full link' },
  )
  imageUrl?: string;
}
