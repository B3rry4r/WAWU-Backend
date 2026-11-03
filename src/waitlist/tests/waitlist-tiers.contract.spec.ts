// The spec reads response bodies and edits an untyped copy of the plans file.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlansConfig, priceIn, tierById } from '../../plans/plans-config';
import { TierGrantService } from '../../plans/tier-grant.service';
import { giveTierPurchase } from '../../plans/tier-purchase-grant';
import { purgePersonPoints } from '../../points/points-purge';
import { ReferralAdminService } from '../referral/referral-admin.service';
import { WaitlistService, newReference } from '../waitlist.service';
import { waitlistHeaderLine, waitlistLine } from '../waitlist-export';
import {
  bootWaitlist,
  configWith,
  DAY,
  OFFER_ID,
  openOffer,
  ScriptedFlutterwave,
} from './waitlist-harness';

/**
 * JOIN-TIERS-HUB (R-125) over HTTP: /join sells the app's three tiers, a code
 * prices one tier, and a paid registration is claimed automatically by the
 * signed-in person whose PROVEN email or phone it holds. The real WaitlistModule
 * (PlansModule behind it, so the app's own `GET /me/tier` is served), a real
 * database, real RS256 tokens against the stand-in WAWU ID. Flutterwave is the
 * repo's scripted stand-in; nothing moves in the Hub ledger.
 */

const MARK = 'jointiers-spec';
const WHO = 'jt-claimant-';
const CODE = 'JTSPECV';
const CAP = 'JTCAPV';
const ADMIN_CODES = ['JTADMV', 'JTADMP'];

type Envelope<T> = { statusCode: number; message: string; data: T };
const data = <T = any>(res: Response): T => (res.body as Envelope<T>).data;
const reason = (res: Response) => res.body.reason;

interface Who {
  sub: string;
  phone: string;
  email: string;
}

let seq = 0;
const next = () => {
  seq += 1;
  return `${process.pid}${Date.now() % 100000}${seq}`
    .slice(-9)
    .padStart(9, '0');
};

function mint(
  who: Who,
  flags: Record<string, unknown> = { phoneVerified: true, emailVerified: true },
  over: Record<string, unknown> = {},
): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub: who.sub,
      email: who.email,
      phone: who.phone,
      firstName: 'Tier',
      lastName: 'Tester',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
      ...flags,
      ...over,
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

describe('/join sells the three tiers (JOIN-TIERS-HUB, R-125) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let config: PlansConfig;
  const fake = new ScriptedFlutterwave();
  const http = () => request(app.getHttpServer());
  const subs = new Set<string>();
  let tx = 7_000_000;

  const price = (id: string) => priceIn(tierById(config, id)!.price, 'NGN');

  const person = (): Who => {
    const n = next();
    const sub = `${WHO}${n}`;
    subs.add(sub);
    return {
      sub,
      phone: `+23480${n.slice(-8)}`,
      email: `${MARK}-${n}@test.wawu.dev`,
    };
  };

  const body = (who: Pick<Who, 'phone' | 'email'>, over: object = {}) => ({
    offerId: OFFER_ID,
    fullName: `Tier Buyer ${MARK}`,
    phone: who.phone,
    email: who.email,
    consent: true,
    ...over,
  });
  const register = (b: object) =>
    http().post('/api/hub/waitlist/registrations').send(b);

  /** A paid registration written straight to the table (the payment is Flutterwave's, scripted elsewhere). */
  const paidRow = async (
    who: Pick<Who, 'phone' | 'email'>,
    tier: string | null,
    over: Record<string, unknown> = {},
  ) => {
    const reference = newReference();
    const kobo = tier === null ? 200000 : price(tier);
    return prisma.waitlistRegistration.create({
      data: {
        offerId: OFFER_ID,
        fullName: `Registered Name ${MARK}`,
        phone: who.phone,
        email: who.email,
        consentAt: new Date(),
        reference,
        amountKobo: kobo,
        status: 'paid',
        flutterwaveTxId: `jt-${reference.slice(-14)}`,
        paidKobo: kobo,
        paidAt: new Date(Date.now() - 2 * DAY),
        ...(tier === null ? {} : { tier }),
        ...over,
      } as never,
    });
  };

  const pay = async (reference: string, amountKobo: number) => {
    tx += 1;
    fake.payments.set(String(tx), {
      status: 'successful',
      amount: amountKobo / 100,
      currency: 'NGN',
      txRef: reference,
    });
    await http()
      .post('/api/hub/waitlist/registrations/verify')
      .send({ reference, transactionId: String(tx) })
      .expect(200);
  };

  const myTier = (token: string) =>
    http().get('/api/hub/me/tier').set('Authorization', `Bearer ${token}`);

  const wipe = async () => {
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    await prisma.referralCode.deleteMany({
      where: { code: { in: [CODE, CAP, ...ADMIN_CODES] } },
    });
    for (const sub of subs) {
      await purgePersonPoints(prisma, sub);
      await prisma.eventPass.deleteMany({ where: { wawuUserId: sub } });
      await prisma.makerPurchase.deleteMany({ where: { wawuUserId: sub } });
      await prisma.makerTier.deleteMany({ where: { wawuUserId: sub } });
      await prisma.walletIdentity.deleteMany({ where: { wawuUserId: sub } });
    }
    await prisma.pointLot.deleteMany({
      where: { wawuUserId: { startsWith: WHO } },
    });
  };

  beforeAll(async () => {
    config = configWith((raw) => {
      raw.event_offers = [openOffer()];
    });
    app = await bootWaitlist(config, fake);
    prisma = app.get(PrismaService);
    await wipe();
    await prisma.referralCode.create({
      data: {
        code: CODE,
        community: `${MARK} community`,
        priceKobo: 120000,
        tier: 'verify',
      },
    });
    await prisma.referralCode.create({
      data: {
        code: CAP,
        community: `${MARK} cap`,
        priceKobo: 120000,
        usageLimit: 1,
        tier: 'verify',
      },
    });
  });

  afterAll(async () => {
    await wipe();
    await app.close();
  });

  beforeEach(() => fake.reset());

  describe('GET /waitlist/tiers', () => {
    it('is public and answers the app tiers at the live prices, Founding the best', async () => {
      const res = await http().get('/api/hub/waitlist/tiers').expect(200);
      const view = data(res);
      expect(view.currency).toBe('NGN');
      expect(view.bestTier).toBe('founding');
      expect(view.tiers.map((t: any) => t.id)).toEqual(
        config.tiers.map((t) => t.id),
      );
      for (const t of view.tiers) {
        const cfg = tierById(config, t.id)!;
        expect(t).toMatchObject({
          name: cfg.name,
          priceKobo: priceIn(cfg.price, 'NGN'),
          days: cfg.days,
          products: cfg.products,
          bonusPoints: cfg.bonusPoints,
          packBonusPercent: cfg.packBonusPct,
          badge: { id: cfg.badge.id, numbered: cfg.badge.numbered },
          best: t.id === 'founding',
        });
        expect(typeof t.eventPass.name).toBe('string');
      }
      expect(
        view.tiers.find((t: any) => t.id === 'founding').badge.numbered,
      ).toBe(true);
    });
  });

  describe('registering with a tier', () => {
    it.each(['verify', 'plus', 'founding'])(
      'charges the live price of %s and records the tier',
      async (id) => {
        const who = person();
        const res = await register(body(who, { tier: id })).expect(200);
        const view = data(res);
        expect(view.amountKobo).toBe(price(id));
        expect(view.flutterwaveConfig.amount).toBe(price(id) / 100);
        expect(view.tier).toBe(id);
        const row = await prisma.waitlistRegistration.findUniqueOrThrow({
          where: { reference: view.reference },
        });
        expect(row.tier).toBe(id);
        expect(row.amountKobo).toBe(price(id));
      },
    );

    it('refuses a tier the plans do not sell', async () => {
      const res = await register(body(person(), { tier: 'gold' })).expect(400);
      expect(reason(res).code).toBe('tier_invalid');
    });

    it('an older page with no tier behaves as it did: the offer price, no tier on the row, no tier in the answer', async () => {
      const who = person();
      const res = await register(body(who)).expect(200);
      const view = data(res);
      expect(view.amountKobo).toBe(config.eventOffers[0].priceKobo);
      expect('tier' in view).toBe(false);
      const row = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { reference: view.reference },
      });
      expect(row.tier).toBeNull();
    });
  });

  describe('the code, per tier', () => {
    it('applies to the tier it prices: the code price, attributed', async () => {
      const who = person();
      const view = data(
        await register(
          body(who, { tier: 'verify', referralCode: CODE.toLowerCase() }),
        ).expect(200),
      );
      expect(view.referral).toEqual({ code: CODE, applied: true });
      expect(view.amountKobo).toBe(120000);
      const row = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { reference: view.reference },
      });
      expect(row).toMatchObject({ tier: 'verify', referralCode: CODE });
    });

    it.each(['plus', 'founding'])(
      'does not apply to %s: full price, not attributed',
      async (id) => {
        const who = person();
        const view = data(
          await register(body(who, { tier: id, referralCode: CODE })).expect(
            200,
          ),
        );
        expect(view.referral).toEqual({
          code: CODE,
          applied: false,
          reason: 'other_tier',
        });
        expect(view.amountKobo).toBe(price(id));
        const row = await prisma.waitlistRegistration.findUniqueOrThrow({
          where: { reference: view.reference },
        });
        expect(row.referralCode).toBeNull();
      },
    );

    it('with no tier (an older page) a Verify code prices the offer exactly as before', async () => {
      const view = data(
        await register(body(person(), { referralCode: CODE })).expect(200),
      );
      expect(view.referral).toEqual({ code: CODE, applied: true });
      expect(view.amountKobo).toBe(120000);
    });

    it('the check answers per tier, and exactly as before without ?tier=', async () => {
      const plain = data(
        await http()
          .get(`/api/hub/waitlist/referral-codes/${CODE}`)
          .expect(200),
      );
      expect(plain).toEqual({ code: CODE, applies: true, priceKobo: 120000 });
      const v = data(
        await http()
          .get(`/api/hub/waitlist/referral-codes/${CODE}?tier=verify`)
          .expect(200),
      );
      expect(v).toMatchObject({
        applies: true,
        priceKobo: 120000,
        tier: 'verify',
        forTier: 'verify',
      });
      const p = data(
        await http()
          .get(`/api/hub/waitlist/referral-codes/${CODE}?tier=plus`)
          .expect(200),
      );
      expect(p).toMatchObject({
        applies: false,
        reason: 'other_tier',
        priceKobo: price('plus'),
        forTier: 'verify',
      });
      expect(p.message).toContain('Verify');
      expect(p.message).not.toContain('—');
    });

    it('a code at its cap gives the standard price of the tier', async () => {
      // The code allows one place; one paid registration holds it.
      await prisma.waitlistRegistration.deleteMany({
        where: { referralCode: CAP },
      });
      const first = person();
      const v1 = data(
        await register(
          body(first, { tier: 'verify', referralCode: CAP }),
        ).expect(200),
      );
      await pay(v1.reference, v1.amountKobo);
      const second = data(
        await register(
          body(person(), { tier: 'verify', referralCode: CAP }),
        ).expect(200),
      );
      expect(second.referral).toEqual({
        code: CAP,
        applied: false,
        reason: 'full',
      });
      expect(second.amountKobo).toBe(price('verify'));
      const check = data(
        await http()
          .get(`/api/hub/waitlist/referral-codes/${CAP}?tier=verify`)
          .expect(200),
      );
      expect(check).toMatchObject({
        applies: false,
        reason: 'full',
        priceKobo: price('verify'),
      });
    });

    it('the admin price ceiling is the tier price, per tier; an unbound code keeps the offer ceiling', async () => {
      const admin = new ReferralAdminService(prisma, config);
      const verify = await admin.create(
        {
          code: ADMIN_CODES[0],
          community: `${MARK} a`,
          priceKobo: 250000,
          tier: 'verify',
        },
        null,
      );
      expect(verify.tier).toBe('verify');
      await expect(
        admin.create(
          {
            code: 'JTADMX',
            community: `${MARK} x`,
            priceKobo: price('verify') + 1,
            tier: 'verify',
          },
          null,
        ),
      ).rejects.toMatchObject({ code: 'referral_invalid' });
      const plus = await admin.create(
        {
          code: ADMIN_CODES[1],
          community: `${MARK} p`,
          priceKobo: 500000,
          tier: 'plus',
        },
        null,
      );
      expect(plus.tier).toBe('plus');
      await expect(
        admin.create(
          { code: 'JTADMY', community: `${MARK} y`, priceKobo: 200001 },
          null,
        ),
      ).rejects.toMatchObject({ code: 'referral_invalid' });
      // Moving a code to a cheaper tier re-checks its price.
      await expect(
        admin.update(plus.id, { tier: 'verify', priceKobo: 400000 }),
      ).rejects.toMatchObject({
        code: 'referral_invalid',
      });
      const moved = await admin.update(plus.id, {
        tier: 'verify',
        priceKobo: 280000,
      });
      expect(moved).toMatchObject({ tier: 'verify', priceKobo: 280000 });
    });
  });

  describe('the automatic claim', () => {
    it("gives the tier on the app's own tier read, by a proven email, with no update to the app", async () => {
      const who = person();
      const row = await paidRow(who, 'plus');
      expect(
        data(
          await myTier(
            mint(who, { emailVerified: false, phoneVerified: false }),
          ),
        ).state,
      ).toBe('none');
      const res = await myTier(
        mint(who, { phoneVerified: false, emailVerified: true }),
      ).expect(200);
      const tier = data(res);
      const plus = tierById(config, 'plus')!;
      expect(tier).toMatchObject({
        state: 'active',
        tier: { id: 'plus', name: plus.name },
        productsAllowed: plus.products,
        pointsIncluded: plus.bonusPoints,
      });
      const days =
        (new Date(tier.activeUntil).getTime() -
          new Date(tier.activeFrom).getTime()) /
        DAY;
      expect(days).toBe(plus.days);
      const claimed = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(claimed).toMatchObject({
        claimedByWawuId: who.sub,
        claimedVia: 'auto',
      });
      const purchase = await prisma.makerPurchase.findUniqueOrThrow({
        where: { paymentRef: `join:${row.id}` },
      });
      expect(purchase).toMatchObject({
        wawuUserId: who.sub,
        kind: 'tier',
        tierId: 'plus',
        method: 'web_join',
        amountMinor: price('plus'),
        currency: 'NGN',
      });
    });

    it('also works by a proven phone, and the tier offer read claims too', async () => {
      const who = person();
      const row = await paidRow(who, 'verify');
      await http()
        .get('/api/hub/me/tier-offer')
        .set(
          'Authorization',
          `Bearer ${mint(who, { phoneVerified: true, emailVerified: false })}`,
        )
        .expect(200);
      const claimed = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(claimed.claimedVia).toBe('auto');
      expect(data(await myTier(mint(who))).tier.id).toBe('verify');
    });

    it('claims the Hub BVN-checked wallet phone as a proof', async () => {
      const who = person();
      await paidRow(who, 'verify');
      await prisma.walletIdentity.create({
        data: {
          wawuUserId: who.sub,
          verifiedPhone: who.phone,
          bvnVerifiedAt: new Date(),
        } as never,
      });
      const res = await myTier(
        mint(who, { phoneVerified: false, emailVerified: false }),
      ).expect(200);
      expect(data(res).tier.id).toBe('verify');
    });

    it('gives nothing for a contact that was only typed', async () => {
      const who = person();
      const row = await paidRow(who, 'founding');
      const res = await myTier(
        mint(who, { phoneVerified: false, emailVerified: false }),
      ).expect(200);
      expect(data(res).state).toBe('none');
      const same = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(same.claimedByWawuId).toBeNull();
    });

    it("never gives one person's payment to another, proven or not", async () => {
      const buyer = person();
      const stranger = person();
      const row = await paidRow(buyer, 'founding');
      const res = await myTier(mint(stranger)).expect(200);
      expect(data(res).state).toBe('none');
      expect(
        (
          await prisma.waitlistRegistration.findUniqueOrThrow({
            where: { id: row.id },
          })
        ).claimedByWawuId,
      ).toBeNull();
    });

    it('does not claim an unpaid or refunded registration', async () => {
      const who = person();
      await paidRow(who, 'verify', {
        status: 'pending',
        paidKobo: null,
        paidAt: null,
        flutterwaveTxId: null,
      });
      expect(data(await myTier(mint(who))).state).toBe('none');
    });

    it('claims once: asking again changes nothing', async () => {
      const who = person();
      const row = await paidRow(who, 'verify');
      const token = mint(who);
      const first = data(await myTier(token).expect(200));
      const again = data(await myTier(token).expect(200));
      expect(again.activeUntil).toBe(first.activeUntil);
      expect(
        await prisma.makerPurchase.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
      expect(
        await prisma.eventPass.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
      expect(
        await prisma.pointLot.count({
          where: { wawuUserId: who.sub, sourceRef: `join:${row.id}` },
        }),
      ).toBe(1);
    });

    it('two reads at once claim once', async () => {
      const who = person();
      await paidRow(who, 'plus');
      const token = mint(who);
      const [a, b, c] = await Promise.all([
        myTier(token),
        myTier(token),
        http()
          .get('/api/hub/me/tier-offer')
          .set('Authorization', `Bearer ${token}`),
      ]);
      expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
      expect(
        await prisma.makerPurchase.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
      expect(
        await prisma.eventPass.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
      expect(data(a).tier.id).toBe('plus');
    });

    it('two registrations for one person: both are claimed, in the order paid, and the bigger tier wins', async () => {
      const who = person();
      const other = {
        phone: `+23481${next().slice(-8)}`,
        email: who.email.replace('@', '-b@'),
      };
      // Registered with the person's phone (Verify, paid first) and, on another
      // registration, their email (Founding, paid later).
      await paidRow({ phone: who.phone, email: other.email }, 'verify', {
        paidAt: new Date(Date.now() - 3 * DAY),
      });
      await paidRow({ phone: other.phone, email: who.email }, 'founding', {
        paidAt: new Date(Date.now() - 1 * DAY),
      });
      const tier = data(await myTier(mint(who)).expect(200));
      expect(tier.tier.id).toBe('founding');
      expect(
        await prisma.waitlistRegistration.count({
          where: { claimedByWawuId: who.sub, claimedVia: 'auto' },
        }),
      ).toBe(2);
      const kinds = (
        await prisma.makerPurchase.findMany({
          where: { wawuUserId: who.sub },
          orderBy: { createdAt: 'asc' },
        })
      ).map((p) => p.kind);
      expect(kinds.sort()).toEqual(['tier', 'upgrade']);
    });

    it("an older registration with no tier is claimed as Verify, for the offer's days", async () => {
      const who = person();
      await paidRow(who, null);
      const tier = data(await myTier(mint(who)).expect(200));
      expect(tier.tier.id).toBe('verify');
      expect(
        (new Date(tier.activeUntil).getTime() -
          new Date(tier.activeFrom).getTime()) /
          DAY,
      ).toBe(30);
    });
  });

  describe('the access code still works', () => {
    it('claims a tier registration with its code, as a store purchase of that tier would', async () => {
      const who = person();
      const row = await paidRow(who, 'founding');
      const res = await http()
        .post('/api/hub/waitlist/claims')
        .set('Authorization', `Bearer ${mint(who)}`)
        .send({ code: row.accessCode })
        .expect(200);
      const view = data(res);
      expect(view.tier.tier.id).toBe('founding');
      expect(view.offerName).toBe(tierById(config, 'founding')!.name);
      const claimed = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(claimed.claimedVia).toBe('code');
      // A repeat is answered from the stored answer, nothing written twice.
      await http()
        .post('/api/hub/waitlist/claims')
        .set('Authorization', `Bearer ${mint(who)}`)
        .send({ code: row.accessCode })
        .expect(200);
      expect(
        await prisma.makerPurchase.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
    });

    it('after an automatic claim, the same person typing the code is answered, not refused', async () => {
      const who = person();
      const row = await paidRow(who, 'verify');
      await myTier(mint(who)).expect(200);
      const res = await http()
        .post('/api/hub/waitlist/claims')
        .set('Authorization', `Bearer ${mint(who)}`)
        .send({ code: row.accessCode })
        .expect(200);
      expect(data(res).tier.tier.id).toBe('verify');
    });
  });

  describe('a store-bought tier, then a web claim', () => {
    const buyInStore = async (who: Who, tierId: string) => {
      const grants = app.get(TierGrantService, { strict: false });
      await prisma.$transaction((tx) =>
        giveTierPurchase(tx, config, grants, {
          wawuUserId: who.sub,
          tierId,
          ref: `store:${MARK}-${who.sub}`,
          method: 'store',
          amountMinor: price(tierId),
          now: new Date(),
        }),
      );
    };

    it('a bigger web tier moves the person up, as a store upgrade would', async () => {
      const who = person();
      await buyInStore(who, 'verify');
      await paidRow(who, 'plus');
      const tier = data(await myTier(mint(who)).expect(200));
      expect(tier.tier.id).toBe('plus');
      const kinds = (
        await prisma.makerPurchase.findMany({ where: { wawuUserId: who.sub } })
      )
        .map((p) => `${p.method}:${p.kind}`)
        .sort();
      expect(kinds).toEqual(['store:tier', 'web_join:upgrade']);
    });

    it('a smaller or equal web tier adds its days to the running one', async () => {
      const who = person();
      await buyInStore(who, 'founding');
      await paidRow(who, 'verify');
      const tier = data(await myTier(mint(who)).expect(200));
      expect(tier.tier.id).toBe('founding');
      const days =
        (new Date(tier.activeUntil).getTime() -
          new Date(tier.activeFrom).getTime()) /
        DAY;
      expect(days).toBe(
        tierById(config, 'founding')!.days + tierById(config, 'verify')!.days,
      );
    });
  });

  describe('what the team sees', () => {
    it('lists the tier and how it was claimed, and splits the summary by tier', async () => {
      const waitlist = app.get(WaitlistService, { strict: false });
      const who = person();
      const row = await paidRow(who, 'plus');
      await myTier(mint(who)).expect(200);
      const list = await waitlist.adminList({
        page: 1,
        perPage: 50,
        offerId: OFFER_ID,
        tier: 'plus',
      });
      const mine = list.items.find((i) => i.id === row.id)!;
      expect(mine).toMatchObject({
        tier: 'plus',
        claimedVia: 'auto',
        claimed: true,
      });
      const summary = await waitlist.adminSummary({ offerId: OFFER_ID });
      expect(summary.byTier.map((t) => t.tier)).toEqual([
        ...config.tiers.map((t) => t.id),
        null,
      ]);
      const plus = summary.byTier.find((t) => t.tier === 'plus')!;
      expect(plus.people).toBeGreaterThanOrEqual(1);
      expect(plus.claimed).toBeGreaterThanOrEqual(1);
    });

    it('the CSV is unchanged unless the team asks for the tier columns, which come last', async () => {
      const who = person();
      const row = await paidRow(who, 'founding');
      const plain = waitlistHeaderLine().trimEnd().split(',');
      const wide = waitlistHeaderLine(true).trimEnd().split(',');
      expect(wide.slice(0, plain.length)).toEqual(plain);
      expect(wide.slice(-2)).toEqual(['Tier', 'Claimed how']);
      expect(waitlistLine(row)).toBe(waitlistLine(row, false));
      expect(waitlistLine(row, true).trimEnd().split(',').slice(-2)).toEqual([
        'founding',
        '',
      ]);
    });
  });
});
