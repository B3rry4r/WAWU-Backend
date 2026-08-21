import {
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `CommunityKind` (prisma/schema.prisma) — the enum's real members, not an
 * invented set. `open` is available on Basic; `private` is a Pro-tier
 * feature, enforced server-side in CommunityService.create (docs/01_SPEC.md:
 * Basic "cannot open/host private communities", Pro "Can open/host private
 * communities").
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
}
