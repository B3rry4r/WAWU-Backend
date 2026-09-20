// Contract tests for NotificationService.emit() — the single write path into
// the Notification table.
//
// Before this, `prisma.notification.create` existed NOWHERE in src/: the only
// writers in the repo were two prisma/seed.ts upserts, so every notification
// any user had ever seen was fixture data. These tests cover the emitter
// itself: the row it writes per kind, the NotificationSettings flags it
// honours, the flags it deliberately does not, and the CLAUDE.md copy rules
// its bodies must obey (Naira only, credits as a COUNT, no wallet/cash-out
// language).
//
// No HTTP and no auth here — the wiring of real endpoints into the emitter is
// covered by notification-wiring.contract.spec.ts.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationModule } from '../notification.module';
import { NotificationService } from '../notification.service';
import { composeNotification, type NotificationEvent } from '../notification-event';

// Synthetic recipients — never a seeded user, so nothing here can perturb
// another suite's fixture counts.
const RECIPIENT = 'e1000000-0000-4000-8000-000000000001';
const RECIPIENT_MUTED = 'e1000000-0000-4000-8000-000000000002';
const RECIPIENT_NO_SETTINGS_ROW = 'e1000000-0000-4000-8000-000000000003';
const ALL_RECIPIENTS = [RECIPIENT, RECIPIENT_MUTED, RECIPIENT_NO_SETTINGS_ROW];

/** Every kind, with a representative payload. Used for the copy sweep. */
const ONE_OF_EVERY_KIND = (userWawuId: string): NotificationEvent[] => [
  { kind: 'sale', userWawuId, contentTitle: 'Invoice Template Pack', netAmount: 1350 },
  { kind: 'tip_received', userWawuId, netAmount: 850 },
  { kind: 'dm_received', userWawuId, amount: 300 },
  { kind: 'dm_deadline', userWawuId, hoursLeft: 3.4 },
  { kind: 'dm_refunded', userWawuId, amount: 300 },
  { kind: 'credits_low', userWawuId, creditsCount: 4 },
  { kind: 'trial_ending', userWawuId, creditsCount: 12 },
  { kind: 'new_follower', userWawuId },
  { kind: 'content_published', userWawuId, contentTitle: 'Owambe Makeup' },
  { kind: 'content_rejected', userWawuId, contentTitle: 'Owambe Makeup', reason: 'Audio is inaudible.' },
  { kind: 'kyc_verified', userWawuId, approved: true },
  { kind: 'kyc_verified', userWawuId, approved: false },
];

describe('NotificationService.emit (contract)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let notifications: NotificationService;

  const wipe = async () => {
    await prisma.notification.deleteMany({ where: { userWawuId: { in: ALL_RECIPIENTS } } });
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, NotificationModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    notifications = moduleRef.get(NotificationService);

    await prisma.notificationSettings.deleteMany({ where: { userWawuId: { in: ALL_RECIPIENTS } } });
    await prisma.notificationSettings.create({ data: { userWawuId: RECIPIENT } });
    await prisma.notificationSettings.create({
      data: {
        userWawuId: RECIPIENT_MUTED,
        newReplies: false,
        newFollowers: false,
        dmReminders: false,
        refunds: false,
        promotions: false,
        communityDigest: false,
      },
    });
    await wipe();
  }, 30000);

  afterAll(async () => {
    await wipe();
    await prisma.notificationSettings.deleteMany({ where: { userWawuId: { in: ALL_RECIPIENTS } } });
    await moduleRef?.close();
  });

  beforeEach(wipe);

  describe('writes the right row per kind', () => {
    it('sale — kind, tone, the creator net in `amount`, and no credits count', async () => {
      const row = await notifications.emit({
        kind: 'sale',
        userWawuId: RECIPIENT,
        contentTitle: 'Invoice Template Pack',
        netAmount: 1350,
      });

      expect(row).not.toBeNull();
      expect(row).toMatchObject({
        userWawuId: RECIPIENT,
        kind: 'sale',
        tone: 'success',
        amount: 1350,
        creditsCount: null,
        read: false,
      });
      expect(row!.body).toContain('₦1,350');
      expect(row!.title).toBe('Content sold');

      const stored = await prisma.notification.findUnique({ where: { id: row!.id } });
      expect(stored).not.toBeNull();
    });

    it('credits_low — a COUNT in `creditsCount`, and `amount` left null so no client can render it as money', async () => {
      const row = await notifications.emit({
        kind: 'credits_low',
        userWawuId: RECIPIENT,
        creditsCount: 4,
      });

      expect(row).toMatchObject({ kind: 'credits_low', creditsCount: 4, amount: null, tone: 'warning' });
      expect(row!.body).toContain('4 credits');
      expect(row!.body).not.toContain('₦');
    });

    it('credits_low at zero reads as "out of credits", not "0 credits left"', async () => {
      const row = await notifications.emit({
        kind: 'credits_low',
        userWawuId: RECIPIENT,
        creditsCount: 0,
      });

      expect(row!.tone).toBe('danger');
      expect(row!.title).toBe('You are out of credits');
      expect(row!.creditsCount).toBe(0);
    });

    it('dm_received carries the amount the fan paid and an actionable CTA', async () => {
      const row = await notifications.emit({ kind: 'dm_received', userWawuId: RECIPIENT, amount: 300 });

      expect(row).toMatchObject({ kind: 'dm_received', amount: 300, actionLabel: 'Reply now' });
      expect(row!.body).toContain('₦300');
      expect(row!.body).toContain('24 hours');
    });

    it('the admin-review kinds compose correctly, so feat/admin-surface can emit them unchanged', async () => {
      const published = await notifications.emit({
        kind: 'content_published',
        userWawuId: RECIPIENT,
        contentTitle: 'Owambe Makeup',
      });
      const rejected = await notifications.emit({
        kind: 'content_rejected',
        userWawuId: RECIPIENT,
        contentTitle: 'Owambe Makeup',
        reason: 'Audio is inaudible.',
      });
      const kyc = await notifications.emit({ kind: 'kyc_verified', userWawuId: RECIPIENT, approved: true });

      expect(published).toMatchObject({ kind: 'content_published', tone: 'success' });
      expect(rejected).toMatchObject({ kind: 'content_rejected', tone: 'danger' });
      expect(rejected!.body).toContain('Audio is inaudible.');
      expect(rejected!.body).toContain('upload slot has been returned');
      expect(kyc).toMatchObject({ kind: 'kyc_verified', tone: 'success' });
    });
  });

  describe('NotificationSettings suppression', () => {
    it('newFollowers=false suppresses new_follower and writes nothing', async () => {
      const row = await notifications.emit({ kind: 'new_follower', userWawuId: RECIPIENT_MUTED });

      expect(row).toBeNull();
      expect(await prisma.notification.count({ where: { userWawuId: RECIPIENT_MUTED } })).toBe(0);
    });

    it('dmReminders=false suppresses dm_deadline', async () => {
      const row = await notifications.emit({ kind: 'dm_deadline', userWawuId: RECIPIENT_MUTED, hoursLeft: 3 });

      expect(row).toBeNull();
      expect(await prisma.notification.count({ where: { userWawuId: RECIPIENT_MUTED } })).toBe(0);
    });

    it('refunds=false suppresses dm_refunded', async () => {
      const row = await notifications.emit({ kind: 'dm_refunded', userWawuId: RECIPIENT_MUTED, amount: 300 });

      expect(row).toBeNull();
      expect(await prisma.notification.count({ where: { userWawuId: RECIPIENT_MUTED } })).toBe(0);
    });

    it('the same three kinds are written when the flags are on', async () => {
      const follower = await notifications.emit({ kind: 'new_follower', userWawuId: RECIPIENT });
      const deadline = await notifications.emit({ kind: 'dm_deadline', userWawuId: RECIPIENT, hoursLeft: 3 });
      const refund = await notifications.emit({ kind: 'dm_refunded', userWawuId: RECIPIENT, amount: 300 });

      expect([follower, deadline, refund].every((r) => r !== null)).toBe(true);
      expect(await prisma.notification.count({ where: { userWawuId: RECIPIENT } })).toBe(3);
    });

    it('money-settlement kinds are NOT suppressible — every flag off still records that money moved', async () => {
      const rows = await Promise.all([
        notifications.emit({ kind: 'sale', userWawuId: RECIPIENT_MUTED, contentTitle: 'X', netAmount: 100 }),
        notifications.emit({ kind: 'tip_received', userWawuId: RECIPIENT_MUTED, netAmount: 100 }),
        notifications.emit({ kind: 'dm_received', userWawuId: RECIPIENT_MUTED, amount: 300 }),
      ]);

      expect(rows.every((r) => r !== null)).toBe(true);
      expect(await prisma.notification.count({ where: { userWawuId: RECIPIENT_MUTED } })).toBe(3);
    });

    it('a user with no NotificationSettings row falls back to the model defaults (gated kinds allowed)', async () => {
      const row = await notifications.emit({ kind: 'new_follower', userWawuId: RECIPIENT_NO_SETTINGS_ROW });

      expect(row).not.toBeNull();
      // Emitting must not lazily create the settings row — that would put a
      // settings write on the hot path of every payment verify.
      expect(
        await prisma.notificationSettings.findUnique({ where: { userWawuId: RECIPIENT_NO_SETTINGS_ROW } }),
      ).toBeNull();
    });
  });

  describe('emit never breaks the caller', () => {
    it('returns null instead of throwing when the write fails', async () => {
      const exploding = {
        notification: { create: () => Promise.reject(new Error('db is on fire')) },
        notificationSettings: { findUnique: () => Promise.resolve(null) },
      };

      await expect(
        notifications.emit({ kind: 'tip_received', userWawuId: RECIPIENT, netAmount: 10 }, exploding as never),
      ).resolves.toBeNull();
    });

    it('emitMany reports how many rows it actually wrote', async () => {
      const written = await notifications.emitMany([
        { kind: 'new_follower', userWawuId: RECIPIENT },
        { kind: 'new_follower', userWawuId: RECIPIENT_MUTED }, // suppressed
      ]);

      expect(written).toBe(1);
    });
  });

  describe('CLAUDE.md copy rules bind every kind', () => {
    const drafts = ONE_OF_EVERY_KIND(RECIPIENT).map(composeNotification);

    it('every kind in the vocabulary composes a title, body and tone', () => {
      for (const draft of drafts) {
        expect(draft.title.length).toBeGreaterThan(0);
        expect(draft.body.length).toBeGreaterThan(0);
        expect(draft.tone).toEqual(expect.any(String));
      }
    });

    it('no dollars, anywhere — Naira only', () => {
      for (const draft of drafts) {
        expect(`${draft.title} ${draft.body}`).not.toMatch(/\$|USD|dollar/i);
      }
    });

    it('no wallet, balance, withdrawal or cash-out language', () => {
      for (const draft of drafts) {
        expect(`${draft.title} ${draft.body}`).not.toMatch(/wallet|withdraw|cash ?out|payout/i);
      }
    });

    it('credits are a COUNT and never a naira value', () => {
      const creditKinds = drafts.filter((d) => d.kind === 'credits_low' || d.kind === 'trial_ending');

      expect(creditKinds).toHaveLength(2);
      for (const draft of creditKinds) {
        expect(draft.creditsCount).toEqual(expect.any(Number));
        expect(draft.amount).toBeNull();
        expect(draft.body).not.toContain('₦');
      }
    });

    it('money kinds put their figure in ₦ and in `amount`', () => {
      const moneyKinds = drafts.filter(
        (d) => d.kind === 'sale' || d.kind === 'tip_received' || d.kind === 'dm_received' || d.kind === 'dm_refunded',
      );

      expect(moneyKinds).toHaveLength(4);
      for (const draft of moneyKinds) {
        expect(draft.amount).toEqual(expect.any(Number));
        expect(draft.creditsCount).toBeNull();
        expect(draft.body).toContain('₦');
      }
    });

    it('never quotes an invented commission rate — the split is described, not numbered', () => {
      for (const draft of drafts) {
        expect(draft.body).not.toMatch(/\b(85|15|90|10)\s?%/);
      }
    });
  });
});
