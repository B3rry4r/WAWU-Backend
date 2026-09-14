/**
 * Seed script — realistic test data for the 3 mock WAWU ID users defined in
 * mock-wawu-id/server.js, plus a handful of reference rows across the
 * services/learn/community surfaces so Phase 6+ contract tests and Phase 8's
 * live-gate have real data to exercise against.
 *
 * Idempotent AND restorative: every row is upserted against either a natural
 * unique key (wawuUserId, slug, handle) or a fixed seed UUID, so re-running
 * this never duplicates rows — and every `update` block now carries the same
 * values as its `create`, so re-running also REPAIRS a row that has drifted.
 *
 * That second half was missing. Every upsert used `update: {}`, which means
 * the seed could only ever populate an empty database and could never restore
 * a corrupted one. It matters because the contract suite mutates the seeded
 * accounts and restores them inline: a spec that fails partway skips its own
 * restore, and the damage then persists into every later run with no way back
 * short of dropping the database. One such failure had left USER_PLAIN with a
 * null handle, which then failed an unrelated user-profile assertion on every
 * subsequent run.
 *
 * Distinctive "SEEDED: ..." values are planted on ContentPiece, Community,
 * PartnerService, Mentor, LearnCourse and LearnGuide per the task brief, so
 * Phase 8's live-gate can prove real server data is rendering (not local
 * mock data).
 *
 * Run: `npx prisma db seed` (wired via prisma.config.ts `migrations.seed`).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  AccountType,
  AccessType,
  CommunityKind,
  ContentStatus,
  ContentType,
  CreatorTier,
  DmStatus,
  GuideKind,
  MembershipStatus,
  PartnerServiceStatus,
  PurchaseType,
  ReviewStatus,
  SubscriptionStatus,
  TransactionStatus,
} from '../generated/prisma/enums';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// -----------------------------------------------------------------------------
// Mirrors mock-wawu-id/server.js's USERS map exactly — same `sub` values.
// -----------------------------------------------------------------------------
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // Adaeze Okonkwo — plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Chidi Umeh — Basic tier, KYC pending
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Zainab Bello — Pro tier, KYC approved

// Fixed seed UUIDs for tables without a natural unique key relevant here —
// keeps this script idempotent across re-runs via upsert-by-id.
const CONTENT_CAC_COURSE = '10000000-0000-4000-8000-000000000001';
const CONTENT_MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002';
const CONTENT_PDF_TEMPLATE = '10000000-0000-4000-8000-000000000003';
const LESSON_CAC_1 = '11000000-0000-4000-8000-000000000001';
const LESSON_CAC_2 = '11000000-0000-4000-8000-000000000002';
const COMMENT_ON_MAKEUP = '12000000-0000-4000-8000-000000000001';
const COMMUNITY_FOUNDERS = '20000000-0000-4000-8000-000000000001';
const MEMBERSHIP_PLAIN_IN_FOUNDERS = '21000000-0000-4000-8000-000000000001';
const MESSAGE_FOUNDERS_1 = '22000000-0000-4000-8000-000000000001';
const MESSAGE_FOUNDERS_2 = '22000000-0000-4000-8000-000000000002';
const PARTNER_SERVICE_CAC = '30000000-0000-4000-8000-000000000001';
const PARTNER_SERVICE_NEPC = '30000000-0000-4000-8000-000000000002';
const PARTNER_SERVICE_TRADEMARK = '30000000-0000-4000-8000-000000000003';
const MENTOR_AMARA = '40000000-0000-4000-8000-000000000001';
const MENTOR_TUNDE = '40000000-0000-4000-8000-000000000002';
const LEARN_COURSE_EXPORT = '50000000-0000-4000-8000-000000000001';
const LEARN_COURSE_SOCIAL = '50000000-0000-4000-8000-000000000002';
const LEARN_GUIDE_NIGERIA = '60000000-0000-4000-8000-000000000001';
const LEARN_GUIDE_PRICING = '60000000-0000-4000-8000-000000000002';
const PLAYBOOK_MAIN = '70000000-0000-4000-8000-000000000001';
const COURSE_ENROLLMENT_PLAIN_EXPORT = '51000000-0000-4000-8000-000000000001';
const PURCHASE_PLAIN_BUYS_CAC_COURSE = '80000000-0000-4000-8000-000000000001';
const DM_PLAIN_TO_PRO = '90000000-0000-4000-8000-000000000001';
const NOTIFICATION_SALE_FOR_PRO = 'a0000000-0000-4000-8000-000000000001';
const NOTIFICATION_FOLLOW_FOR_BASIC = 'a0000000-0000-4000-8000-000000000002';
const MARKETPLACE_SAVE_PLAIN = 'b0000000-0000-4000-8000-000000000001';

/**
 * This seed OVERWRITES existing rows — that is the point of it, and it is why
 * it must never run against a real database. The three accounts it plants are
 * the mock-wawu-id identities, so a production run would also be writing
 * fictional users into live data.
 */
function refuseIfProduction(): void {
  const url = process.env.DATABASE_URL ?? '';
  const isTestDb = /wawu_hub_test|localhost|127\.0\.0\.1/.test(url);
  if (process.env.NODE_ENV === 'production' || !isTestDb) {
    throw new Error(
      `Refusing to seed: this script overwrites rows and is for a local or test database only. DATABASE_URL is ${url ? 'not local' : 'unset'}. Set ALLOW_REMOTE_SEED=1 to override deliberately.`,
    );
  }
}

async function main() {
  if (process.env.ALLOW_REMOTE_SEED !== '1') refuseIfProduction();
  const now = new Date();
  const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // ---------------------------------------------------------------------
  // Identity: UserProfile for all 3 mock WAWU ID users
  // ---------------------------------------------------------------------
  await prisma.userProfile.upsert({
    where: { wawuUserId: USER_PLAIN },
    update: {
      wawuUserId: USER_PLAIN,
      accountType: AccountType.user,
      handle: 'adaeze',
      bio: 'Lover of Ankara prints and good jollof. Here for the beauty tutorials.',
      interests: ['beauty', 'fashion', 'skincare'],
      instagramHandle: '@adaeze.ok',
      whatsappHandle: null,
      websiteUrl: null,
    },
    create: {
      wawuUserId: USER_PLAIN,
      accountType: AccountType.user,
      handle: 'adaeze',
      bio: 'Lover of Ankara prints and good jollof. Here for the beauty tutorials.',
      interests: ['beauty', 'fashion', 'skincare'],
      instagramHandle: '@adaeze.ok',
      whatsappHandle: null,
      websiteUrl: null,
    },
  });

  await prisma.userProfile.upsert({
    where: { wawuUserId: USER_CREATOR_BASIC },
    update: {
      wawuUserId: USER_CREATOR_BASIC,
      accountType: AccountType.creator,
      handle: 'chidi-creates',
      bio: 'Makeup artist and content creator in Lagos. Basic tier, building my slots.',
      interests: ['beauty', 'makeup', 'tutorials'],
      instagramHandle: '@chidi.creates',
      whatsappHandle: '+2348000000002',
      websiteUrl: null,
    },
    create: {
      wawuUserId: USER_CREATOR_BASIC,
      accountType: AccountType.creator,
      handle: 'chidi-creates',
      bio: 'Makeup artist and content creator in Lagos. Basic tier, building my slots.',
      interests: ['beauty', 'makeup', 'tutorials'],
      instagramHandle: '@chidi.creates',
      whatsappHandle: '+2348000000002',
      websiteUrl: null,
    },
  });

  await prisma.userProfile.upsert({
    where: { wawuUserId: USER_CREATOR_PRO },
    update: {
      wawuUserId: USER_CREATOR_PRO,
      accountType: AccountType.creator,
      handle: 'zainab-pro',
      bio: 'Business consultant helping African founders register and export. Pro tier.',
      interests: ['business', 'export', 'mentorship'],
      instagramHandle: '@zainab.bello',
      whatsappHandle: '+2348000000003',
      websiteUrl: 'https://zainabbello.example.com',
    },
    create: {
      wawuUserId: USER_CREATOR_PRO,
      accountType: AccountType.creator,
      handle: 'zainab-pro',
      bio: 'Business consultant helping African founders register and export. Pro tier.',
      interests: ['business', 'export', 'mentorship'],
      instagramHandle: '@zainab.bello',
      whatsappHandle: '+2348000000003',
      websiteUrl: 'https://zainabbello.example.com',
    },
  });

  // ---------------------------------------------------------------------
  // Creator gates: CreatorState (subscriptionPaid gates upload, kycStatus
  // gates earning — the two independent gates per CLAUDE.md)
  // ---------------------------------------------------------------------
  await prisma.creatorState.upsert({
    where: { wawuUserId: USER_CREATOR_BASIC },
    update: {
      wawuUserId: USER_CREATOR_BASIC,
      tier: CreatorTier.basic,
      subscriptionPaid: true,
      kycStatus: ReviewStatus.pending,
      slotsUsed: 1,
      dmPrice: 100,
      dmEnabled: true,
    },
    create: {
      wawuUserId: USER_CREATOR_BASIC,
      tier: CreatorTier.basic,
      subscriptionPaid: true,
      kycStatus: ReviewStatus.pending,
      slotsUsed: 1,
      dmPrice: 100,
      dmEnabled: true,
    },
  });

  await prisma.creatorState.upsert({
    where: { wawuUserId: USER_CREATOR_PRO },
    update: {
      wawuUserId: USER_CREATOR_PRO,
      tier: CreatorTier.pro,
      subscriptionPaid: true,
      kycStatus: ReviewStatus.approved,
      slotsUsed: 2,
      dmPrice: 300,
      dmEnabled: true,
    },
    create: {
      wawuUserId: USER_CREATOR_PRO,
      tier: CreatorTier.pro,
      subscriptionPaid: true,
      kycStatus: ReviewStatus.approved,
      slotsUsed: 2,
      dmPrice: 300,
      dmEnabled: true,
    },
  });

  // ---------------------------------------------------------------------
  // CreatorSubscription — single evolving row per creator
  // ---------------------------------------------------------------------
  await prisma.creatorSubscription.upsert({
    where: { creatorWawuId: USER_CREATOR_BASIC },
    update: {
      creatorWawuId: USER_CREATOR_BASIC,
      tier: CreatorTier.basic,
      status: SubscriptionStatus.active,
      commissionRateOverride: null,
      flutterwaveCustomerRef: 'seed-flw-customer-002',
      flutterwavePlanId: 'seed-flw-plan-basic',
      currentPeriodEnd: oneYearFromNow,
      renewalAttempts: 0,
      cancelsAt: null,
      cardLast4: '4242',
    },
    create: {
      creatorWawuId: USER_CREATOR_BASIC,
      tier: CreatorTier.basic,
      status: SubscriptionStatus.active,
      commissionRateOverride: null,
      flutterwaveCustomerRef: 'seed-flw-customer-002',
      flutterwavePlanId: 'seed-flw-plan-basic',
      currentPeriodEnd: oneYearFromNow,
      renewalAttempts: 0,
      cancelsAt: null,
      cardLast4: '4242',
    },
  });

  await prisma.creatorSubscription.upsert({
    where: { creatorWawuId: USER_CREATOR_PRO },
    update: {
      creatorWawuId: USER_CREATOR_PRO,
      tier: CreatorTier.pro,
      status: SubscriptionStatus.active,
      commissionRateOverride: 0.1,
      flutterwaveCustomerRef: 'seed-flw-customer-003',
      flutterwavePlanId: 'seed-flw-plan-pro',
      currentPeriodEnd: oneYearFromNow,
      renewalAttempts: 0,
      cancelsAt: null,
      cardLast4: '1881',
    },
    create: {
      creatorWawuId: USER_CREATOR_PRO,
      tier: CreatorTier.pro,
      status: SubscriptionStatus.active,
      commissionRateOverride: 0.1,
      flutterwaveCustomerRef: 'seed-flw-customer-003',
      flutterwavePlanId: 'seed-flw-plan-pro',
      currentPeriodEnd: oneYearFromNow,
      renewalAttempts: 0,
      cancelsAt: null,
      cardLast4: '1881',
    },
  });

  // ---------------------------------------------------------------------
  // KycSubmission — fully separate from verification tier (CLAUDE.md
  // non-negotiable). Basic creator: pending. Pro creator: approved.
  // ---------------------------------------------------------------------
  await prisma.kycSubmission.upsert({
    where: { id: '13000000-0000-4000-8000-000000000002' },
    update: {
      id: '13000000-0000-4000-8000-000000000002',
      wawuUserId: USER_CREATOR_BASIC,
      country: 'Nigeria',
      bvn: '22212345678',
      nin: '11198765432',
      nationalIdEquivalent: null,
      idDocumentType: 'nin_slip',
      idDocumentUrl: 'https://storage.seed.local/kyc/chidi-nin-slip.pdf',
      payoutBankName: 'GTBank',
      payoutAccountNumber: '0123456789',
      status: ReviewStatus.pending,
      rejectionReason: null,
      submittedAt: now,
      reviewedAt: null,
    },
    create: {
      id: '13000000-0000-4000-8000-000000000002',
      wawuUserId: USER_CREATOR_BASIC,
      country: 'Nigeria',
      bvn: '22212345678',
      nin: '11198765432',
      nationalIdEquivalent: null,
      idDocumentType: 'nin_slip',
      idDocumentUrl: 'https://storage.seed.local/kyc/chidi-nin-slip.pdf',
      payoutBankName: 'GTBank',
      payoutAccountNumber: '0123456789',
      status: ReviewStatus.pending,
      rejectionReason: null,
      submittedAt: now,
      reviewedAt: null,
    },
  });

  await prisma.kycSubmission.upsert({
    where: { id: '13000000-0000-4000-8000-000000000003' },
    update: {
      id: '13000000-0000-4000-8000-000000000003',
      wawuUserId: USER_CREATOR_PRO,
      country: 'Nigeria',
      bvn: '22287654321',
      nin: '11112345678',
      nationalIdEquivalent: null,
      idDocumentType: 'nin_slip',
      idDocumentUrl: 'https://storage.seed.local/kyc/zainab-nin-slip.pdf',
      payoutBankName: 'Access Bank',
      payoutAccountNumber: '0098765432',
      status: ReviewStatus.approved,
      rejectionReason: null,
      submittedAt: now,
      reviewedAt: now,
    },
    create: {
      id: '13000000-0000-4000-8000-000000000003',
      wawuUserId: USER_CREATOR_PRO,
      country: 'Nigeria',
      bvn: '22287654321',
      nin: '11112345678',
      nationalIdEquivalent: null,
      idDocumentType: 'nin_slip',
      idDocumentUrl: 'https://storage.seed.local/kyc/zainab-nin-slip.pdf',
      payoutBankName: 'Access Bank',
      payoutAccountNumber: '0098765432',
      status: ReviewStatus.approved,
      rejectionReason: null,
      submittedAt: now,
      reviewedAt: now,
    },
  });

  // ---------------------------------------------------------------------
  // ContentPiece — DISTINCTIVE seeded title for the live-gate, plus 2 more
  // for variety (free video, paid PDF template).
  // ---------------------------------------------------------------------
  await prisma.contentPiece.upsert({
    where: { slug: 'seeded-cac-in-7-days' },
    update: {
      id: CONTENT_CAC_COURSE,
      slug: 'seeded-cac-in-7-days',
      creatorWawuId: USER_CREATOR_PRO,
      contentType: ContentType.course,
      title: 'SEEDED: CAC in 7 days',
      description:
        'A step-by-step course on registering your Nigerian business with CAC in a week, from name reservation to certificate.',
      category: 'business',
      tags: ['cac', 'business-registration', 'nigeria'],
      accessType: AccessType.paid,
      price: 5000,
      durationLabel: '1h 20m',
      pageCount: null,
      previewAssetUrl:
        'https://storage.seed.local/content/cac-in-7-days-preview.mp4',
      fullAssetUrl: 'https://storage.seed.local/content/cac-in-7-days-full.mp4',
      creatorFirstUploadFree: false,
      status: ContentStatus.live,
      views: 412,
      ratingPct: 96,
      commentCount: 0,
      likes: 58,
    },
    create: {
      id: CONTENT_CAC_COURSE,
      slug: 'seeded-cac-in-7-days',
      creatorWawuId: USER_CREATOR_PRO,
      contentType: ContentType.course,
      title: 'SEEDED: CAC in 7 days',
      description:
        'A step-by-step course on registering your Nigerian business with CAC in a week, from name reservation to certificate.',
      category: 'business',
      tags: ['cac', 'business-registration', 'nigeria'],
      accessType: AccessType.paid,
      price: 5000,
      durationLabel: '1h 20m',
      pageCount: null,
      previewAssetUrl:
        'https://storage.seed.local/content/cac-in-7-days-preview.mp4',
      fullAssetUrl: 'https://storage.seed.local/content/cac-in-7-days-full.mp4',
      creatorFirstUploadFree: false,
      status: ContentStatus.live,
      views: 412,
      ratingPct: 96,
      commentCount: 0,
      likes: 58,
    },
  });

  await prisma.contentPiece.upsert({
    where: { slug: 'seeded-10-minute-owambe-makeup' },
    update: {
      id: CONTENT_MAKEUP_VIDEO,
      slug: 'seeded-10-minute-owambe-makeup',
      creatorWawuId: USER_CREATOR_BASIC,
      contentType: ContentType.video,
      title: 'SEEDED: 10-Minute Owambe Makeup',
      description: 'Fast, full-glam owambe-ready makeup in under 10 minutes.',
      category: 'beauty',
      tags: ['makeup', 'owambe', 'tutorial'],
      accessType: AccessType.free,
      price: 0,
      durationLabel: '10m',
      pageCount: null,
      previewAssetUrl:
        'https://storage.seed.local/content/owambe-makeup-preview.mp4',
      fullAssetUrl: 'https://storage.seed.local/content/owambe-makeup-full.mp4',
      creatorFirstUploadFree: true,
      status: ContentStatus.live,
      views: 1893,
      ratingPct: 91,
      commentCount: 1,
      likes: 240,
    },
    create: {
      id: CONTENT_MAKEUP_VIDEO,
      slug: 'seeded-10-minute-owambe-makeup',
      creatorWawuId: USER_CREATOR_BASIC,
      contentType: ContentType.video,
      title: 'SEEDED: 10-Minute Owambe Makeup',
      description: 'Fast, full-glam owambe-ready makeup in under 10 minutes.',
      category: 'beauty',
      tags: ['makeup', 'owambe', 'tutorial'],
      accessType: AccessType.free,
      price: 0,
      durationLabel: '10m',
      pageCount: null,
      previewAssetUrl:
        'https://storage.seed.local/content/owambe-makeup-preview.mp4',
      fullAssetUrl: 'https://storage.seed.local/content/owambe-makeup-full.mp4',
      creatorFirstUploadFree: true,
      status: ContentStatus.live,
      views: 1893,
      ratingPct: 91,
      commentCount: 1,
      likes: 240,
    },
  });

  await prisma.contentPiece.upsert({
    where: { slug: 'seeded-invoice-template-pack' },
    update: {
      id: CONTENT_PDF_TEMPLATE,
      slug: 'seeded-invoice-template-pack',
      creatorWawuId: USER_CREATOR_PRO,
      contentType: ContentType.template,
      title: 'SEEDED: Invoice Template Pack',
      description:
        'Ten editable invoice templates for Nigerian small businesses.',
      category: 'business',
      tags: ['templates', 'invoicing'],
      accessType: AccessType.paid,
      price: 1500,
      durationLabel: null,
      pageCount: 10,
      previewAssetUrl:
        'https://storage.seed.local/content/invoice-templates-preview.pdf',
      fullAssetUrl:
        'https://storage.seed.local/content/invoice-templates-full.zip',
      creatorFirstUploadFree: false,
      status: ContentStatus.live,
      views: 76,
      ratingPct: null,
      commentCount: 0,
      likes: 9,
    },
    create: {
      id: CONTENT_PDF_TEMPLATE,
      slug: 'seeded-invoice-template-pack',
      creatorWawuId: USER_CREATOR_PRO,
      contentType: ContentType.template,
      title: 'SEEDED: Invoice Template Pack',
      description:
        'Ten editable invoice templates for Nigerian small businesses.',
      category: 'business',
      tags: ['templates', 'invoicing'],
      accessType: AccessType.paid,
      price: 1500,
      durationLabel: null,
      pageCount: 10,
      previewAssetUrl:
        'https://storage.seed.local/content/invoice-templates-preview.pdf',
      fullAssetUrl:
        'https://storage.seed.local/content/invoice-templates-full.zip',
      creatorFirstUploadFree: false,
      status: ContentStatus.live,
      views: 76,
      ratingPct: null,
      commentCount: 0,
      likes: 9,
    },
  });

  await prisma.courseLesson.upsert({
    where: { id: LESSON_CAC_1 },
    update: {
      id: LESSON_CAC_1,
      contentId: CONTENT_CAC_COURSE,
      title: 'Reserving your business name',
      order: 1,
      durationLabel: '18m',
    },
    create: {
      id: LESSON_CAC_1,
      contentId: CONTENT_CAC_COURSE,
      title: 'Reserving your business name',
      order: 1,
      durationLabel: '18m',
    },
  });

  await prisma.courseLesson.upsert({
    where: { id: LESSON_CAC_2 },
    update: {
      id: LESSON_CAC_2,
      contentId: CONTENT_CAC_COURSE,
      title: 'Submitting your CAC application',
      order: 2,
      durationLabel: '22m',
    },
    create: {
      id: LESSON_CAC_2,
      contentId: CONTENT_CAC_COURSE,
      title: 'Submitting your CAC application',
      order: 2,
      durationLabel: '22m',
    },
  });

  await prisma.comment.upsert({
    where: { id: COMMENT_ON_MAKEUP },
    update: {
      id: COMMENT_ON_MAKEUP,
      contentId: CONTENT_MAKEUP_VIDEO,
      authorWawuId: USER_PLAIN,
      text: 'This saved my life before my cousin’s owambe, thank you!',
      replyToId: null,
      likes: 4,
    },
    create: {
      id: COMMENT_ON_MAKEUP,
      contentId: CONTENT_MAKEUP_VIDEO,
      authorWawuId: USER_PLAIN,
      text: 'This saved my life before my cousin’s owambe, thank you!',
      replyToId: null,
      likes: 4,
    },
  });

  // ---------------------------------------------------------------------
  // Community — DISTINCTIVE seeded name
  // ---------------------------------------------------------------------
  await prisma.community.upsert({
    where: { id: COMMUNITY_FOUNDERS },
    update: {
      id: COMMUNITY_FOUNDERS,
      name: 'SEEDED: WAWU Founders Circle',
      description:
        'A space for creator-founders to swap notes on registration, pricing, and growth.',
      hostWawuId: USER_CREATOR_PRO,
      kind: CommunityKind.open,
    },
    create: {
      id: COMMUNITY_FOUNDERS,
      name: 'SEEDED: WAWU Founders Circle',
      description:
        'A space for creator-founders to swap notes on registration, pricing, and growth.',
      hostWawuId: USER_CREATOR_PRO,
      kind: CommunityKind.open,
    },
  });

  await prisma.communityMembership.upsert({
    where: { id: MEMBERSHIP_PLAIN_IN_FOUNDERS },
    update: {
      id: MEMBERSHIP_PLAIN_IN_FOUNDERS,
      userWawuId: USER_PLAIN,
      communityId: COMMUNITY_FOUNDERS,
      status: MembershipStatus.joined,
      joinedAt: now,
    },
    create: {
      id: MEMBERSHIP_PLAIN_IN_FOUNDERS,
      userWawuId: USER_PLAIN,
      communityId: COMMUNITY_FOUNDERS,
      status: MembershipStatus.joined,
      joinedAt: now,
    },
  });

  await prisma.communityMessage.upsert({
    where: { id: MESSAGE_FOUNDERS_1 },
    update: {
      id: MESSAGE_FOUNDERS_1,
      communityId: COMMUNITY_FOUNDERS,
      senderWawuId: USER_CREATOR_PRO,
      text: 'Welcome founders! Drop your business registration questions here.',
      costInCredits: 0,
    },
    create: {
      id: MESSAGE_FOUNDERS_1,
      communityId: COMMUNITY_FOUNDERS,
      senderWawuId: USER_CREATOR_PRO,
      text: 'Welcome founders! Drop your business registration questions here.',
      costInCredits: 0,
    },
  });

  await prisma.communityMessage.upsert({
    where: { id: MESSAGE_FOUNDERS_2 },
    update: {
      id: MESSAGE_FOUNDERS_2,
      communityId: COMMUNITY_FOUNDERS,
      senderWawuId: USER_PLAIN,
      text: 'How long did CAC actually take for you all?',
      costInCredits: 1,
    },
    create: {
      id: MESSAGE_FOUNDERS_2,
      communityId: COMMUNITY_FOUNDERS,
      senderWawuId: USER_PLAIN,
      text: 'How long did CAC actually take for you all?',
      costInCredits: 1,
    },
  });

  // ---------------------------------------------------------------------
  // PartnerService — DISTINCTIVE "coming soon" seeded name
  // ---------------------------------------------------------------------
  await prisma.partnerService.upsert({
    where: { id: PARTNER_SERVICE_CAC },
    update: {
      id: PARTNER_SERVICE_CAC,
      slug: 'seed-cac',
      name: 'CAC Business Registration',
      tagline: 'Register your business with CAC in days, not months.',
      blurb:
        'We handle name reservation, filing, and certificate delivery end to end.',
      icon: 'building-office',
      status: PartnerServiceStatus.live,
      turnaround: '7 business days',
      priceFrom: '₦25,000',
      partner: 'WAWU Legal Partners',
      comingNote: null,
    },
    create: {
      id: PARTNER_SERVICE_CAC,
      slug: 'seed-cac',
      name: 'CAC Business Registration',
      tagline: 'Register your business with CAC in days, not months.',
      blurb:
        'We handle name reservation, filing, and certificate delivery end to end.',
      icon: 'building-office',
      status: PartnerServiceStatus.live,
      turnaround: '7 business days',
      priceFrom: '₦25,000',
      partner: 'WAWU Legal Partners',
      comingNote: null,
    },
  });

  await prisma.partnerService.upsert({
    where: { id: PARTNER_SERVICE_NEPC },
    update: {
      id: PARTNER_SERVICE_NEPC,
      slug: 'seed-nepc',
      name: 'NEPC Export License',
      tagline: 'Get export-ready with your NEPC certificate.',
      blurb:
        'End-to-end NEPC registration for exporters targeting new markets.',
      icon: 'globe',
      status: PartnerServiceStatus.live,
      turnaround: '14 business days',
      priceFrom: '₦40,000',
      partner: 'WAWU Legal Partners',
      comingNote: null,
    },
    create: {
      id: PARTNER_SERVICE_NEPC,
      slug: 'seed-nepc',
      name: 'NEPC Export License',
      tagline: 'Get export-ready with your NEPC certificate.',
      blurb:
        'End-to-end NEPC registration for exporters targeting new markets.',
      icon: 'globe',
      status: PartnerServiceStatus.live,
      turnaround: '14 business days',
      priceFrom: '₦40,000',
      partner: 'WAWU Legal Partners',
      comingNote: null,
    },
  });

  // NOT NEEDED, NOT ADDED: a live PartnerService row for slug 'pay' already
  // exists in the real database — seeded via idempotent SQL migrations
  // (20260818230000_partner_service_catalogue, ON CONFLICT ("slug") DO
  // UPDATE), which this dev/test-only seed script runs AFTER. A block here
  // that upserted by a hardcoded id instead of by slug found no row (wrong
  // key) and tried to INSERT a second one, which failed on the slug's unique
  // constraint every single run — the actual cause of every "Deploy Hub API"
  // failure from the moment this was added until it was removed. Checked
  // against prisma/migrations/*/migration.sql before writing this comment,
  // not just this file, which is the check that was skipped the first time.

  await prisma.partnerService.upsert({
    where: { id: PARTNER_SERVICE_TRADEMARK },
    update: {
      id: PARTNER_SERVICE_TRADEMARK,
      slug: 'seed-trademark',
      name: 'SEEDED: WAWU Trademark Fast-Track',
      tagline: 'Protect your brand name and logo.',
      blurb: 'Trademark filing and search, coming soon to the services hub.',
      icon: 'shield-check',
      status: PartnerServiceStatus.coming,
      turnaround: null,
      priceFrom: null,
      partner: null,
      comingNote: 'Launching alongside the next services hub update.',
    },
    create: {
      id: PARTNER_SERVICE_TRADEMARK,
      slug: 'seed-trademark',
      name: 'SEEDED: WAWU Trademark Fast-Track',
      tagline: 'Protect your brand name and logo.',
      blurb: 'Trademark filing and search, coming soon to the services hub.',
      icon: 'shield-check',
      status: PartnerServiceStatus.coming,
      turnaround: null,
      priceFrom: null,
      partner: null,
      comingNote: 'Launching alongside the next services hub update.',
    },
  });

  // ---------------------------------------------------------------------
  // Mentor — DISTINCTIVE seeded name
  // ---------------------------------------------------------------------
  await prisma.mentor.upsert({
    where: { handle: 'seeded-amara-nwosu' },
    update: {
      id: MENTOR_AMARA,
      name: 'SEEDED: Amara Nwosu',
      handle: 'seeded-amara-nwosu',
      field: 'Fashion & Retail',
      category: 'fashion',
      tagline: 'From tailor shop to 3-city retail chain.',
      bio: 'Amara built a Lagos tailoring business into a multi-city fashion retail chain over 12 years.',
      topics: ['retail expansion', 'inventory', 'hiring'],
      verification: 'verified_business',
      openForRequests: true,
      fullUntil: null,
      yearsExperience: 12,
      sessions: 87,
      languages: ['English', 'Igbo'],
    },
    create: {
      id: MENTOR_AMARA,
      name: 'SEEDED: Amara Nwosu',
      handle: 'seeded-amara-nwosu',
      field: 'Fashion & Retail',
      category: 'fashion',
      tagline: 'From tailor shop to 3-city retail chain.',
      bio: 'Amara built a Lagos tailoring business into a multi-city fashion retail chain over 12 years.',
      topics: ['retail expansion', 'inventory', 'hiring'],
      verification: 'verified_business',
      openForRequests: true,
      fullUntil: null,
      yearsExperience: 12,
      sessions: 87,
      languages: ['English', 'Igbo'],
    },
  });

  await prisma.mentor.upsert({
    where: { handle: 'tunde-adebayo' },
    update: {
      id: MENTOR_TUNDE,
      name: 'Tunde Adebayo',
      handle: 'tunde-adebayo',
      field: 'Fintech',
      category: 'technology',
      tagline: 'Ex-fintech founder, now angel investor.',
      bio: 'Tunde founded and exited a payments startup and now advises early-stage African founders.',
      topics: ['fundraising', 'product-market fit'],
      verification: 'certified_professional',
      openForRequests: true,
      fullUntil: null,
      yearsExperience: 9,
      sessions: 41,
      languages: ['English', 'Yoruba'],
    },
    create: {
      id: MENTOR_TUNDE,
      name: 'Tunde Adebayo',
      handle: 'tunde-adebayo',
      field: 'Fintech',
      category: 'technology',
      tagline: 'Ex-fintech founder, now angel investor.',
      bio: 'Tunde founded and exited a payments startup and now advises early-stage African founders.',
      topics: ['fundraising', 'product-market fit'],
      verification: 'certified_professional',
      openForRequests: true,
      fullUntil: null,
      yearsExperience: 9,
      sessions: 41,
      languages: ['English', 'Yoruba'],
    },
  });

  // ---------------------------------------------------------------------
  // LearnCourse — DISTINCTIVE seeded title
  // ---------------------------------------------------------------------
  await prisma.learnCourse.upsert({
    where: { id: LEARN_COURSE_EXPORT },
    update: {
      id: LEARN_COURSE_EXPORT,
      title: 'SEEDED: Export Basics for African Creators',
      category: 'business',
      hours: 4,
      certificate: true,
      overview:
        'Learn the fundamentals of exporting goods from Nigeria to international markets.',
      whatItCovers: [
        'Export documentation',
        'NEPC registration',
        'Pricing for export',
        'Logistics basics',
      ],
      externalHostUrl: 'https://alison.com/course/seeded-export-basics',
    },
    create: {
      id: LEARN_COURSE_EXPORT,
      title: 'SEEDED: Export Basics for African Creators',
      category: 'business',
      hours: 4,
      certificate: true,
      overview:
        'Learn the fundamentals of exporting goods from Nigeria to international markets.',
      whatItCovers: [
        'Export documentation',
        'NEPC registration',
        'Pricing for export',
        'Logistics basics',
      ],
      externalHostUrl: 'https://alison.com/course/seeded-export-basics',
    },
  });

  await prisma.learnCourse.upsert({
    where: { id: LEARN_COURSE_SOCIAL },
    update: {
      id: LEARN_COURSE_SOCIAL,
      title: 'Social Media Growth for Creators',
      category: 'marketing',
      hours: 3,
      certificate: false,
      overview:
        'Grow an engaged following across Instagram, TikTok, and WhatsApp Status.',
      whatItCovers: [
        'Content calendars',
        'Hashtag strategy',
        'Analytics basics',
      ],
      externalHostUrl: 'https://alison.com/course/social-growth',
    },
    create: {
      id: LEARN_COURSE_SOCIAL,
      title: 'Social Media Growth for Creators',
      category: 'marketing',
      hours: 3,
      certificate: false,
      overview:
        'Grow an engaged following across Instagram, TikTok, and WhatsApp Status.',
      whatItCovers: [
        'Content calendars',
        'Hashtag strategy',
        'Analytics basics',
      ],
      externalHostUrl: 'https://alison.com/course/social-growth',
    },
  });

  await prisma.courseEnrollment.upsert({
    where: { id: COURSE_ENROLLMENT_PLAIN_EXPORT },
    update: {
      id: COURSE_ENROLLMENT_PLAIN_EXPORT,
      userWawuId: USER_PLAIN,
      courseId: LEARN_COURSE_EXPORT,
      enrolledAt: now,
      progressPct: 25,
    },
    create: {
      id: COURSE_ENROLLMENT_PLAIN_EXPORT,
      userWawuId: USER_PLAIN,
      courseId: LEARN_COURSE_EXPORT,
      enrolledAt: now,
      progressPct: 25,
    },
  });

  // ---------------------------------------------------------------------
  // LearnGuide — DISTINCTIVE seeded title
  // ---------------------------------------------------------------------
  await prisma.learnGuide.upsert({
    where: { id: LEARN_GUIDE_NIGERIA },
    update: {
      id: LEARN_GUIDE_NIGERIA,
      kind: GuideKind.country,
      title: 'SEEDED: Nigeria Business Registration Guide',
      updated: now,
      country: 'Nigeria',
      subtitle: 'Everything you need to register a business entity in Nigeria.',
      readMinutes: 12,
      sections: [
        {
          heading: 'Choosing a structure',
          body: 'Sole proprietorship vs. limited company.',
        },
        { heading: 'CAC filing', body: 'Step-by-step filing walkthrough.' },
      ],
      fileCount: 3,
    },
    create: {
      id: LEARN_GUIDE_NIGERIA,
      kind: GuideKind.country,
      title: 'SEEDED: Nigeria Business Registration Guide',
      updated: now,
      country: 'Nigeria',
      subtitle: 'Everything you need to register a business entity in Nigeria.',
      readMinutes: 12,
      sections: [
        {
          heading: 'Choosing a structure',
          body: 'Sole proprietorship vs. limited company.',
        },
        { heading: 'CAC filing', body: 'Step-by-step filing walkthrough.' },
      ],
      fileCount: 3,
    },
  });

  await prisma.learnGuide.upsert({
    where: { id: LEARN_GUIDE_PRICING },
    update: {
      id: LEARN_GUIDE_PRICING,
      kind: GuideKind.article,
      title: 'Pricing Your Digital Products',
      updated: now,
      country: null,
      subtitle: 'A framework for pricing courses, templates, and content.',
      readMinutes: 6,
      fileCount: null,
    },
    create: {
      id: LEARN_GUIDE_PRICING,
      kind: GuideKind.article,
      title: 'Pricing Your Digital Products',
      updated: now,
      country: null,
      subtitle: 'A framework for pricing courses, templates, and content.',
      readMinutes: 6,
      fileCount: null,
    },
  });

  await prisma.playbook.upsert({
    where: { id: PLAYBOOK_MAIN },
    update: {
      id: PLAYBOOK_MAIN,
      title: 'The WAWU Creator Playbook',
      pages: 42,
      format: 'pdf',
      description:
        'A complete guide to building a creator business on WAWU Africa.',
      chapters: [
        { title: 'Getting started', order: 1 },
        { title: 'Pricing your content', order: 2 },
        { title: 'Growing your audience', order: 3 },
      ],
      readingSections: [
        { heading: 'Introduction', body: 'Welcome to the playbook.' },
      ],
    },
    create: {
      id: PLAYBOOK_MAIN,
      title: 'The WAWU Creator Playbook',
      pages: 42,
      format: 'pdf',
      description:
        'A complete guide to building a creator business on WAWU Africa.',
      chapters: [
        { title: 'Getting started', order: 1 },
        { title: 'Pricing your content', order: 2 },
        { title: 'Growing your audience', order: 3 },
      ],
      readingSections: [
        { heading: 'Introduction', body: 'Welcome to the playbook.' },
      ],
    },
  });

  // ---------------------------------------------------------------------
  // Credits, follows, saves, purchases, DMs, notifications — cross-cutting
  // rows so contract tests can exercise most of the wire surface.
  // ---------------------------------------------------------------------
  for (const wawuUserId of [USER_PLAIN, USER_CREATOR_BASIC, USER_CREATOR_PRO]) {
    await prisma.creditsState.upsert({
      where: { userWawuId: wawuUserId },
      update: {
        userWawuId: wawuUserId,
        creditBalance: 48,
        trialEndsAt: sevenDaysFromNow,
      },
      create: {
        userWawuId: wawuUserId,
        creditBalance: 48,
        trialEndsAt: sevenDaysFromNow,
      },
    });
    await prisma.notificationSettings.upsert({
      where: { userWawuId: wawuUserId },
      update: { userWawuId: wawuUserId },
      create: { userWawuId: wawuUserId },
    });
    await prisma.privacySettings.upsert({
      where: { userWawuId: wawuUserId },
      update: { userWawuId: wawuUserId },
      create: { userWawuId: wawuUserId },
    });
  }

  await prisma.evgScore.upsert({
    where: { creatorWawuId: USER_CREATOR_BASIC },
    update: { creatorWawuId: USER_CREATOR_BASIC, score: 1240 },
    create: { creatorWawuId: USER_CREATOR_BASIC, score: 1240 },
  });
  await prisma.evgScore.upsert({
    where: { creatorWawuId: USER_CREATOR_PRO },
    update: { creatorWawuId: USER_CREATOR_PRO, score: 5310 },
    create: { creatorWawuId: USER_CREATOR_PRO, score: 5310 },
  });

  await prisma.creatorNoResponseTracker.upsert({
    where: { creatorWawuId: USER_CREATOR_BASIC },
    update: {
      creatorWawuId: USER_CREATOR_BASIC,
      noResponseRatePct: 0,
      penaltyState: 'none',
    },
    create: {
      creatorWawuId: USER_CREATOR_BASIC,
      noResponseRatePct: 0,
      penaltyState: 'none',
    },
  });
  await prisma.creatorNoResponseTracker.upsert({
    where: { creatorWawuId: USER_CREATOR_PRO },
    update: {
      creatorWawuId: USER_CREATOR_PRO,
      noResponseRatePct: 4.2,
      penaltyState: 'none',
    },
    create: {
      creatorWawuId: USER_CREATOR_PRO,
      noResponseRatePct: 4.2,
      penaltyState: 'none',
    },
  });

  await prisma.followRelationship.upsert({
    where: {
      followerWawuId_followingWawuId: {
        followerWawuId: USER_PLAIN,
        followingWawuId: USER_CREATOR_BASIC,
      },
    },
    update: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_BASIC },
    create: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_BASIC },
  });
  await prisma.followRelationship.upsert({
    where: {
      followerWawuId_followingWawuId: {
        followerWawuId: USER_PLAIN,
        followingWawuId: USER_CREATOR_PRO,
      },
    },
    update: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO },
    create: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO },
  });

  await prisma.savedItem.upsert({
    where: {
      userWawuId_contentId: {
        userWawuId: USER_PLAIN,
        contentId: CONTENT_CAC_COURSE,
      },
    },
    update: { userWawuId: USER_PLAIN, contentId: CONTENT_CAC_COURSE },
    create: { userWawuId: USER_PLAIN, contentId: CONTENT_CAC_COURSE },
  });

  await prisma.purchase.upsert({
    where: { id: PURCHASE_PLAIN_BUYS_CAC_COURSE },
    update: {
      id: PURCHASE_PLAIN_BUYS_CAC_COURSE,
      contentId: CONTENT_CAC_COURSE,
      type: PurchaseType.content,
      buyerWawuId: USER_PLAIN,
      creatorWawuId: USER_CREATOR_PRO,
      amount: 5000,
      commissionRate: 0.1,
      flutterwaveTxRef: 'seed-tx-ref-001',
      flutterwaveTxId: 'seed-tx-id-001',
      status: TransactionStatus.completed,
      note: null,
      purchasedAt: now,
    },
    create: {
      id: PURCHASE_PLAIN_BUYS_CAC_COURSE,
      contentId: CONTENT_CAC_COURSE,
      type: PurchaseType.content,
      buyerWawuId: USER_PLAIN,
      creatorWawuId: USER_CREATOR_PRO,
      amount: 5000,
      commissionRate: 0.1,
      flutterwaveTxRef: 'seed-tx-ref-001',
      flutterwaveTxId: 'seed-tx-id-001',
      status: TransactionStatus.completed,
      note: null,
      purchasedAt: now,
    },
  });

  await prisma.directMessage.upsert({
    where: { id: DM_PLAIN_TO_PRO },
    update: {
      id: DM_PLAIN_TO_PRO,
      creatorWawuId: USER_CREATOR_PRO,
      senderWawuId: USER_PLAIN,
      text: 'Hi Zainab, can you help me figure out the right business structure for a 2-person team?',
      amount: 300,
      status: DmStatus.awaiting_response,
      sentAt: now,
      deadlineAt: twentyFourHoursFromNow,
      respondedAt: null,
      responseText: null,
      flutterwaveTxRef: 'seed-tx-ref-dm-001',
    },
    create: {
      id: DM_PLAIN_TO_PRO,
      creatorWawuId: USER_CREATOR_PRO,
      senderWawuId: USER_PLAIN,
      text: 'Hi Zainab, can you help me figure out the right business structure for a 2-person team?',
      amount: 300,
      status: DmStatus.awaiting_response,
      sentAt: now,
      deadlineAt: twentyFourHoursFromNow,
      respondedAt: null,
      responseText: null,
      flutterwaveTxRef: 'seed-tx-ref-dm-001',
    },
  });

  await prisma.notification.upsert({
    where: { id: NOTIFICATION_SALE_FOR_PRO },
    update: {
      id: NOTIFICATION_SALE_FOR_PRO,
      userWawuId: USER_CREATOR_PRO,
      kind: 'sale',
      title: 'You made a sale!',
      body: '"SEEDED: CAC in 7 days" just sold for ₦5,000.',
      tone: 'positive',
      amount: 5000,
      creditsCount: null,
      actionLabel: 'View earnings',
      read: false,
      createdAt: now,
    },
    create: {
      id: NOTIFICATION_SALE_FOR_PRO,
      userWawuId: USER_CREATOR_PRO,
      kind: 'sale',
      title: 'You made a sale!',
      body: '"SEEDED: CAC in 7 days" just sold for ₦5,000.',
      tone: 'positive',
      amount: 5000,
      creditsCount: null,
      actionLabel: 'View earnings',
      read: false,
      createdAt: now,
    },
  });

  await prisma.notification.upsert({
    where: { id: NOTIFICATION_FOLLOW_FOR_BASIC },
    update: {
      id: NOTIFICATION_FOLLOW_FOR_BASIC,
      userWawuId: USER_CREATOR_BASIC,
      kind: 'follow',
      title: 'New follower',
      body: 'Adaeze Okonkwo started following you.',
      tone: 'neutral',
      amount: null,
      creditsCount: null,
      actionLabel: 'View profile',
      read: false,
      createdAt: now,
    },
    create: {
      id: NOTIFICATION_FOLLOW_FOR_BASIC,
      userWawuId: USER_CREATOR_BASIC,
      kind: 'follow',
      title: 'New follower',
      body: 'Adaeze Okonkwo started following you.',
      tone: 'neutral',
      amount: null,
      creditsCount: null,
      actionLabel: 'View profile',
      read: false,
      createdAt: now,
    },
  });

  await prisma.marketplaceSave.upsert({
    where: {
      userWawuId_productId_shop: {
        userWawuId: USER_PLAIN,
        productId: 'basket-product-seed-001',
        shop: 'basket',
      },
    },
    update: {
      userWawuId: USER_PLAIN,
      productId: 'basket-product-seed-001',
      shop: 'basket',
    },
    create: {
      userWawuId: USER_PLAIN,
      productId: 'basket-product-seed-001',
      shop: 'basket',
    },
  });

  console.log('Seed complete.');

  console.log({
    userProfiles: await prisma.userProfile.count(),
    creatorStates: await prisma.creatorState.count(),
    creatorSubscriptions: await prisma.creatorSubscription.count(),
    kycSubmissions: await prisma.kycSubmission.count(),
    contentPieces: await prisma.contentPiece.count(),
    courseLessons: await prisma.courseLesson.count(),
    comments: await prisma.comment.count(),
    communities: await prisma.community.count(),
    communityMemberships: await prisma.communityMembership.count(),
    communityMessages: await prisma.communityMessage.count(),
    partnerServices: await prisma.partnerService.count(),
    mentors: await prisma.mentor.count(),
    learnCourses: await prisma.learnCourse.count(),
    courseEnrollments: await prisma.courseEnrollment.count(),
    learnGuides: await prisma.learnGuide.count(),
    playbooks: await prisma.playbook.count(),
    creditsStates: await prisma.creditsState.count(),
    evgScores: await prisma.evgScore.count(),
    followRelationships: await prisma.followRelationship.count(),
    savedItems: await prisma.savedItem.count(),
    purchases: await prisma.purchase.count(),
    directMessages: await prisma.directMessage.count(),
    notifications: await prisma.notification.count(),
    marketplaceSaves: await prisma.marketplaceSave.count(),
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
