import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  api,
  bootTierApp,
  installFintava,
  type Person,
  type TierHarness,
} from '../../../test/plans/tier-purchase-harness';
import {
  type CannedAnswer,
  MERCHANT_ACCOUNT,
  type SeenRequest,
} from '../../../test/fintava/fintava-double';
import { body } from '../../../test/payments/poll-helpers';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig, priceIn } from '../../plans/plans-config';
import type { PlanPurchaseQuoteView } from '../../plans/purchases/plan-purchase-view.type';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import type { MyPointsView } from '../../points/points-view.type';
import { ReferralRewardService } from '../referral-reward.service';
import { ReferralSweepService } from '../referral-sweep.service';
import { ReferralsService } from '../referrals.service';
import type { ClaimReferralView, MyReferralsView } from '../referral-view.type';

/**
 * REF-02: invite, claim and earn. Real Hub modules (money, plans, points,
 * referrals), a real database, real tokens from the stand-in WAWU ID, and a
 * tier bought through the real purchase route with the Fintava double behind
 * it. Time is passed to the job (`now`), never waited for.
 */

jest.setTimeout(180_000);

const DAY = 86_400_000;
const EM_DASH = String.fromCharCode(0x2014);
const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const middle = byPrice[1];
const RICH = 100 * priceIn(byPrice[byPrice.length - 1].price, 'NGN');
const BASE = config.referral.basePoints;

describe('Referral points: invite, claim and earn (REF-02)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let referrals: ReferralsService;
  let rewards: ReferralRewardService;
  let settings: PlanSettingsService;
  const refPeople: string[] = [];
  const settingKeys: string[] = [];
  const joinCodes: string[] = [];

  const reasonOf = (res: { body: unknown }) =>
    (res.body as { reason: { code: string; claimDays?: number } }).reason;
  const messageOf = (res: { body: unknown }) =>
    (res.body as { message: string }).message;
  const get = (p: Person, path = '') =>
    request(h.app.getHttpServer())
      .get(`/api/hub/me/referrals${path}`)
      .set('Authorization', p.auth);
  const claimRoute = (p: Person, code: string) =>
    request(h.app.getHttpServer())
      .post('/api/hub/me/referrals/claim')
      .set('Authorization', p.auth)
      .send({ code });
  const view = async (p: Person) =>
    body<MyReferralsView>(await get(p).expect(200)).data!;
  const balance = async (p: Person | string) => {
    if (typeof p === 'string') {
      const rows = await h.prisma.pointLot.findMany({
        where: { wawuUserId: p, remaining: { gt: 0 } },
        select: { remaining: true },
      });
      return rows.reduce((n, r) => n + r.remaining, 0);
    }
    const res = await request(h.app.getHttpServer())
      .get('/api/hub/me/points')
      .set('Authorization', p.auth)
      .expect(200);
    return body<MyPointsView>(res).data!.balance;
  };

  /** A person with a running tier (a row, as a purchase leaves it). */
  async function giveTier(
    id: string,
    tierId = small.id,
    from = new Date(Date.now() - DAY),
    until = new Date(Date.now() + 60 * DAY),
  ) {
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: id,
        tierId,
        activeFrom: from,
        activeUntil: until,
        productsIncluded: 3,
        pointsIncluded: 0,
      },
    });
  }

  /** The row a granted tier payment leaves behind. */
  async function paid(id: string, tierId = small.id) {
    const paymentRef = randomUUID();
    await h.prisma.makerPurchase.create({
      data: {
        paymentRef,
        wawuUserId: id,
        kind: 'tier',
        tierId,
        currency: 'NGN',
        amountMinor: 100000,
      },
    });
    return paymentRef;
  }

  /** The wallet payment behind a purchase, in the state the provider's record left it. */
  async function paymentRow(paymentRef: string, payer: string, status: string) {
    await h.prisma.walletPayment.create({
      data: {
        id: paymentRef,
        payerWawuUserId: payer,
        kind: 'tier',
        targetId: `tier-${small.id}`,
        title: small.name,
        priceKobo: 100000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 100000n,
        payeeShareKobo: 0n,
        wawuShareKobo: 100000n,
        customerReference: `ref02-${paymentRef}`,
        merchantAccountNumber: MERCHANT_ACCOUNT,
        status,
      },
    });
  }

  /** The refund hold a tier payment gets when it is paid back (TIER-03). */
  async function refundHold(paymentRef: string, payer: string) {
    await paymentRow(paymentRef, payer, 'completed');
    await h.prisma.walletHold.create({
      data: {
        paymentId: paymentRef,
        payerWawuUserId: payer,
        kind: 'tier',
        targetId: `tier-${small.id}`,
        title: small.name,
        releaseCondition: 'refund',
        amountKobo: 100000n,
        payeeShareKobo: 0n,
        wawuShareKobo: 100000n,
        merchantAccountNumber: MERCHANT_ACCOUNT,
        heldAt: new Date(),
      },
    });
  }

  /** A signed-in person known to the referral tables, with no wallet. */
  async function person(): Promise<Person> {
    const p = await h.walletless();
    refPeople.push(p.id);
    return p;
  }

  async function setSetting(key: string, value: unknown) {
    settingKeys.push(key);
    await h.prisma.planSetting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });
    await settings.refresh();
  }
  async function clearSettings() {
    await h.prisma.planSetting.deleteMany({
      where: { key: { in: settingKeys } },
    });
    settingKeys.length = 0;
    await settings.refresh();
  }

  beforeAll(async () => {
    h = await bootTierApp('ref02');
    call = api(h);
    referrals = h.get(ReferralsService);
    rewards = h.get(ReferralRewardService);
    settings = h.get(PlanSettingsService);
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 1_000_000_000);
  });

  afterAll(async () => {
    const ids = [...new Set([...refPeople, ...h.users])];
    await clearSettings();
    await h.prisma.referralMilestone.deleteMany({
      where: { referrerWawuUserId: { in: ids } },
    });
    await h.prisma.referralReward.deleteMany({
      where: { referrerWawuUserId: { in: ids } },
    });
    await h.prisma.personReferral.deleteMany({
      where: { referrerWawuUserId: { in: ids } },
    });
    await h.prisma.personReferralCode.deleteMany({
      where: { wawuUserId: { in: ids } },
    });
    await h.prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: ids } },
    });
    await h.prisma.referralCode.deleteMany({
      where: { code: { in: joinCodes } },
    });
    h.users.push(...refPeople);
    await h.close();
  });

  // -------------------------------------------------------------------------
  describe('GET /me/referrals: the code and the figures', () => {
    it('needs a signed-in caller', async () => {
      await request(h.app.getHttpServer())
        .get('/api/hub/me/referrals')
        .expect(401);
      await request(h.app.getHttpServer())
        .post('/api/hub/me/referrals/claim')
        .send({ code: 'ABC' })
        .expect(401);
    });

    it("a new person gets a code from their name, a link, and the plan's figures", async () => {
      const p = await person();
      const res = await get(p).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const v = body<MyReferralsView>(res).data!;
      expect(v.code).toMatch(/^POLL\d*$/);
      expect(v.link).toBe(`wawu/r/${v.code.toLowerCase()}`);
      expect(v).toMatchObject({
        brought: 0,
        verified: 0,
        pending: 0,
        pointsEarned: 0,
        pendingPoints: 0,
        multiplier: 1,
        level: 0,
        holdDays: config.referral.holdDays,
        claimDays: 7,
        rewards: [],
      });
      expect(v.ladder).toEqual(
        config.referral.levels.map((l) => ({
          verified: l.min,
          multiplier: l.x,
          reached: false,
        })),
      );
      expect(v.nextMilestone).toEqual({
        verified: 5,
        points: 500,
        remaining: 5,
      });
      expect(
        v.milestones.map((m) => [m.verified, m.points, m.reached]),
      ).toEqual(
        config.referral.milestones.map((m) => [m.count, m.points, false]),
      );
      // The same code every time; another person's is another.
      expect((await view(p)).code).toBe(v.code);
      const other = await person();
      expect((await view(other)).code).not.toBe(v.code);
    });

    it('twenty first requests at once make one code', async () => {
      const p = await person();
      const all = await Promise.all(Array.from({ length: 20 }, () => get(p)));
      const codes = new Set(
        all.map((r) => body<MyReferralsView>(r).data!.code),
      );
      expect(all.every((r) => r.status === 200)).toBe(true);
      expect(codes.size).toBe(1);
      expect(
        await h.prisma.personReferralCode.count({
          where: { wawuUserId: p.id },
        }),
      ).toBe(1);
    });

    it('never hands out a code the /join registration link already uses', async () => {
      await h.prisma.referralCode.create({
        data: { code: 'QUILLFEATH', community: 'ref02 spec', priceKobo: 0 },
      });
      joinCodes.push('QUILLFEATH');
      const id = randomUUID();
      refPeople.push(id);
      const code = await referrals.ensureCode(id, 'Quillfeather');
      expect(code).not.toBe('QUILLFEATH');
      expect(code).toMatch(/^QUILLFEATH\d+$/);
    });

    it('a name with no letters still gets a code', async () => {
      const id = randomUUID();
      refPeople.push(id);
      expect(await referrals.ensureCode(id, '12 !')).toMatch(/^[A-Z2-9]{8}$/);
    });
  });

  // -------------------------------------------------------------------------
  describe('POST /me/referrals/claim', () => {
    let referrer: Person;
    beforeAll(async () => {
      referrer = await person();
    });

    it('answers 404 for a code nobody has, and for text that is no code', async () => {
      const p = await person();
      for (const code of ['NOSUCHCODE', '!!', 'ab', 'x'.repeat(60)]) {
        const res = await claimRoute(p, code);
        expect(res.status).toBe(code.length > 80 ? 400 : 404);
        if (res.status === 404)
          expect(reasonOf(res).code).toBe('referral_code_unknown');
      }
      await request(h.app.getHttpServer())
        .post('/api/hub/me/referrals/claim')
        .set('Authorization', p.auth)
        .send({})
        .expect(400);
    });

    it('refuses your own code', async () => {
      const own = (await view(referrer)).code;
      const res = await claimRoute(referrer, own).expect(400);
      expect(reasonOf(res).code).toBe('referral_own_code');
      expect(messageOf(res)).not.toContain(EM_DASH);
      expect(
        await h.prisma.personReferral.count({
          where: { referredWawuUserId: referrer.id },
        }),
      ).toBe(0);
    });

    it('claims once, by code or by link, in any case; the same code again changes nothing', async () => {
      const code = (await view(referrer)).code;
      const a = await person();
      const first = await claimRoute(a, `wawu/r/${code.toLowerCase()}`).expect(
        200,
      );
      const claim = body<ClaimReferralView>(first).data!;
      expect(claim.code).toBe(code);
      const again = await claimRoute(a, code.toLowerCase()).expect(200);
      expect(body<ClaimReferralView>(again).data).toEqual(claim);
      expect((await view(referrer)).brought).toBe(1);
      const row = await h.prisma.personReferral.findUniqueOrThrow({
        where: { referredWawuUserId: a.id },
      });
      expect(row.referrerWawuUserId).toBe(referrer.id);
    });

    it('refuses a second, different code', async () => {
      const a = await person();
      const other = await person();
      await claimRoute(a, (await view(referrer)).code).expect(200);
      const res = await claimRoute(a, (await view(other)).code).expect(409);
      expect(reasonOf(res).code).toBe('referral_already_claimed');
      expect((await view(other)).brought).toBe(0);
    });

    it('refuses the code of someone you invited (one level only, no loops)', async () => {
      const x = await person();
      const y = await person();
      await claimRoute(y, (await view(x)).code).expect(200);
      const res = await claimRoute(x, (await view(y)).code).expect(409);
      expect(reasonOf(res).code).toBe('referral_loop');
    });

    it('twenty claims at once make one claim; crossed claims make one', async () => {
      const a = await person();
      const code = (await view(referrer)).code;
      const all = await Promise.all(
        Array.from({ length: 20 }, () => claimRoute(a, code)),
      );
      expect(all.every((r) => r.status === 200)).toBe(true);
      expect(
        await h.prisma.personReferral.count({
          where: { referredWawuUserId: a.id },
        }),
      ).toBe(1);

      const p = await person();
      const q = await person();
      const [pc, qc] = [(await view(p)).code, (await view(q)).code];
      const crossed = await Promise.all([claimRoute(p, qc), claimRoute(q, pc)]);
      expect(crossed.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('twenty different people use one code at once', async () => {
      const boss = await person();
      const code = (await view(boss)).code;
      const crowd = await Promise.all(
        Array.from({ length: 20 }, () => person()),
      );
      const all = await Promise.all(crowd.map((p) => claimRoute(p, code)));
      expect(all.every((r) => r.status === 200)).toBe(true);
      expect((await view(boss)).brought).toBe(20);
    });

    it('refuses someone who has already paid for a tier', async () => {
      const p = await person();
      await paid(p.id);
      const res = await claimRoute(p, (await view(referrer)).code).expect(409);
      expect(reasonOf(res).code).toBe('referral_not_new');
    });

    it("refuses after the setting's days from sign-up, and follows the setting", async () => {
      const p = await person();
      await h.prisma.userProfile.create({
        data: {
          wawuUserId: p.id,
          accountType: 'user',
          createdAt: new Date(Date.now() - 10 * DAY),
        },
      });
      const code = (await view(referrer)).code;
      const closed = await claimRoute(p, code).expect(409);
      expect(reasonOf(closed)).toMatchObject({
        code: 'referral_claim_closed',
        claimDays: 7,
      });
      expect(messageOf(closed)).not.toContain(EM_DASH);
      await setSetting('referral.claim_days', 30);
      try {
        expect((await view(referrer)).claimDays).toBe(30);
        await claimRoute(p, code).expect(200);
      } finally {
        await clearSettings();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the reward', () => {
    it('a new person who claims a code and buys a tier makes one pending reward, paid after the hold, once', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const buyer = await h.buyer(RICH);
      refPeople.push(buyer.id);
      await claimRoute(buyer, (await view(referrer)).code).expect(200);

      const q = body<PlanPurchaseQuoteView>(
        await call.quote(buyer, { kind: 'tier', tierId: small.id }),
      ).data!;
      const bought = await call.buy(buyer, {
        kind: 'tier',
        tierId: small.id,
        method: 'wallet',
        expectedTotalKobo: q.payment.totalKobo,
        quoteToken: q.payment.quoteToken,
      });
      expect(bought.status).toBe(201);

      const before = Date.now();
      const v = await view(referrer);
      expect(v).toMatchObject({
        brought: 1,
        verified: 0,
        pending: 1,
        pendingPoints: BASE[small.id],
        pointsEarned: 0,
      });
      expect(v.rewards).toHaveLength(1);
      expect(v.rewards[0]).toMatchObject({
        tierId: small.id,
        tierName: small.name,
        basePoints: BASE[small.id],
        multiplier: 1,
        points: BASE[small.id],
        state: 'pending',
        settledAt: null,
      });
      const due = Date.parse(v.rewards[0].availableAt);
      expect(due).toBeGreaterThan(before + 6.9 * DAY);
      expect(due).toBeLessThan(Date.now() + 7.1 * DAY);
      expect(await balance(referrer)).toBe(0);

      // Inside the hold nothing is paid.
      await rewards.release(new Date(Date.now() + 6 * DAY));
      expect(await balance(referrer)).toBe(0);
      expect((await view(referrer)).pending).toBe(1);

      // After it, once.
      const later = new Date(Date.now() + 8 * DAY);
      await rewards.release(later);
      await rewards.release(later);
      expect(await balance(referrer)).toBe(BASE[small.id]);
      const after = await view(referrer);
      expect(after).toMatchObject({
        verified: 1,
        pending: 0,
        pendingPoints: 0,
        pointsEarned: BASE[small.id],
        level: 1,
      });
      expect(after.rewards[0].state).toBe('available');
      expect(after.rewards[0].settledAt).not.toBeNull();
      const lot = await h.prisma.pointLot.findFirstOrThrow({
        where: { wawuUserId: referrer.id, source: 'referral' },
      });
      expect(lot.sourceRef).toBe(`reward:${after.rewards[0].id}`);
      expect(lot.quantity).toBe(BASE[small.id]);
      // The points last the setting's months (12), like every lot.
      expect(lot.expiresAt.getTime() - later.getTime()).toBe(365 * DAY);
      // The invited person is named for the card; the Hub's stand-in may not know them.
      expect(typeof after.rewards[0].name).toBe('string');
    });

    it('parallel tier payments and repeated confirmations make exactly one reward', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      const first = await paid(id, small.id);
      await new Promise((r) => setTimeout(r, 5));
      await paid(id, middle.id);
      const runs = await Promise.all(
        Array.from({ length: 20 }, () => rewards.onTierPaid(id)),
      );
      expect(runs.filter((r) => r === 'pending')).toHaveLength(1);
      const rows = await h.prisma.referralReward.findMany({
        where: { referredWawuUserId: id },
      });
      expect(rows).toHaveLength(1);
      // The first paid tier is the one that counts.
      expect(rows[0]).toMatchObject({ paymentRef: first, tierId: small.id });
      // The job's catch-up and the hook again change nothing.
      expect(await rewards.catchUp()).toBe(0);
      expect(await rewards.onTierPaid(id)).toBe('none');
      expect(
        await h.prisma.referralReward.count({
          where: { referredWawuUserId: id },
        }),
      ).toBe(1);
    });

    it('the job makes a reward the hook missed', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      await paid(id);
      expect(await rewards.catchUp()).toBeGreaterThanOrEqual(1);
      expect(
        await h.prisma.referralReward.count({
          where: { referredWawuUserId: id, state: 'pending' },
        }),
      ).toBe(1);
    });

    it('a person who was not invited, or has not paid, makes no reward', async () => {
      const lone = randomUUID();
      refPeople.push(lone);
      await paid(lone);
      expect(await rewards.onTierPaid(lone)).toBe('none');
      const referrer = await person();
      await giveTier(referrer.id);
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      expect(await rewards.onTierPaid(id)).toBe('none');
      expect(
        await h.prisma.referralReward.count({
          where: { referredWawuUserId: id },
        }),
      ).toBe(0);
    });

    it('a referrer without a running tier earns nothing', async () => {
      const referrer = await person();
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      await paid(id);
      expect(await rewards.onTierPaid(id)).toBe('cancelled');
      const row = await h.prisma.referralReward.findFirstOrThrow({
        where: { referredWawuUserId: id },
      });
      expect(row).toMatchObject({
        state: 'cancelled',
        cancelReason: 'referrer_no_tier',
      });
      await rewards.release(new Date(Date.now() + 30 * DAY));
      expect(await balance(referrer)).toBe(0);
      const v = await view(referrer);
      expect(v).toMatchObject({
        brought: 1,
        verified: 0,
        pending: 0,
        pointsEarned: 0,
      });
      expect(v.rewards[0].state).toBe('cancelled');
    });

    it('a referrer whose tier ended before the hold did earns nothing', async () => {
      const referrer = await person();
      await giveTier(
        referrer.id,
        small.id,
        new Date(Date.now() - 30 * DAY),
        new Date(Date.now() + 2 * DAY),
      );
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      await paid(id);
      expect(await rewards.onTierPaid(id)).toBe('pending');
      await rewards.release(new Date(Date.now() + 8 * DAY));
      const row = await h.prisma.referralReward.findFirstOrThrow({
        where: { referredWawuUserId: id },
      });
      expect(row).toMatchObject({
        state: 'cancelled',
        cancelReason: 'referrer_no_tier',
      });
      expect(await balance(referrer)).toBe(0);
    });

    it('a refund inside the hold cancels the reward, however the Hub learns of it', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const refs: string[] = [];
      for (const id of ids) {
        refPeople.push(id);
        await referrals.claim(id, (await view(referrer)).code);
        refs.push(await paid(id));
        expect(await rewards.onTierPaid(id)).toBe('pending');
      }
      // 1: the refund path tells us.
      expect(await rewards.cancelForPurchase(refs[0])).toBe(true);
      expect(await rewards.cancelForPurchase(refs[0])).toBe(false);
      // 2: a refund hold was written for the payment (TIER-03's refund).
      await refundHold(refs[1], ids[1]);
      // 3: the provider reversed the payment.
      await paymentRow(refs[2], ids[2], 'reversed');
      // 4: the purchase row is gone.
      await h.prisma.makerPurchase.delete({ where: { paymentRef: refs[3] } });
      await rewards.release(new Date(Date.now() + 8 * DAY));
      const rows = await h.prisma.referralReward.findMany({
        where: { referrerWawuUserId: referrer.id },
      });
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.state === 'cancelled')).toBe(true);
      expect(rows.every((r) => r.cancelReason === 'purchase_refunded')).toBe(
        true,
      );
      expect(await balance(referrer)).toBe(0);
      expect((await view(referrer)).pointsEarned).toBe(0);
    });

    it('a refund after the points were paid takes nothing back', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      const ref = await paid(id);
      await rewards.onTierPaid(id);
      await rewards.release(new Date(Date.now() + 8 * DAY));
      expect(await rewards.cancelForPurchase(ref)).toBe(false);
      expect(await balance(referrer)).toBe(BASE[small.id]);
    });

    it('levels, the milestone and the next one: each milestone is paid once', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const invited: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = randomUUID();
        invited.push(id);
        refPeople.push(id);
        await referrals.claim(id, (await view(referrer)).code);
        await paid(id);
        expect(await rewards.onTierPaid(id)).toBe('pending');
      }
      const later = new Date(Date.now() + 8 * DAY);
      await Promise.all([rewards.release(later), rewards.release(later)]);
      const v = await view(referrer);
      expect(v).toMatchObject({
        brought: 5,
        verified: 5,
        pending: 0,
        // 5 rewards (all made at x1) and the +500 milestone.
        pointsEarned: 5 * BASE[small.id] + 500,
        multiplier: 1.25,
        level: 2,
      });
      expect(v.nextMilestone).toEqual({
        verified: 10,
        points: 1500,
        remaining: 5,
      });
      expect(v.milestones[0]).toMatchObject({
        verified: 5,
        points: 500,
        reached: true,
      });
      expect(v.milestones[0].grantedAt).not.toBeNull();
      expect(await balance(referrer)).toBe(5 * BASE[small.id] + 500);
      const lots = await h.prisma.pointLot.findMany({
        where: { wawuUserId: referrer.id, source: 'referral' },
      });
      expect(lots).toHaveLength(6);
      expect(
        lots.filter((l) => l.sourceRef.startsWith('milestone:')),
      ).toHaveLength(1);
      await rewards.release(later);
      expect(await balance(referrer)).toBe(5 * BASE[small.id] + 500);

      // The sixth person pays at the level the five earned: x1.25.
      const sixth = randomUUID();
      refPeople.push(sixth);
      await referrals.claim(sixth, (await view(referrer)).code);
      await paid(sixth);
      await rewards.onTierPaid(sixth);
      const row = await h.prisma.referralReward.findFirstOrThrow({
        where: { referredWawuUserId: sixth },
      });
      expect(row).toMatchObject({
        multiplierMilli: 1250,
        points: Math.round(BASE[small.id] * 1.25),
      });
    });

    it('the figures are the admin settings: hold days, base points, multipliers, milestones, life of the points', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      await setSetting('referral.hold_days', 3);
      await setSetting(`referral.base_points.${small.id}`, 40);
      await setSetting('referral.multipliers', [{ min: 1, x: 3 }]);
      await setSetting('referral.milestones', [{ count: 1, points: 77 }]);
      await setSetting('points.expiry_months', 6);
      try {
        const id = randomUUID();
        refPeople.push(id);
        await referrals.claim(id, (await view(referrer)).code);
        await paid(id);
        await rewards.onTierPaid(id);
        const row = await h.prisma.referralReward.findFirstOrThrow({
          where: { referredWawuUserId: id },
        });
        expect(row).toMatchObject({
          basePoints: 40,
          multiplierMilli: 1000,
          points: 40,
        });
        expect(
          row.availableAt.getTime() - row.createdAt.getTime(),
        ).toBeLessThan(3.01 * DAY);
        expect(
          row.availableAt.getTime() - row.createdAt.getTime(),
        ).toBeGreaterThan(2.99 * DAY);
        const later = new Date(Date.now() + 4 * DAY);
        await rewards.release(later);
        // The milestone at 1 verified is paid with the first reward.
        expect(await balance(referrer)).toBe(40 + 77);
        const lot = await h.prisma.pointLot.findFirstOrThrow({
          where: { wawuUserId: referrer.id, source: 'referral' },
        });
        expect(lot.expiresAt.getTime() - later.getTime()).toBe(183 * DAY);
        const v = await view(referrer);
        expect(v).toMatchObject({
          holdDays: 3,
          multiplier: 3,
          nextMilestone: null,
        });
        expect(v.ladder).toEqual([
          { verified: 1, multiplier: 3, reached: true },
        ]);
      } finally {
        await clearSettings();
      }
    });

    it('the database refuses what the code never does', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      await paid(id);
      await rewards.onTierPaid(id);
      const row = await h.prisma.referralReward.findFirstOrThrow({
        where: { referredWawuUserId: id },
      });
      // A pending reward keeps its figures.
      await expect(
        h.prisma.referralReward.update({
          where: { id: row.id },
          data: { basePoints: 9999, points: 9999 },
        }),
      ).rejects.toThrow();
      // A second reward for one referral.
      await expect(
        h.prisma.referralReward.create({
          data: { ...stripId(row), id: randomUUID() },
        }),
      ).rejects.toThrow();
      // Points that are not base times multiplier.
      await expect(
        h.prisma.referralReward.create({
          data: {
            ...stripId(row),
            id: randomUUID(),
            referralId: randomUUID(),
            points: 1,
          },
        }),
      ).rejects.toThrow();
      // A settled reward never changes.
      await rewards.cancelForPurchase(row.paymentRef);
      await expect(
        h.prisma.referralReward.update({
          where: { id: row.id },
          data: { state: 'pending', settledAt: null, cancelReason: null },
        }),
      ).rejects.toThrow();
      // Nobody is invited by themselves.
      await expect(
        h.prisma.personReferral.create({
          data: {
            referrerWawuUserId: id,
            referredWawuUserId: id,
            code: 'SELF',
          },
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('nothing is held across a network call', () => {
    it('twenty views at once with a slow WAWU ID do not slow anyone else down', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      await paid(id);
      await rewards.onTierPaid(id);

      const slow = jest
        .spyOn(h.get(WawuIdClient), 'lookupPublicIdentities')
        .mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 3000));
          return new Map();
        });
      try {
        const other = await person();
        const burst = Promise.all(
          Array.from({ length: 20 }, () => get(referrer)),
        );
        await new Promise((r) => setTimeout(r, 300));
        const t0 = Date.now();
        await request(h.app.getHttpServer())
          .get('/api/hub/me/points')
          .set('Authorization', other.auth)
          .expect(200);
        await get(other).expect(200);
        const took = Date.now() - t0;
        const done = await burst;
        expect(done.every((r) => r.status === 200)).toBe(true);
        expect(took).toBeLessThan(1000);
        expect(slow).toHaveBeenCalled();
      } finally {
        slow.mockRestore();
      }
    });

    it('twenty claims and tier payments at once, with a slow provider, still answer quickly for another person', async () => {
      const referrer = await person();
      await giveTier(referrer.id);
      const code = (await view(referrer)).code;
      const crowd = await Promise.all(
        Array.from({ length: 20 }, () => h.buyer(RICH)),
      );
      refPeople.push(...crowd.map((c) => c.id));
      // The provider answers each transfer after 3 seconds.
      const routes = (
        h.double as unknown as {
          routes: Array<{
            method: string;
            path: string | RegExp;
            handler: (req: SeenRequest) => CannedAnswer | Promise<CannedAnswer>;
          }>;
        }
      ).routes;
      const original = routes.find(
        (r) =>
          r.method === 'POST' && r.path === '/transaction/wallet-to-wallet',
      )!.handler;
      h.double.on('POST', '/transaction/wallet-to-wallet', async (req) => ({
        ...(await original(req)),
        delayMs: 3000,
      }));
      try {
        const work = Promise.all(
          crowd.map(async (c) => {
            const claim = await claimRoute(c, code);
            const q = body<PlanPurchaseQuoteView>(
              await call.quote(c, { kind: 'tier', tierId: small.id }),
            ).data!;
            const buy = await call.buy(c, {
              kind: 'tier',
              tierId: small.id,
              method: 'wallet',
              expectedTotalKobo: q.payment.totalKobo,
              quoteToken: q.payment.quoteToken,
            });
            return [claim.status, buy.status] as const;
          }),
        );
        await new Promise((r) => setTimeout(r, 1200));
        const other = await person();
        const t0 = Date.now();
        await get(other).expect(200);
        expect(Date.now() - t0).toBeLessThan(1000);
        const results = await work;
        expect(results.every(([c, b]) => c === 200 && b === 201)).toBe(true);
        expect(
          await h.prisma.referralReward.count({
            where: { referrerWawuUserId: referrer.id, state: 'pending' },
          }),
        ).toBe(20);
      } finally {
        installFintava(h.double, h.wallets);
      }
    });
  });

  describe('the job', () => {
    it('settles due rewards and survives being run twice at once', async () => {
      const sweep = h.get(ReferralSweepService);
      const referrer = await person();
      await giveTier(referrer.id);
      const id = randomUUID();
      refPeople.push(id);
      await referrals.claim(id, (await view(referrer)).code);
      await paid(id);
      await sweep.run();
      await Promise.all([
        sweep.run(new Date(Date.now() + 8 * DAY)),
        sweep.run(new Date(Date.now() + 8 * DAY)),
      ]);
      expect(await balance(referrer.id)).toBe(BASE[small.id]);
    });
  });
});

type RewardRow = Awaited<
  ReturnType<TierHarness['prisma']['referralReward']['findFirstOrThrow']>
>;
function stripId(row: RewardRow) {
  const { id: _id, ...rest } = row;
  void _id;
  return rest;
}
