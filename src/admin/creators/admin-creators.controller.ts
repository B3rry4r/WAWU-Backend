import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminCreatorsService } from './admin-creators.service';
import { AdminCreatorSearchQueryDto } from './dto/admin-creator-search-query.dto';

/**
 * Creator lookup — `/api/hub/admin/creators/*` once the global prefix is
 * applied.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   search, detail — superadmin, support, finance
 *   reviewer       — refused entirely, on both routes here
 *
 * Support reads it because "I paid and I cannot upload" is a support ticket
 * and this screen is its answer; finance reads it because a scheduled
 * downgrade and a `past_due` subscription are money questions. Both routes are
 * read-only — there is no write on this surface at all.
 *
 * Support being allowed here and REFUSED in `../kyc-review/` is not an
 * inconsistency. What support is refused there is KYC DOCUMENTS: BVN, NIN, the
 * ID image, the payout bank account. A `kycStatus` string is a five-letter
 * lifecycle word carrying no PII, and withholding it would mean a support
 * agent cannot tell a creator why they are not being paid. This surface never
 * selects a document field — see `KYC_SAFE_SELECT` in the service, which is
 * the whole of what it reads from `KycSubmission`.
 *
 * Reviewer is refused because content moderation has no business enumerating
 * every account's subscription and earnings; the creator context a reviewer
 * needs already rides on each row of `/admin/content/queue`.
 *
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so each
 * handler names its roles and the matrix is readable here.
 *
 * `ParseUUIDPipe` on `:wawuId` is version-UNPINNED, matching
 * AdminContentReviewController's reasoning: `wawuUserId` values in this data
 * are not all v4 (the seeded ids are `…-0000-…`, whose version nibble is 0),
 * and pinning would 400 on real stored rows while the dashboard rendered it as
 * "not found".
 *
 * No path segment collides with an existing controller: nothing outside
 * `src/admin/` declares an `admin` prefix, and the app's own creator-facing
 * routes are `@Controller('creator')` (creator state) and
 * `@Controller('content/mine/earnings')` — each a different first segment.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/creators')
export class AdminCreatorsController {
  constructor(private readonly service: AdminCreatorsService) {}

  /**
   * Search and list. `?q=` matches handle (partial, case-insensitive) and
   * wawuUserId (prefix); an email or phone number is refused with an
   * explanation rather than an empty page, because this backend genuinely
   * stores neither — see AdminCreatorSearchQueryDto.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.support, AdminRole.finance)
  @Get()
  listCreators(@Query() query: AdminCreatorSearchQueryDto) {
    return this.service.listCreators(query);
  }

  /** One creator: subscription, both gates, badge, slots and earnings, as distinct fields. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support, AdminRole.finance)
  @Get(':wawuId')
  creatorDetail(@Param('wawuId', ParseUUIDPipe) wawuId: string) {
    return this.service.creatorDetail(wawuId);
  }
}
