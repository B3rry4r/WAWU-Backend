import { PrismaService } from '../common/prisma/prisma.service';

/**
 * WHAT A DATA EXPORT CONTAINS, AND WHAT IT NEVER CONTAINS (SETTINGS-04).
 *
 * An export is the one place where a bug hands a stranger's data to a person,
 * or a person's secrets to whoever reads their mailbox. So nothing here is
 * generic: every section names its model and selects its fields one by one.
 * A column added to a table later is NOT exported until somebody adds it
 * here, which is the safe direction to fail in.
 *
 * Three rules every section follows:
 *
 *  1. ONLY THE REQUESTER'S ROWS. Each loader filters on the requester's id
 *     in the column that says "this is theirs" (the author, the buyer, the
 *     owner), never on a column that merely names them.
 *  2. NOTHING SOMEBODY ELSE WROTE. A reply, a message to the requester or a
 *     follower list is another person's. Their ids appear only where the
 *     requester's own action points at them (who they follow, who they
 *     messaged, whom they blocked), because that is the requester's record.
 *  3. NO SECRETS, NO SIGNED LINKS, NO PROVIDER REFERENCES. No PIN, hash,
 *     identity number, bank account, device key, file key or signed URL, and
 *     no payment-provider transaction id.
 *
 * `data-export-map.spec.ts` fails the build when a model that the account purge
 * treats as the account's own (account-data-map.ts) is in neither
 * EXPORT_SECTIONS nor EXPORT_EXCLUDED, so a new table cannot quietly be left
 * out of both the deletion and the export.
 */

export interface ExportSection {
  /** The key under `data` in the export file. */
  key: string;
  /** The Prisma models this section reads, as named in account-data-map.ts. */
  models: string[];
  load(prisma: PrismaService, me: string): Promise<unknown>;
}

const NEWEST = { createdAt: 'desc' as const };

export const EXPORT_SECTIONS: ExportSection[] = [
  {
    key: 'profile',
    models: ['UserProfile', 'ProfileExperience'],
    load: async (prisma, me) => {
      const profile = await prisma.userProfile.findUnique({
        where: { wawuUserId: me },
        select: {
          accountType: true,
          handle: true,
          bio: true,
          headline: true,
          company: true,
          interests: true,
          instagramHandle: true,
          whatsappHandle: true,
          websiteUrl: true,
          xHandle: true,
          tiktokHandle: true,
          youtubeUrl: true,
          facebookUrl: true,
          linkedinUrl: true,
          createdAt: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
          experience: {
            select: {
              title: true,
              company: true,
              location: true,
              startedOn: true,
              endedOn: true,
              description: true,
            },
            orderBy: { startedOn: 'desc' },
          },
        },
      });
      return profile;
    },
  },
  {
    key: 'profileDetails',
    models: ['ProfileDetails'],
    load: (prisma, me) =>
      prisma.profileDetails.findUnique({
        where: { wawuUserId: me },
        select: {
          location: true,
          skills: true,
          openTo: true,
          threadsHandle: true,
          socialOrder: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    // Featured works (ME-16). The pictures are file keys, which an export
    // never carries (rule 3), so `media` is left out; the count says how
    // many there were.
    key: 'profileWorks',
    models: ['ProfileWork'],
    load: async (prisma, me) => {
      const rows = await prisma.profileWork.findMany({
        where: { wawuUserId: me },
        select: {
          title: true,
          role: true,
          client: true,
          year: true,
          link: true,
          category: true,
          description: true,
          media: true,
          position: true,
          createdAt: true,
        },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      return rows.map(({ media, ...work }) => ({
        ...work,
        mediaCount: media.length,
      }));
    },
  },
  {
    key: 'profileEducation',
    models: ['ProfileEducation'],
    load: (prisma, me) =>
      prisma.profileEducation.findMany({
        where: { wawuUserId: me },
        select: {
          school: true,
          field: true,
          startYear: true,
          endYear: true,
          createdAt: true,
        },
        orderBy: [{ startYear: 'desc' }, { id: 'asc' }],
      }),
  },
  {
    key: 'likes',
    models: ['ContentLike'],
    load: (prisma, me) =>
      prisma.contentLike.findMany({
        where: { userWawuId: me },
        select: { contentId: true, likedAt: true },
        orderBy: { likedAt: 'desc' },
      }),
  },
  {
    key: 'piecesViewed',
    models: ['ContentView'],
    load: (prisma, me) =>
      prisma.contentView.findMany({
        where: { viewerWawuId: me },
        select: { contentId: true, viewedOn: true, viewedAt: true },
        orderBy: { viewedAt: 'desc' },
      }),
  },
  {
    key: 'contentRatingsGiven',
    models: ['ContentRating'],
    load: (prisma, me) =>
      prisma.contentRating.findMany({
        where: { userWawuId: me },
        select: {
          contentId: true,
          stars: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
      }),
  },
  {
    key: 'piecesShared',
    models: ['ContentShare'],
    load: (prisma, me) =>
      prisma.contentShare.findMany({
        where: { sharerWawuId: me },
        select: { contentId: true, sharedOn: true, sharedAt: true },
        orderBy: { sharedAt: 'desc' },
      }),
  },
  {
    key: 'tgifReactions',
    models: ['TgifReaction'],
    load: (prisma, me) =>
      prisma.tgifReaction.findMany({
        where: { userWawuId: me },
        select: { day: true, card: true, kind: true, createdAt: true },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'tgifReads',
    models: ['TgifRead'],
    load: (prisma, me) =>
      prisma.tgifRead.findMany({
        where: { userWawuId: me },
        select: { day: true, createdAt: true },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'tgifShares',
    models: ['TgifShare'],
    load: (prisma, me) =>
      prisma.tgifShare.findMany({
        where: { userWawuId: me },
        select: { day: true, createdAt: true },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'creatorSettings',
    models: ['CreatorState'],
    load: (prisma, me) =>
      prisma.creatorState.findUnique({
        where: { wawuUserId: me },
        select: { dmEnabled: true, dmPrice: true, dmResponseHours: true },
      }),
  },
  {
    key: 'privacySettings',
    models: ['PrivacySettings'],
    load: (prisma, me) =>
      prisma.privacySettings.findUnique({
        where: { userWawuId: me },
        select: {
          showPurchases: true,
          showSavedItems: true,
          showFollowing: true,
          showInMemberLists: true,
        },
      }),
  },
  {
    key: 'tgifPreference',
    models: ['TgifPreference'],
    load: (prisma, me) =>
      prisma.tgifPreference.findUnique({
        where: { userWawuId: me },
        select: { show: true, updatedAt: true },
      }),
  },
  {
    // POINTS-03: the person's "Use wallet" choice for points (PT3).
    key: 'pointsSettings',
    models: ['PointsSetting'],
    load: (prisma, me) =>
      prisma.pointsSetting.findUnique({
        where: { wawuUserId: me },
        select: { useWallet: true, updatedAt: true },
      }),
  },
  {
    // AITOOLS-01: the AI tool jobs the person ran (no text is kept).
    key: 'aiToolJobs',
    models: ['AiToolJob'],
    load: (prisma, me) =>
      prisma.aiToolJob.findMany({
        where: { wawuUserId: me },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          tool: true,
          state: true,
          characters: true,
          units: true,
          costPoints: true,
          // AITOOLS-07: when the person saved the result to their library.
          savedAt: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
  },
  {
    // VOICE-01: how the person's name is said, their Voice Intro script, the
    // consent they gave and when they recorded the sample. The recording and
    // the audio are files, not rows, and stay out like every other file.
    // AITOOLS-07: the separate agreement for VoiceOver in their own voice
    // (when, and the exact words they agreed to) goes in beside it.
    key: 'voiceProfile',
    models: ['VoiceProfile', 'VoiceNamePreview'],
    load: (prisma, me) =>
      prisma.voiceProfile.findUnique({
        where: { wawuUserId: me },
        select: {
          namePhonetic: true,
          nameSavedAt: true,
          introText: true,
          introTextAt: true,
          consentAt: true,
          consentLine: true,
          ownVoiceConsentAt: true,
          ownVoiceConsentLine: true,
          sampleAt: true,
          audioAt: true,
        },
      }),
  },
  {
    // FLIX-01: that the person agreed to the terms that name the movie partner
    // (and when and how), and when they first and last opened the partner's
    // site from the app. Never a link: none is stored.
    key: 'moviePartner',
    models: ['MoviePartnerConsent', 'MoviePartnerLink'],
    load: async (prisma, me) => ({
      consents: await prisma.moviePartnerConsent.findMany({
        where: { wawuUserId: me },
        select: { provider: true, agreedAt: true, how: true },
      }),
      links: await prisma.moviePartnerLink.findMany({
        where: { wawuUserId: me },
        select: {
          provider: true,
          firstLinkAt: true,
          lastLinkAt: true,
          linkCount: true,
        },
      }),
    }),
  },
  {
    key: 'voiceIntroRuns',
    models: ['VoiceIntroRun'],
    load: (prisma, me) =>
      prisma.voiceIntroRun.findMany({
        where: { wawuUserId: me },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          state: true,
          characters: true,
          costPoints: true,
          includedUsed: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
  },
  {
    key: 'notificationSettings',
    models: ['NotificationSettings'],
    load: (prisma, me) =>
      prisma.notificationSettings.findUnique({
        where: { userWawuId: me },
        select: {
          newReplies: true,
          newFollowers: true,
          dmReminders: true,
          refunds: true,
          promotions: true,
          communityDigest: true,
          moneyIn: true,
          contentReviews: true,
          communityMessages: true,
        },
      }),
  },
  {
    key: 'recentSearches',
    models: ['SearchHistory'],
    load: (prisma, me) =>
      prisma.searchHistory.findMany({
        where: { userWawuId: me },
        select: { query: true, searchedAt: true },
        orderBy: { searchedAt: 'desc' },
      }),
  },
  {
    key: 'blockedAccounts',
    models: ['BlockedAccount'],
    load: (prisma, me) =>
      prisma.blockedAccount.findMany({
        where: { userWawuId: me },
        select: { blockedWawuId: true, blockedAt: true },
        orderBy: { blockedAt: 'desc' },
      }),
  },
  {
    key: 'following',
    models: ['FollowRelationship'],
    load: (prisma, me) =>
      prisma.followRelationship.findMany({
        where: { followerWawuId: me },
        select: { followingWawuId: true, createdAt: true },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'content',
    models: ['ContentPiece'],
    load: (prisma, me) =>
      prisma.contentPiece.findMany({
        where: { creatorWawuId: me, status: { not: 'removed' } },
        select: {
          id: true,
          title: true,
          description: true,
          contentType: true,
          category: true,
          tags: true,
          accessType: true,
          price: true,
          status: true,
          views: true,
          likes: true,
          commentCount: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'comments',
    models: ['Comment'],
    load: (prisma, me) =>
      prisma.comment.findMany({
        where: { authorWawuId: me },
        select: {
          id: true,
          contentId: true,
          text: true,
          replyToId: true,
          likes: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'commentLikes',
    models: ['CommentLike'],
    load: (prisma, me) =>
      prisma.commentLike.findMany({
        where: { userWawuId: me },
        select: { commentId: true, likedAt: true },
        orderBy: { likedAt: 'desc' },
      }),
  },
  {
    key: 'savedContent',
    models: ['SavedItem'],
    load: (prisma, me) =>
      prisma.savedItem.findMany({
        where: { userWawuId: me },
        select: { contentId: true, savedAt: true },
        orderBy: { savedAt: 'desc' },
      }),
  },
  {
    key: 'savedProducts',
    models: ['MarketplaceSave'],
    load: (prisma, me) =>
      prisma.marketplaceSave.findMany({
        where: { userWawuId: me },
        select: { productId: true, shop: true, savedAt: true },
        orderBy: { savedAt: 'desc' },
      }),
  },
  {
    key: 'savedEvents',
    models: ['EventSave'],
    load: (prisma, me) =>
      prisma.eventSave.findMany({
        where: { userWawuId: me },
        select: { eventId: true, savedAt: true },
        orderBy: { savedAt: 'desc' },
      }),
  },
  {
    // SCHOOLS-10: the school sites this person opened from "Apply on their
    // site" (SC9): which school and course, and when.
    key: 'schoolLinkClicks',
    models: ['SchoolLinkClick'],
    load: (prisma, me) =>
      prisma.schoolLinkClick.findMany({
        where: { userWawuId: me },
        select: { schoolId: true, courseId: true, clickedAt: true },
        orderBy: { clickedAt: 'desc' },
      }),
  },
  {
    // SCHOOLS-07: the places this person held or paid for in a school's
    // classes (SC4 to SC7): the course, school and class as they were, the
    // fee, and the reference on the receipt.
    key: 'schoolEnrolments',
    models: ['SchoolEnrolment'],
    load: (prisma, me) =>
      prisma.schoolEnrolment.findMany({
        where: { wawuUserId: me },
        select: {
          reference: true,
          status: true,
          courseTitle: true,
          schoolName: true,
          intakeStartDate: true,
          intakeSchedule: true,
          intakeLocation: true,
          priceKobo: true,
          createdAt: true,
          enrolledAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
  },
  {
    // ME-10: the creators this person saved (M30).
    key: 'savedCreators',
    models: ['SavedCreator'],
    load: (prisma, me) =>
      prisma.savedCreator.findMany({
        where: { userWawuId: me },
        select: { creatorWawuId: true, savedAt: true },
        orderBy: { savedAt: 'desc' },
      }),
  },
  {
    // FIX-107: the school courses this person saved (SC3's bookmark).
    key: 'savedSchoolCourses',
    models: ['SavedSchoolCourse'],
    load: (prisma, me) =>
      prisma.savedSchoolCourse.findMany({
        where: { userWawuId: me },
        select: { courseId: true, savedAt: true },
        orderBy: { savedAt: 'desc' },
      }),
  },
  {
    // ME-10: the course lessons this person marked finished (M29).
    key: 'lessonsFinished',
    models: ['CourseLessonProgress'],
    load: (prisma, me) =>
      prisma.courseLessonProgress.findMany({
        where: { userWawuId: me },
        select: { contentId: true, lessonId: true, doneAt: true },
        orderBy: { doneAt: 'desc' },
      }),
  },
  {
    key: 'eventsGoing',
    models: ['EventGoing'],
    load: (prisma, me) =>
      prisma.eventGoing.findMany({
        where: { userWawuId: me },
        select: { eventId: true, markedAt: true },
        orderBy: { markedAt: 'desc' },
      }),
  },
  {
    key: 'eventsHosted',
    models: ['Event'],
    load: (prisma, me) =>
      prisma.event.findMany({
        where: { hostWawuId: me },
        select: {
          id: true,
          name: true,
          description: true,
          format: true,
          type: true,
          category: true,
          startsAt: true,
          endsAt: true,
          location: true,
          status: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'communitiesHosted',
    models: ['Community'],
    load: (prisma, me) =>
      prisma.community.findMany({
        where: { hostWawuId: me },
        select: { id: true, name: true, description: true, kind: true },
      }),
  },
  {
    key: 'communityMemberships',
    models: ['CommunityMembership'],
    load: (prisma, me) =>
      prisma.communityMembership.findMany({
        where: { userWawuId: me },
        select: {
          communityId: true,
          status: true,
          requestedAt: true,
          joinedAt: true,
        },
        orderBy: { requestedAt: 'desc' },
      }),
  },
  {
    key: 'communityMessages',
    models: ['CommunityMessage'],
    load: (prisma, me) =>
      prisma.communityMessage.findMany({
        where: { senderWawuId: me },
        select: {
          id: true,
          communityId: true,
          text: true,
          costInCredits: true,
          sentAt: true,
        },
        orderBy: { sentAt: 'desc' },
      }),
  },
  {
    key: 'chatMessagesSent',
    models: ['ChatMessage'],
    load: (prisma, me) =>
      prisma.chatMessage.findMany({
        where: { senderWawuId: me },
        select: {
          id: true,
          conversationId: true,
          kind: true,
          text: true,
          attachmentName: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'paidMessagesSent',
    models: ['DirectMessage'],
    // What the requester wrote and paid for. The creator's answer is that
    // creator's writing, so `responseText` is not selected, and neither is
    // the payment-provider reference.
    load: (prisma, me) =>
      prisma.directMessage.findMany({
        where: { senderWawuId: me },
        select: {
          id: true,
          creatorWawuId: true,
          text: true,
          amount: true,
          status: true,
          sentAt: true,
          respondedAt: true,
          refundStatus: true,
          refundedAt: true,
        },
        orderBy: { sentAt: 'desc' },
      }),
  },
  {
    key: 'paidQuestionDrafts',
    models: ['PaidDmDraft'],
    // The words of a paid question the requester wrote and has not paid for
    // (INBOX-17): their own writing, kept until paid or removed after a
    // fortnight. The idempotency key of the request that made it is a
    // technical mark and is not selected.
    load: (prisma, me) =>
      prisma.paidDmDraft.findMany({
        where: { senderWawuId: me },
        select: {
          id: true,
          creatorWawuId: true,
          text: true,
          responseWindowHours: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'paidMessageRepliesWritten',
    models: ['DmReply'],
    load: (prisma, me) =>
      prisma.dmReply.findMany({
        where: { creatorWawuId: me },
        select: { id: true, messageId: true, text: true, createdAt: true },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'professionalRatingsGiven',
    models: ['ProfessionalReview'],
    load: (prisma, me) =>
      prisma.professionalReview.findMany({
        where: { authorWawuId: me },
        select: {
          id: true,
          professionalId: true,
          stars: true,
          body: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'notifications',
    models: ['Notification'],
    load: (prisma, me) =>
      prisma.notification.findMany({
        where: { userWawuId: me },
        select: {
          id: true,
          kind: true,
          title: true,
          body: true,
          amount: true,
          creditsCount: true,
          read: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'purchases',
    models: ['Purchase'],
    // As the BUYER. What a creator earned from somebody is that buyer's
    // record too, so the creator side is not here.
    load: (prisma, me) =>
      prisma.purchase.findMany({
        where: { buyerWawuId: me },
        select: {
          id: true,
          contentId: true,
          type: true,
          creatorWawuId: true,
          amount: true,
          status: true,
          note: true,
          purchasedAt: true,
        },
        orderBy: { purchasedAt: 'desc' },
      }),
  },
  {
    key: 'creditPurchases',
    models: ['CreditPurchase'],
    load: (prisma, me) =>
      prisma.creditPurchase.findMany({
        where: { userWawuId: me },
        select: {
          id: true,
          pack: true,
          creditsGranted: true,
          amount: true,
          status: true,
          purchasedAt: true,
        },
        orderBy: { purchasedAt: 'desc' },
      }),
  },
  {
    key: 'creditsSpent',
    models: ['CreditSpend'],
    load: (prisma, me) =>
      prisma.creditSpend.findMany({
        where: { userWawuId: me },
        select: {
          id: true,
          communityId: true,
          creditsSpent: true,
          spentAt: true,
        },
        orderBy: { spentAt: 'desc' },
      }),
  },
  {
    key: 'tickPurchases',
    models: ['VerificationPurchase'],
    load: (prisma, me) =>
      prisma.verificationPurchase.findMany({
        where: { wawuUserId: me },
        select: {
          id: true,
          kind: true,
          priceNgn: true,
          status: true,
          grantedUntil: true,
          createdAt: true,
          settledAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  // The maker plan (TIER-01): the person's billing currency, the tier they
  // hold and the event passes their tiers issued. The purchase reference is
  // a payment reference, so it stays out (rule 3).
  {
    key: 'billingCurrency',
    models: ['PersonBilling'],
    load: (prisma, me) =>
      prisma.personBilling.findUnique({
        where: { wawuUserId: me },
        select: { currency: true, fixedBy: true, fixedAt: true },
      }),
  },
  {
    key: 'makerTier',
    models: ['MakerTier'],
    load: (prisma, me) =>
      prisma.makerTier.findUnique({
        where: { wawuUserId: me },
        select: {
          tierId: true,
          activeFrom: true,
          activeUntil: true,
          productsIncluded: true,
          extraProducts: true,
          pointsIncluded: true,
          voiceIntroIncluded: true,
          badgeNumber: true,
        },
      }),
  },
  // What this person bought of the maker plan from their wallet (TIER-03).
  // The payment reference is a payment id, so it stays out (rule 3).
  {
    key: 'tierPurchases',
    models: ['MakerPurchase'],
    load: (prisma, me) =>
      prisma.makerPurchase.findMany({
        where: { wawuUserId: me },
        select: {
          kind: true,
          tierId: true,
          fromTierId: true,
          bump: true,
          currency: true,
          amountMinor: true,
          method: true,
          status: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  // The products this person added to their tier (TIER-04). The payment
  // reference is a payment id, so it stays out (rule 3).
  {
    key: 'extraProductsPurchases',
    models: ['MakerExtraProducts'],
    load: (prisma, me) =>
      prisma.makerExtraProducts.findMany({
        where: { wawuUserId: me },
        select: {
          tierId: true,
          products: true,
          currency: true,
          amountMinor: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  // What this person chose to pay for by bank transfer (TIER-05) and where it
  // stands. The payment that paid it is a payment id, so it stays out (rule 3).
  {
    key: 'tierTransferPurchases',
    models: ['PlanTransferOrder'],
    load: (prisma, me) =>
      prisma.planTransferOrder.findMany({
        where: { wawuUserId: me },
        select: {
          // The kind and the goods the quote promised (a tier, or a points
          // pack's points and bonus), so a pack order says what it was.
          paymentKind: true,
          targetId: true,
          terms: true,
          priceKobo: true,
          providerFeeKobo: true,
          totalKobo: true,
          status: true,
          statusMessage: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'eventPasses',
    models: ['EventPass'],
    load: (prisma, me) =>
      prisma.eventPass.findMany({
        where: { wawuUserId: me },
        select: { type: true, createdAt: true },
        orderBy: NEWEST,
      }),
  },
  // The products this person was still drafting (TIER-02): what they wrote,
  // no file. The details are the person's own words, so they all go in.
  {
    key: 'productDrafts',
    models: ['ProductDraft'],
    load: (prisma, me) =>
      prisma.productDraft.findMany({
        where: { wawuUserId: me },
        select: {
          title: true,
          contentType: true,
          description: true,
          category: true,
          specializations: true,
          tags: true,
          accessType: true,
          price: true,
          // AITOOLS-07: the AI tool job whose audio the person attached.
          mediaJobId: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  // An event registration this person claimed in the app (JOIN-01): what they
  // told the event page and what they paid. The reference and transaction id
  // are payment-provider references, so they stay out (rule 3).
  {
    key: 'eventRegistrations',
    models: ['WaitlistRegistration'],
    load: (prisma, me) =>
      prisma.waitlistRegistration.findMany({
        where: { claimedByWawuId: me },
        select: {
          offerId: true,
          fullName: true,
          phone: true,
          email: true,
          state: true,
          makes: true,
          craft: true,
          city: true,
          updatesOptIn: true,
          // REF-01: the code they registered with and its community.
          referralCode: true,
          referralCommunity: true,
          consentAt: true,
          status: true,
          amountKobo: true,
          paidKobo: true,
          paidAt: true,
          claimedAt: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'courseEnrollments',
    models: ['CourseEnrollment'],
    load: (prisma, me) =>
      prisma.courseEnrollment.findMany({
        where: { userWawuId: me },
        select: { courseId: true, enrolledAt: true, progressPct: true },
        orderBy: { enrolledAt: 'desc' },
      }),
  },
  {
    key: 'serviceApplications',
    models: ['ServiceApplication'],
    // `documents` holds file keys, which are not exported.
    load: (prisma, me) =>
      prisma.serviceApplication.findMany({
        where: { applicantWawuId: me },
        select: {
          id: true,
          kind: true,
          title: true,
          reference: true,
          appliedDate: true,
          status: true,
          amountPaid: true,
          rejection: true,
        },
        orderBy: { appliedDate: 'desc' },
      }),
  },
  {
    key: 'mentorRequests',
    models: ['MentorRequest'],
    load: (prisma, me) =>
      prisma.mentorRequest.findMany({
        where: { requesterWawuId: me },
        select: {
          id: true,
          mentorId: true,
          topics: true,
          note: true,
          slot: true,
          status: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'professionalListings',
    models: ['ProfessionalProfile'],
    // The licence number and the uploaded documents are identity records and
    // never travel by email.
    load: (prisma, me) =>
      prisma.professionalProfile.findMany({
        where: { wawuUserId: me },
        select: {
          id: true,
          category: true,
          headline: true,
          about: true,
          services: true,
          credentialKind: true,
          status: true,
          listed: true,
          submittedAt: true,
          reviewedAt: true,
        },
        orderBy: { submittedAt: 'desc' },
      }),
  },
  {
    key: 'professionalTakedowns',
    models: ['ProfessionalTakedown'],
    // When an admin took one of the person's listings down and when it was
    // listed again (FIX-06). Which admin did it is not the person's data and
    // is left out.
    load: (prisma, me) =>
      prisma.professionalTakedown.findMany({
        where: { wawuUserId: me },
        select: { professionalId: true, takenDownAt: true, liftedAt: true },
        orderBy: { takenDownAt: 'desc' },
      }),
  },
  {
    key: 'professionalLocation',
    models: ['ProfessionalLocation'],
    // The city the person wrote for their professional card.
    load: (prisma, me) =>
      prisma.professionalLocation.findMany({
        where: { wawuUserId: me },
        select: { city: true, createdAt: true, updatedAt: true },
      }),
  },
  {
    key: 'billPayments',
    models: ['BillPayment'],
    load: (prisma, me) =>
      prisma.billPayment.findMany({
        where: { buyerWawuId: me },
        select: {
          id: true,
          category: true,
          billerName: true,
          amount: true,
          fee: true,
          status: true,
          createdAt: true,
          deliveredAt: true,
          refundedAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'shopOrders',
    models: ['ShopOrder'],
    load: (prisma, me) =>
      prisma.shopOrder.findMany({
        where: { buyerWawuId: me },
        select: {
          id: true,
          status: true,
          subtotalNaira: true,
          totalNaira: true,
          deliveryName: true,
          deliveryPhone: true,
          deliveryAddress: true,
          deliveryCity: true,
          deliveryState: true,
          fulfilment: true,
          createdAt: true,
          paidAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'eventTicketOrders',
    models: ['EventOrder'],
    load: (prisma, me) =>
      prisma.eventOrder.findMany({
        where: { buyerWawuId: me },
        select: {
          id: true,
          eventId: true,
          quantity: true,
          amountNaira: true,
          status: true,
          createdAt: true,
          refundedAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    // POINTS-01: the person's points lots (what they were given, what is
    // left, when each ends), the holds that spent them and every movement.
    // Counts of points only; no provider reference (a lot's or hold's
    // reference is the granting task's own id, not a payment provider's).
    key: 'pointLots',
    models: ['PointLot'],
    load: (prisma, me) =>
      prisma.pointLot.findMany({
        where: { wawuUserId: me },
        select: {
          id: true,
          source: true,
          quantity: true,
          remaining: true,
          expiresAt: true,
          lapsedAt: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    key: 'pointHolds',
    models: ['PointHold'],
    load: (prisma, me) =>
      prisma.pointHold.findMany({
        where: { wawuUserId: me },
        select: {
          id: true,
          purpose: true,
          title: true,
          quantity: true,
          state: true,
          createdAt: true,
          settledAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  {
    // REF-02: the person's own referral code, and the code they used. Only
    // their own code and the day they used someone's: no one else's name.
    key: 'referralCode',
    models: ['PersonReferralCode', 'PersonReferral'],
    load: async (prisma, me) => {
      const [mine, used] = await Promise.all([
        prisma.personReferralCode.findUnique({
          where: { wawuUserId: me },
          select: { code: true, createdAt: true },
        }),
        prisma.personReferral.findUnique({
          where: { referredWawuUserId: me },
          select: { code: true, claimedAt: true },
        }),
      ]);
      return { mine, used };
    },
  },
  {
    // REF-02: the points each person they invited earned them, and the
    // milestones. Points and dates only; the invited person is not named.
    key: 'referralRewards',
    models: ['ReferralReward', 'ReferralMilestone'],
    load: async (prisma, me) => {
      const [rewards, milestones] = await Promise.all([
        prisma.referralReward.findMany({
          where: { referrerWawuUserId: me },
          select: {
            id: true,
            tierId: true,
            basePoints: true,
            multiplierMilli: true,
            points: true,
            state: true,
            availableAt: true,
            createdAt: true,
            settledAt: true,
          },
          orderBy: NEWEST,
        }),
        prisma.referralMilestone.findMany({
          where: { referrerWawuUserId: me },
          select: { count: true, points: true, grantedAt: true },
          orderBy: { count: 'asc' },
        }),
      ]);
      return { rewards, milestones };
    },
  },
  {
    // POINTS-04: each time the person turned points into cash, in kobo: how
    // many points, how much cash, how it ended. No account number and no
    // provider reference.
    key: 'pointConversions',
    models: ['PointConversion'],
    load: async (prisma, me) => {
      const rows = await prisma.pointConversion.findMany({
        where: { wawuUserId: me },
        select: {
          id: true,
          points: true,
          cashKobo: true,
          status: true,
          failureReason: true,
          createdAt: true,
          settledAt: true,
        },
        orderBy: NEWEST,
      });
      // A file carries numbers, not BigInt: kobo as a whole number.
      return rows.map((r) => ({ ...r, cashKobo: Number(r.cashKobo) }));
    },
  },
  {
    key: 'pointMovements',
    models: ['PointLedger'],
    load: (prisma, me) =>
      prisma.pointLedger.findMany({
        where: { wawuUserId: me },
        select: {
          id: true,
          lotId: true,
          holdId: true,
          delta: true,
          reason: true,
          at: true,
        },
        orderBy: { seq: 'desc' },
      }),
  },
  {
    key: 'exportRequests',
    models: ['DataExportRequest'],
    load: (prisma, me) =>
      prisma.dataExportRequest.findMany({
        where: { userWawuId: me },
        select: { id: true, status: true, requestedAt: true },
        orderBy: { requestedAt: 'desc' },
      }),
  },
  // The person's own foreign-currency accounts (WALLET-21, R-83, R-84): which
  // currencies they opened, on which chain, and whether an admin froze one.
  // The provider's ids, routing numbers and the freeze reason are not theirs
  // to read (rule 3); the balance is the provider's and is not exported.
  {
    key: 'foreignAccounts',
    models: ['FxAccount'],
    load: (prisma, me) =>
      prisma.fxAccount.findMany({
        where: { wawuUserId: me },
        select: {
          currency: true,
          chain: true,
          status: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      }),
  },
  // The rates this person asked for when they went to swap (WALLET-21).
  {
    key: 'foreignQuotes',
    models: ['FxQuote'],
    load: async (prisma, me) => {
      const rows = await prisma.fxQuote.findMany({
        where: { wawuUserId: me },
        select: {
          fromCurrency: true,
          toCurrency: true,
          amountFromMinor: true,
          amountToMinor: true,
          rate: true,
          wawuFeeMinor: true,
          expiresAt: true,
          usedAt: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      });
      return rows.map((r) => ({
        ...r,
        amountFromMinor: Number(r.amountFromMinor),
        amountToMinor: Number(r.amountToMinor),
        wawuFeeMinor: Number(r.wawuFeeMinor),
      }));
    },
  },
  // Their swaps and crypto sends (WALLET-21). The provider's transfer id and
  // our reference stay out (rule 3), and an outside wallet address is another
  // party's: only its last six characters are given, enough to recognise it.
  {
    key: 'foreignSwapsAndSends',
    models: ['FxOperation'],
    load: async (prisma, me) => {
      const rows = await prisma.fxOperation.findMany({
        where: { wawuUserId: me },
        select: {
          kind: true,
          status: true,
          fromCurrency: true,
          toCurrency: true,
          amountFromMinor: true,
          amountToMinor: true,
          rate: true,
          providerFeeMinor: true,
          wawuFeeMinor: true,
          chain: true,
          address: true,
          failureReason: true,
          createdAt: true,
          completedAt: true,
        },
        orderBy: NEWEST,
      });
      return rows.map(({ address, ...r }) => ({
        ...r,
        amountFromMinor: Number(r.amountFromMinor),
        amountToMinor:
          r.amountToMinor === null ? null : Number(r.amountToMinor),
        providerFeeMinor:
          r.providerFeeMinor === null ? null : Number(r.providerFeeMinor),
        wawuFeeMinor: Number(r.wawuFeeMinor),
        addressEnd: address ? address.slice(-6) : null,
      }));
    },
  },
  // What moved on those accounts, as the provider told us (WALLET-21). The
  // provider's transfer id and reference stay out (rule 3).
  {
    key: 'foreignMovements',
    models: ['FxMovement'],
    load: async (prisma, me) => {
      const rows = await prisma.fxMovement.findMany({
        where: { wawuUserId: me },
        select: {
          currency: true,
          direction: true,
          status: true,
          amountMinor: true,
          feeMinor: true,
          paymentType: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'desc' as const },
      });
      return rows.map((r) => ({
        ...r,
        amountMinor: Number(r.amountMinor),
        feeMinor: Number(r.feeMinor),
      }));
    },
  },
  // Their Capital orders (NUV-12, R-84): what they bought and where it stands.
  // The provider's order, account and transfer ids, our idempotency material,
  // the stored product snapshot and an admin's freeze reason stay out (rule 3).
  {
    key: 'capitalOrders',
    models: ['CapitalOrder'],
    load: async (prisma, me) => {
      const rows = await prisma.capitalOrder.findMany({
        where: { wawuUserId: me },
        select: {
          productName: true,
          productType: true,
          currency: true,
          amountMinor: true,
          totalDebitMinor: true,
          feeKobo: true,
          state: true,
          lifecycle: true,
          payoutStatus: true,
          expiresAt: true,
          confirmedAt: true,
          withdrawRequestedAt: true,
          frozenAt: true,
          cancelledAt: true,
          createdAt: true,
        },
        orderBy: NEWEST,
      });
      return rows.map((r) => ({
        ...r,
        amountMinor: Number(r.amountMinor),
        totalDebitMinor:
          r.totalDebitMinor === null ? null : Number(r.totalDebitMinor),
        feeKobo: Number(r.feeKobo),
      }));
    },
  },
];

/**
 * Models the account purge treats as the account's own that the export
 * deliberately leaves out, each with the reason. Reading this list is how the
 * owner sees what an export does not hold. Default (agent), owner may
 * override: nothing here is a legal ruling.
 */
export const EXPORT_EXCLUDED: ReadonlyArray<{ model: string; reason: string }> =
  [
    // Editorial placement, not the person's own content (EXPLORE-03).
    {
      model: 'FeaturedCreator',
      reason:
        'An admin choice to show the creator in Explore, with the admin id; the person wrote none of it.',
    },
    // Secrets and identity records: never in an email.
    {
      model: 'EventDoorStaff',
      reason: 'A door role the organiser gave, not data the person gave.',
    },
    {
      model: 'EventDoorScan',
      reason:
        'The first answer to one scan at a door, kept a day or two so a repeat is answered the same; it holds the ticket holder name, which is not the scanner own data.',
    },
    {
      model: 'PushToken',
      reason:
        'A phone push token is a working address for that phone, not content: a file that carries it hands the address to whoever opens the file.',
    },
    {
      model: 'PushDelivery',
      reason:
        'A send log: every notification it names is already in the Notifications section.',
    },
    {
      model: 'TgifDailyNotice',
      reason:
        'A marker that the TGIF notice of a day was made, kept a few days: the notice itself is in the Notifications section.',
    },
    {
      model: 'PushStoppedAccount',
      reason:
        'A switch the server keeps after the person asked to delete the account: it holds nothing but the time of that request.',
    },
    {
      model: 'AccountDeletionContent',
      reason:
        'Bookkeeping for a deletion that is waiting: the ids of the pieces it hid and the status each had. The pieces themselves are exported in their own section.',
    },
    { model: 'TransactionPin', reason: 'A PIN hash is a secret.' },
    { model: 'TransactionPinReset', reason: 'A reset code hash is a secret.' },
    { model: 'ApprovalDevice', reason: 'A device key is a secret.' },
    { model: 'ApprovalChallenge', reason: 'A one-time challenge is a secret.' },
    {
      model: 'WalletIdentity',
      reason: 'Keyed BVN and NIN hashes are identity records.',
    },
    { model: 'BvnCheckAttempt', reason: 'Identity check record.' },
    { model: 'SelfieMatchAttempt', reason: 'Identity check record.' },
    {
      model: 'FintavaWalletOpening',
      reason: 'Identity hashes and a phone proof.',
    },
    {
      model: 'KycSubmission',
      reason: 'Identity documents never travel by email.',
    },
    {
      model: 'VerificationSubmission',
      reason: 'Identity documents never travel by email.',
    },
    {
      model: 'StorageObject',
      reason: 'File keys and signed links are not exported.',
    },
    // Money records: statements are their own after-launch task, and the
    // wallet's balance is Fintava's, never ours.
    {
      model: 'FintavaWallet',
      reason: 'A pointer to the account at Fintava, which holds the balance.',
    },
    // NUV-01. NuvionWebhookEvent, the other table NUV-01 adds, has no
    // person column (like FintavaWebhookEvent): it is Nuvion's record of
    // events, not the person's, so neither the purge map nor this list
    // names it.
    // FIX-20. Both webhook tables keep a delivery's raw body and parsed
    // copy, so they are not kept for ever: RETENTION covers them, not the
    // export or the purge. A daily job (src/webhook-retention/) clears the
    // body and the parsed copy after WEBHOOK_RETENTION_DAYS (90 by default)
    // once a delivery is finished with (docs/contract/CONVENTIONS.md section
    // 21). What a person is owed of their money history is the ledger
    // (FintavaLedgerEntry below), which this list covers.
    // NUV-05. NuvionBookTransfer, the log of book transfers sent on Nuvion,
    // has no person column either: it holds account ids, an account number,
    // an amount and WAWU's reference, and the person's own transfers reach
    // them through their wallet history, so this list does not name it.
    {
      model: 'NuvionEntity',
      reason:
        'A pointer to the person at Nuvion (entity, account and review state), which holds the balance and the identity documents.',
    },
    {
      model: 'NuvionDocument',
      reason:
        'A record that an ID document or proof of address was sent to Nuvion (kind, state, Nuvion id, whether its review refused it, and a keyed fingerprint of the bytes that is cleared once the opening is sent). WAWU keeps no copy of the file: Nuvion holds the document. Identity documents never travel by email.',
    },
    {
      model: 'NuvionOnboarding',
      reason:
        "A record that the opening was sent to Nuvion for review and of the hosted selfie session (ids and one status word). The selfie itself is Nuvion's, never held here.",
    },
    {
      model: 'FintavaLedgerEntry',
      reason:
        'Wallet transactions carry the other side bank details. Statements are an after-launch task (BACKEND_GAPS G-130).',
    },
    {
      model: 'CreatorWallet',
      reason: 'Web wallet pointer; statements are after launch (G-130).',
    },
    {
      model: 'WalletWithdrawal',
      reason:
        'Holds a bank account number; statements are after launch (G-130).',
    },
    {
      model: 'WalletLedgerEntry',
      reason: 'Web wallet ledger; statements are after launch (G-130).',
    },
    {
      model: 'MoneyBeneficiary',
      reason: 'Other people bank details.',
    },
    { model: 'MoneyPayoutAccount', reason: 'A bank account number.' },
    {
      model: 'MoneyIdempotencyKey',
      reason:
        'The stored answer to one money request, kept a day or two so a repeat is answered the same; it holds the response and account numbers, and wallet transactions are not exported (G-130).',
    },
    {
      model: 'MoneyReceipt',
      reason:
        'A receipt code for one wallet transaction; it holds the account number, and wallet transactions are not exported (G-130).',
    },
    {
      model: 'PendingCharge',
      reason: 'An internal payment attempt, not a record.',
    },
    {
      model: 'CreditLot',
      reason:
        'Internal accounting of credit expiry; purchases and spends are exported.',
    },
    {
      model: 'CreditsState',
      reason: 'A stored counter; the balance is shown in the app.',
    },
    // Other people's behaviour, or internal measures.
    {
      model: 'ProfileView',
      reason:
        'Who looked at a profile is those people browsing, not this account data.',
    },
    {
      model: 'AdEvent',
      reason:
        'Which sponsored cards were opened, tapped or skipped on which day: an advertising count kept so each is counted once a day, not something the person made (BACKEND_GAPS G-199).',
    },
    {
      model: 'DmReport',
      reason: 'A report about somebody else is a moderation record.',
    },
    { model: 'ChatParticipant', reason: 'A read position, not content.' },
    { model: 'CommunityReadMarker', reason: 'A read position, not content.' },
    {
      model: 'CommunityMessageNotice',
      reason:
        'The count behind a notice; the notice itself is exported with the notifications.',
    },
    {
      model: 'CommunityPass',
      reason:
        'A pass is 30 days of a room, paid from the wallet; what was paid is exported with the payments, and the end date is on the membership.',
    },
    {
      model: 'CommunityMessageKey',
      reason:
        'The key one community message was sent under, so a repeat is not stored twice; the message itself is exported under communityMessages.',
    },
    {
      model: 'DmReplyKey',
      reason:
        'The key one paid-question reply was sent under, so a repeat is not stored twice; the reply itself is exported under paidMessageRepliesWritten.',
    },
    { model: 'CartItem', reason: 'A transient basket, not a record.' },
    {
      model: 'EventReferral',
      reason: 'A referral code, not a record of anything done.',
    },
    { model: 'EvgScore', reason: 'Derived score, not data the person gave.' },
    {
      model: 'CreatorNoResponseTracker',
      reason: 'Internal response measure.',
    },
    {
      model: 'DittoOptIn',
      reason: 'A partner opt-in flag, held by the partner.',
    },
    // Sensitive and possibly privileged: the owner decides.
    {
      model: 'HealthSubscription',
      reason:
        'Health records are sensitive; whether they are emailed is the owner call.',
    },
    {
      model: 'LegalRequest',
      reason:
        'Legal matters may be privileged; whether they are emailed is the owner call.',
    },
    {
      model: 'LegalDeliverable',
      reason:
        'The documents delivered on a legal matter; legal matters may be privileged, so whether they are emailed is the owner call.',
    },
    {
      model: 'LegalIntake',
      reason:
        'Legal matters may be privileged; whether they are emailed is the owner call.',
    },
    {
      model: 'LegalIntakeMessage',
      reason:
        'Legal matters may be privileged; whether they are emailed is the owner call.',
    },
    {
      model: 'LegalAssistantCall',
      reason:
        'A bookkeeping row for the assistant hourly limit (when a paid AI call was made, never what was said); nothing the person wrote.',
    },
    {
      model: 'LegalChatOpenerCall',
      reason:
        'A bookkeeping row for the opener of a legal thread (when its paid AI call was made and how it ended, never what was said); nothing the person wrote.',
    },
  ];
