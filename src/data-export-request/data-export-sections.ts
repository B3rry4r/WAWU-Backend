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
    key: 'exportRequests',
    models: ['DataExportRequest'],
    load: (prisma, me) =>
      prisma.dataExportRequest.findMany({
        where: { userWawuId: me },
        select: { id: true, status: true, requestedAt: true },
        orderBy: { requestedAt: 'desc' },
      }),
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
    {
      model: 'NuvionEntity',
      reason:
        'A pointer to the person at Nuvion (entity, account and review state), which holds the balance and the identity documents.',
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
  ];
