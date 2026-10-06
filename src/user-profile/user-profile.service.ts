import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  AccountType,
  ContentStatus,
  PurchaseType,
  TransactionStatus,
} from '../../generated/prisma/enums';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type {
  CreatorProfile,
  UserProfile,
  UserProfileWithClaims,
} from '../common/types';
import {
  deriveVerificationState,
  unverified,
} from '../common/verification/verification-state';
import type { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { normaliseHandle, toProfileUrl } from './social-handles';
import { profileCompleteness } from './profile-completeness';
import { ProfileExperienceService } from './profile-experience.service';
import type { ProfileStatsView } from './profile-stats.type';
import { objectKeyFrom, StorageService } from '../storage/storage.service';
import { WalletService } from '../wallet/wallet.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';

/**
 * registry.json "UserProfile". Owns GET/PATCH /users/me and the public
 * GET /users/:wawuId/public-profile aggregate (UserProfile + CreatorState +
 * EvgScore + content/follower/community summaries per the registry note).
 */
@Injectable()
export class UserProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly storage: StorageService,
    private readonly wallet: WalletService,
    private readonly profileExperience: ProfileExperienceService,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  /**
   * Re-signs a stored image URL on the way out.
   *
   * THE BUG THIS FIXES. Avatar and cover are uploaded through
   * StorageService.presignUpload, whose `fileUrl` is a SEVEN-DAY presigned
   * read URL, and that string is what the profile row stores. The bucket is
   * private, so seven days later the stored URL is a 403 and every surface
   * that renders it draws a broken-image placeholder -- including the Edit
   * Profile screen, where both pictures broke at once and made the upload
   * itself look faulty. The object was never gone; only the signature was.
   *
   * `objectKeyFrom` recovers the key from the stored string (the grammar is
   * closed and server-generated, so this is a match against a known shape,
   * not a guess) and the URL is signed again for this response. Nothing
   * stored is rewritten: an external URL, or anything that does not match
   * the shape, is passed through untouched.
   *
   * Failing to sign falls back to the STORED string, never to null. On an
   * environment with no bucket configured that is the only value there is,
   * and it is exactly what shipped before this method existed -- so the worst
   * case here is the old behaviour, never a picture that disappears because
   * signing was unavailable. A profile read must not 500 over an image
   * either.
   */
  private async resignImage(stored: string | null): Promise<string | null> {
    if (!stored) return null;
    const key = objectKeyFrom(stored);
    // Not one of ours: an absolute URL that matches no upload folder is
    // somebody's own link and is passed through untouched.
    if (key === stored && /^https?:\/\//i.test(stored)) return stored;
    try {
      return await this.storage.readUrlFor(key);
    } catch {
      return stored;
    }
  }

  async getMe(user: WawuJwtClaims): Promise<UserProfileWithClaims> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: user.sub },
    });

    // PATCH /users/me creates the row on first call (registry endpoint
    // note: post-WAWU-ID-signup onboarding). A caller who has signed up
    // with WAWU ID but not yet completed WAWUAfrica onboarding legitimately
    // has no row yet — the onboarding screen itself calls GET first to
    // prefill, so this must succeed with empty defaults (accountType/
    // createdAt null), never 404. The registry's declared response shape
    // (non-null accountType/createdAt) describes the post-onboarding case;
    // this pre-onboarding shape is a deliberate, documented deviation.
    const base = profile ?? {
      accountType: null,
      handle: null,
      bio: null,
      interests: [] as string[],
      instagramHandle: null,
      xHandle: null,
      tiktokHandle: null,
      avatarUrl: null,
      coverUrl: null,
      youtubeUrl: null,
      facebookUrl: null,
      linkedinUrl: null,
      whatsappHandle: null,
      websiteUrl: null,
      company: null,
      headline: null,
      createdAt: null,
    };

    // The experience list travels with the profile rather than behind its own
    // GET: the header renders it on first paint, and a second round trip for
    // a list that is almost always under ten rows buys nothing. A caller with
    // no profile row yet has no roles either, so this is an empty array and
    // not a query.
    const [avatarUrl, coverUrl, experience] = await Promise.all([
      this.resignImage(base.avatarUrl),
      this.resignImage(base.coverUrl),
      profile
        ? this.profileExperience.list(user.sub)
        : Promise.resolve([]),
    ]);

    // The four stored dates are pulled OFF the spread and republished as one
    // derived object. `base` is the whole Prisma row, so leaving them in
    // would put the raw expiry on the wire and invite a client to decide for
    // itself whether the tick is live. That decision is the server's.
    const {
      creatorVerifiedAt: _cAt,
      creatorVerifiedUntil: _cUntil,
      professionalVerifiedAt: _pAt,
      professionalVerifiedUntil: _pUntil,
      ...withoutTickDates
    } = base as typeof base & {
      creatorVerifiedAt?: Date | null;
      creatorVerifiedUntil?: Date | null;
      professionalVerifiedAt?: Date | null;
      professionalVerifiedUntil?: Date | null;
    };
    void _cAt;
    void _cUntil;
    void _pAt;
    void _pUntil;

    return {
      ...user,
      ...withoutTickDates,
      avatarUrl,
      coverUrl,
      wawuUserId: user.sub,
      experience,
      verification: profile ? deriveVerificationState(profile) : unverified(),
    } as UserProfileWithClaims;
  }

  /**
   * Onboarding, and the one place an account becomes a creator.
   *
   * Takes the whole claims object rather than the id because of that: a
   * creator account gets a wallet opened for it here (build brief C7), and a
   * wallet is a bank account that needs the name, email, phone and country
   * WAWU ID holds. Those live on the token, not on this row.
   */
  async upsertMe(
    claims: WawuJwtClaims,
    dto: UpdateUserProfileDto,
  ): Promise<UserProfile> {
    const wawuUserId = claims.sub;
    // The name goes to WAWU ID FIRST, and a failure there stops the whole
    // update. Names are checked against a government ID at KYC, so a rename
    // that silently did not take is worse than one that visibly failed: the
    // person believes it is fixed and their payout is still held.
    //
    // All three parts move together. `middleName` may be an empty string,
    // which CLEARS it — somebody who typed one by mistake has to be able to
    // remove it — so only `undefined` means "not editing the name".
    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      if (!dto.firstName?.trim() || !dto.lastName?.trim()) {
        throw new BadRequestException(
          'A first name and a last name are both required.',
        );
      }
      await this.wawuId.updateName(wawuUserId, {
        firstName: dto.firstName,
        middleName: dto.middleName,
        lastName: dto.lastName,
      });
    }

    let saved: UserProfile;
    try {
      saved = await this.prisma.userProfile.upsert({
        where: { wawuUserId },
        update: {
          // `accountType` is deliberately self-selectable (CLAUDE.md: creator
          // is an ACCOUNT TYPE, not an earned tier — the paid gate is
          // CreatorState.subscriptionPaid, checked separately). But the
          // column is NOT nullable, so an explicit `null` must be ignored
          // rather than written, which previously 500'd.
          ...(dto.accountType != null && {
            accountType: dto.accountType as AccountType,
          }),
          ...(dto.interests !== undefined && { interests: dto.interests }),
          ...(dto.bio !== undefined && { bio: dto.bio }),
          ...(dto.handle !== undefined && { handle: dto.handle }),
          ...Object.fromEntries(
            (['websiteUrl', 'avatarUrl', 'coverUrl', 'company', 'headline'] as const)
              .filter((k) => dto[k] !== undefined)
              .map((k) => [k, dto[k]]),
          ),
          // Handles are stored bare, so a typed "@ada" and a typed "ada" do
          // not become two different profiles pointing at the same person.
          ...Object.fromEntries(
            (['xHandle', 'tiktokHandle', 'instagramHandle'] as const)
              .filter((k) => dto[k] !== undefined)
              .map((k) => [k, normaliseHandle(dto[k])]),
          ),
          // These three take a handle OR a link. See social-handles.ts.
          ...(dto.youtubeUrl !== undefined && {
            youtubeUrl: toProfileUrl(dto.youtubeUrl, 'youtube'),
          }),
          ...(dto.facebookUrl !== undefined && {
            facebookUrl: toProfileUrl(dto.facebookUrl, 'facebook'),
          }),
          ...(dto.linkedinUrl !== undefined && {
            linkedinUrl: toProfileUrl(dto.linkedinUrl, 'linkedin'),
          }),
          ...(dto.whatsappHandle !== undefined && {
            whatsappHandle: dto.whatsappHandle,
          }),
        },
        create: {
          wawuUserId,
          accountType: dto.accountType ?? AccountType.user,
          handle: dto.handle ?? null,
          bio: dto.bio ?? null,
          interests: dto.interests ?? [],
          instagramHandle: normaliseHandle(dto.instagramHandle),
          xHandle: normaliseHandle(dto.xHandle),
          tiktokHandle: normaliseHandle(dto.tiktokHandle),
          youtubeUrl: toProfileUrl(dto.youtubeUrl, 'youtube'),
          facebookUrl: toProfileUrl(dto.facebookUrl, 'facebook'),
          linkedinUrl: toProfileUrl(dto.linkedinUrl, 'linkedin'),
          websiteUrl: dto.websiteUrl ?? null,
          company: dto.company ?? null,
          headline: dto.headline ?? null,
          whatsappHandle: dto.whatsappHandle ?? null,
          avatarUrl: dto.avatarUrl ?? null,
          coverUrl: dto.coverUrl ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException('handle is already taken');
      }
      throw error;
    }

    /**
     * A creator account comes with a wallet, opened here.
     *
     * Registration is the moment for it: a creator who lists something and
     * sells it that afternoon has somewhere for the money to go, instead of
     * their share sitting in WAWU's own Flutterwave balance until they happen
     * to open a screen. Professionals come through this same path - applying
     * to be listed requires a creator account type.
     *
     * Idempotent, and it CANNOT fail the profile save. Flutterwave being
     * slow or down is not a reason to reject somebody's onboarding, and
     * GET /wallet opens one on the next read if this did not get through.
     */
    if (saved.accountType === AccountType.creator) {
      await this.wallet.provisionOnRegistration(claims);
    }

    return saved;
  }

  /**
   * Accepts either a wawuUserId or a handle.
   *
   * Profiles are shared by username, not by an opaque id, so a link somebody
   * actually sends to a friend has to resolve. The id is tried first because
   * that is what the app's own internal links use; a handle lookup only runs
   * when that misses.
   */
  async getPublicProfile(
    idOrHandle: string,
    viewerWawuId?: string,
  ): Promise<CreatorProfile> {
    const profile =
      (await this.prisma.userProfile.findUnique({
        where: { wawuUserId: idOrHandle },
      })) ??
      (await this.prisma.userProfile.findUnique({
        where: { handle: idOrHandle.replace(/^@/, '') },
      }));
    if (!profile) {
      throw new NotFoundException('User not found');
    }
    const wawuUserId = profile.wawuUserId;
    // SETTINGS-04: somebody the caller blocked, or who blocked the caller,
    // has no profile to open. Same 404 and wording as an unknown handle, so
    // the answer never says who blocked whom.
    await this.blockedAccounts.assertVisible(
      viewerWawuId,
      wawuUserId,
      'User not found',
    );

    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId },
    });
    if (!creatorState) {
      // The resource concept (public creator profile) exists but this
      // account isn't entitled to one — a plain `user` account type has no
      // CreatorState row (mirrors CreatorStateService's own precedent).
      throw new NotFoundException('This account has no public creator profile');
    }

    const [
      evgScore,
      contentCount,
      followerCount,
      followingCount,
      communityCount,
    ] = await this.prisma.$transaction([
      this.prisma.evgScore.findUnique({
        where: { creatorWawuId: wawuUserId },
      }),
      this.prisma.contentPiece.count({
        where: { creatorWawuId: wawuUserId, status: ContentStatus.live },
      }),
      this.prisma.followRelationship.count({
        where: { followingWawuId: wawuUserId },
      }),
      this.prisma.followRelationship.count({
        where: { followerWawuId: wawuUserId },
      }),
      this.prisma.community.count({ where: { hostWawuId: wawuUserId } }),
    ]);

    await this.recordProfileView(wawuUserId, viewerWawuId);

    const [avatarUrl, coverUrl, experience] = await Promise.all([
      this.resignImage(profile.avatarUrl),
      this.resignImage(profile.coverUrl),
      this.profileExperience.list(profile.wawuUserId),
    ]);

    return {
      wawuUserId: profile.wawuUserId,
      verification: deriveVerificationState(profile),
      handle: profile.handle,
      bio: profile.bio,
      avatarUrl,
      coverUrl,
      interests: profile.interests,
      instagramHandle: profile.instagramHandle,
      xHandle: profile.xHandle,
      tiktokHandle: profile.tiktokHandle,
      youtubeUrl: profile.youtubeUrl,
      facebookUrl: profile.facebookUrl,
      linkedinUrl: profile.linkedinUrl,
      whatsappHandle: profile.whatsappHandle,
      websiteUrl: profile.websiteUrl,
      company: profile.company,
      headline: profile.headline,
      experience,
      // Buyer-facing DM settings — see CreatorProfile's doc comment for why
      // their absence made paid messaging unusable.
      dmEnabled: creatorState.dmEnabled,
      dmPrice: creatorState.dmPrice,
      dmResponseHours: creatorState.dmResponseHours,
      evgScore: evgScore?.score ?? 0,
      contentCount,
      followerCount,
      followingCount,
      communityCount,
    };
  }

  /**
   * Writes one ProfileView, at most once per viewer per UTC day.
   *
   * ── WHAT IS NOT COUNTED, ON PURPOSE ─────────────────────────────────────
   * An ANONYMOUS read writes nothing. `GET /users/public/:wawuId` has no
   * caller to attribute a view to, and counting it would mean the number on
   * the stat card could be driven to any value by a loop with no account.
   * The OWNER'S OWN read writes nothing either: reloading your own page is
   * not somebody looking at you, and it is the first thing that would inflate
   * the figure.
   *
   * At most one row per viewer per day, which the unique key enforces — the
   * upsert is how "already counted today" is expressed without a read first.
   *
   * Failing to record NEVER fails the read. A profile page must not 500
   * because a statistic could not be written; the view is the product, the
   * count is the instrumentation, and they do not rank equally.
   */
  private async recordProfileView(
    profileWawuId: string,
    viewerWawuId?: string,
  ): Promise<void> {
    if (!viewerWawuId || viewerWawuId === profileWawuId) return;
    const viewedOn = startOfUtcDay(new Date());
    try {
      await this.prisma.profileView.upsert({
        where: {
          profileWawuId_viewerWawuId_viewedOn: {
            profileWawuId,
            viewerWawuId,
            viewedOn,
          },
        },
        create: { profileWawuId, viewerWawuId, viewedOn },
        update: {},
      });
    } catch {
      // Deliberately swallowed. See the doc comment: instrumentation must not
      // take the page down with it.
    }
  }

  /**
   * GET /users/me/profile-stats — the numbers on your own profile screen.
   *
   * Owner-only by construction: it takes the caller's own id from the token
   * and there is no parameter to point it at anybody else. Profile views and
   * sales are facts about an account, not about a public profile, and putting
   * them on the public aggregate would publish them to every visitor.
   *
   * Every figure is counted or computed here. There is no stats table and no
   * counter column, so nothing on this response can disagree with the rows it
   * came from.
   */
  async getProfileStats(wawuUserId: string): Promise<ProfileStatsView> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
    });
    if (!profile) {
      throw new NotFoundException('User not found');
    }

    const monthStart = startOfUtcMonth(new Date());

    const [followerCount, followingCount, postCount, profileViews, sold] =
      await this.prisma.$transaction([
        this.prisma.followRelationship.count({
          where: { followingWawuId: wawuUserId },
        }),
        this.prisma.followRelationship.count({
          where: { followerWawuId: wawuUserId },
        }),
        this.prisma.contentPiece.count({
          where: { creatorWawuId: wawuUserId, status: ContentStatus.live },
        }),
        this.prisma.profileView.count({
          where: { profileWawuId: wawuUserId, viewedOn: { gte: monthStart } },
        }),
        // "Products sold" is completed SALES of this creator's own listings.
        // Tips are excluded: a tip is money somebody chose to give, not a
        // thing that was bought, and counting one as a sale overstates what
        // the catalogue did. Pending and failed payments are excluded for the
        // obvious reason that nothing was sold.
        this.prisma.purchase.count({
          where: {
            creatorWawuId: wawuUserId,
            type: PurchaseType.content,
            status: TransactionStatus.completed,
            purchasedAt: { gte: monthStart },
          },
        }),
      ]);

    const completeness = profileCompleteness(profile);

    return {
      wawuUserId,
      followerCount,
      followingCount,
      postCount,
      profileViewsThisMonth: profileViews,
      productsSoldThisMonth: sold,
      monthStart,
      profileCompletenessPct: completeness.pct,
      profileCompletenessMissing: completeness.missing,
    };
  }
}

/** Midnight UTC on the given day — the key the once-per-day view is stored under. */
function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * The first instant of the current calendar month, UTC.
 *
 * UTC rather than a local zone because the server has no business guessing
 * which zone a creator reads "This month" in, and a boundary that moves with
 * whoever is asking would make the same number differ between two requests
 * seconds apart.
 */
function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
