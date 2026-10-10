// The spec reads response bodies and edits an untyped copy of the plans file.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EXPORT_SECTIONS } from '../../data-export-request/data-export-sections';
import { PlansConfig, tierById } from '../../plans/plans-config';
import { purgePersonPoints } from '../../points/points-purge';
import { PointsService } from '../../points/points.service';
import { newReference } from '../waitlist.service';
import {
  bootWaitlist,
  configWith,
  DAY,
  OFFER_ID,
  openOffer,
  ScriptedFlutterwave,
} from './waitlist-harness';

/**
 * JOIN-03 over HTTP: a signed-in person claims the plan a paid registration
 * bought, with its launch access code. The real WaitlistModule (with
 * PlansModule and PointsModule behind it), a real database, and real RS256
 * tokens checked against the stand-in WAWU ID's JWKS (WAWU_ID_JWKS_URL). Every
 * figure compared with is read from the config, never written here.
 *
 * The tokens carry `phoneVerified` and `emailVerified`, the two flags the
 * claim's proof reads (waitlist-claim-proof.ts). WAWU ID does not send them
 * yet (BACKEND_GAPS G-629); a token without them is its own test.
 */

const MARK = 'join03-claim-spec';
const SECOND_OFFER_ID = 'event-spec-second';
const WHO = 'j03-claimant-';
const refs = { n: 0 };

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
  flags: Record<string, unknown> = {
    phoneVerified: true,
    emailVerified: true,
  },
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
      firstName: 'Claim',
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

describe('Claiming a paid event registration in the app (JOIN-03) over HTTP', () => {
  let app: INestApplication<App>;
  let second: INestApplication<App>;
  let prisma: PrismaService;
  let config: PlansConfig;
  const fake = new ScriptedFlutterwave();
  const http = () => request(app.getHttpServer());
  const subs = new Set<string>();

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

  /** A paid registration made with `who`'s phone and email (or the given ones). */
  const registration = async (
    who: Pick<Who, 'phone' | 'email'>,
    over: Record<string, unknown> = {},
  ) => {
    const reference = newReference();
    refs.n += 1;
    const row = await prisma.waitlistRegistration.create({
      data: {
        offerId: OFFER_ID,
        fullName: `Registered Name ${MARK}`,
        phone: who.phone,
        email: who.email,
        consentAt: new Date(),
        reference,
        amountKobo: 200000,
        status: 'paid',
        flutterwaveTxId: `claim-${reference.slice(-14)}`,
        paidKobo: 200000,
        // Paid three weeks ago: the days must count from the claim, not from the payment.
        paidAt: new Date(Date.now() - 21 * DAY),
        ...over,
      } as never,
    });
    return row;
  };

  const claim = (token: string | null, code: string) => {
    const req = http().post('/api/hub/waitlist/claims').send({ code });
    return token === null ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const label = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

  const wipe = async () => {
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    for (const sub of subs) {
      await purgePersonPoints(prisma, sub);
      await prisma.eventPass.deleteMany({ where: { wawuUserId: sub } });
      await prisma.makerTier.deleteMany({ where: { wawuUserId: sub } });
      await prisma.walletIdentity.deleteMany({ where: { wawuUserId: sub } });
    }
    await prisma.pointLot.deleteMany({
      where: {
        sourceRef: { startsWith: 'join:' },
        wawuUserId: { startsWith: WHO },
      },
    });
  };

  beforeAll(async () => {
    config = configWith((raw) => {
      raw.event_offers = [openOffer(), openOffer({ id: SECOND_OFFER_ID })];
    });
    app = await bootWaitlist(config, fake, [], [AccountPurgeService]);
    second = await bootWaitlist(config, fake);
    prisma = app.get(PrismaService);
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await second.close();
    await app.close();
  });

  const verify = tierById(
    configWith((raw) => {
      raw.event_offers = [openOffer()];
    }),
    'verify',
  )!;
  const OFFER_DAYS = 30;

  describe('the claim', () => {
    it('gives what the plan gives, its days counted from the claim, once', async () => {
      const who = person();
      const row = await registration(who);
      const before = Date.now();
      const res = await claim(mint(who), label(row.accessCode)).expect(200);
      const after = Date.now();
      const view = data(res);
      expect(view).toMatchObject({
        offerName: 'Spec event registration',
        days: OFFER_DAYS,
        extended: false,
        pointsGranted: verify.bonusPoints,
      });
      expect(view.tier).toMatchObject({
        state: 'active',
        tier: { id: 'verify', name: verify.name },
        productsAllowed: verify.products,
        pointsIncluded: verify.bonusPoints,
        firstVoiceIntroIncluded: verify.firstVoiceIntro,
      });
      // The days start at the claim, not at the payment.
      const start = new Date(view.tier.activeFrom).getTime();
      const end = new Date(view.tier.activeUntil).getTime();
      expect(start).toBeGreaterThanOrEqual(before - 1000);
      expect(start).toBeLessThanOrEqual(after + 1000);
      expect(end - start).toBe(OFFER_DAYS * DAY);
      // The pass, the points lot and the claim, each written once.
      const pass = await prisma.eventPass.findMany({
        where: { wawuUserId: who.sub },
      });
      expect(pass).toHaveLength(1);
      expect(pass[0]).toMatchObject({
        type: verify.eventPass,
        purchaseRef: `join:${row.id}`,
      });
      expect(view.tier.eventPass).toMatchObject({ id: verify.eventPass });
      const lots = await prisma.pointLot.findMany({
        where: { wawuUserId: who.sub },
      });
      expect(lots).toHaveLength(1);
      expect(lots[0]).toMatchObject({
        source: 'tier_bonus',
        sourceRef: `join:${row.id}`,
        quantity: verify.bonusPoints,
        remaining: verify.bonusPoints,
      });
      expect(lots[0].expiresAt.getTime() - start).toBeLessThan(
        verify.bonusExpiryDays * DAY + 5000,
      );
      expect(new Date(view.pointsExpireAt).getTime()).toBe(
        lots[0].expiresAt.getTime(),
      );
      const claimed = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(claimed.claimedByWawuId).toBe(who.sub);
      expect(claimed.claimedAt).not.toBeNull();
    });

    it('reads the code the way the page shows it: spaces, dashes and lower case', async () => {
      for (const form of [
        (c: string) => c,
        (c: string) => c.toLowerCase(),
        (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`,
        (c: string) => `  ${c.slice(0, 4)}   ${c.slice(4).toLowerCase()} `,
      ]) {
        const who = person();
        const row = await registration(who);
        await claim(mint(who), form(row.accessCode)).expect(200);
      }
    });

    it('works with the verified email alone, or the verified phone alone, whatever else the account holds', async () => {
      const byEmail = person();
      const emailRow = await registration(byEmail);
      // The phone on the account is a different number the person typed: unproven.
      await claim(
        mint(
          { ...byEmail, phone: '+2348099990001' },
          { emailVerified: true, phoneVerified: false },
        ),
        emailRow.accessCode,
      ).expect(200);
      const byPhone = person();
      const phoneRow = await registration(byPhone);
      await claim(
        mint(
          { ...byPhone, email: `other-${byPhone.sub}@test.wawu.dev` },
          { emailVerified: false, phoneVerified: true },
        ),
        phoneRow.accessCode,
      ).expect(200);
    });

    it('matches the phone however the token writes it', async () => {
      for (const write of [
        (e164: string) => e164,
        (e164: string) => `0${e164.slice(4)}`,
        (e164: string) => e164.slice(1),
      ]) {
        const who = person();
        const row = await registration(who);
        await claim(
          mint(
            { ...who, email: `x-${who.sub}@test.wawu.dev` },
            { phoneVerified: true, emailVerified: false },
            { phone: write(who.phone) },
          ),
          row.accessCode,
        ).expect(200);
      }
    });

    it('gives the days the offer says: changing tier_days changes the claim with no code change', async () => {
      const cfg = configWith((raw) => {
        raw.event_offers = [openOffer({ tier_days: 45 })];
      });
      const other = await bootWaitlist(cfg, fake);
      try {
        const who = person();
        const row = await registration(who);
        const res = await request(other.getHttpServer())
          .post('/api/hub/waitlist/claims')
          .set('Authorization', `Bearer ${mint(who)}`)
          .send({ code: row.accessCode })
          .expect(200);
        const t = data(res).tier;
        expect(
          new Date(t.activeUntil).getTime() - new Date(t.activeFrom).getTime(),
        ).toBe(45 * DAY);
        expect(data(res).days).toBe(45);
      } finally {
        await other.close();
      }
    });

    it('answers 401 with no sign-in, and never reads who claims from the body', async () => {
      const who = person();
      const row = await registration(who);
      await claim(null, row.accessCode).expect(401);
      const res = await http()
        .post('/api/hub/waitlist/claims')
        .set('Authorization', `Bearer ${mint(person())}`)
        .send({ code: row.accessCode, wawuUserId: who.sub });
      expect(res.status).toBe(400);
      const still = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(still.claimedByWawuId).toBeNull();
    });
  });

  describe('who may claim: the code alone is never enough', () => {
    it('refuses a person whose phone and email are not proven, and writes nothing (WAWU ID sends no flags today)', async () => {
      const who = person();
      const row = await registration(who);
      for (const flags of [
        {},
        { phoneVerified: false, emailVerified: false },
      ]) {
        const res = await claim(mint(who, flags), row.accessCode).expect(409);
        expect(reason(res).code).toBe('contact_not_verified');
      }
      // The flags must be exactly true: a string or a number is not proof.
      for (const flag of ['true', 1, 'yes', {}]) {
        const res = await claim(
          mint(who, { phoneVerified: flag, emailVerified: flag }),
          row.accessCode,
        ).expect(409);
        expect(reason(res).code).toBe('contact_not_verified');
      }
      const still = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(still.claimedByWawuId).toBeNull();
      expect(
        await prisma.makerTier.count({ where: { wawuUserId: who.sub } }),
      ).toBe(0);
    });

    it("a phone that was only typed never counts, even when it is the registration's own: refused as any contact that is not the caller's", async () => {
      const owner = person();
      const row = await registration(owner);
      const typed: Who = {
        sub: `${WHO}typed-${next()}`,
        phone: owner.phone,
        email: `${MARK}-typed-${next()}@test.wawu.dev`,
      };
      subs.add(typed.sub);
      // The account's email is proven (and is not the registration's); its phone is the registration's and only typed.
      const proofOfEmailOnly = await claim(
        mint(typed, { emailVerified: true, phoneVerified: false }),
        row.accessCode,
      ).expect(404);
      expect(reason(proofOfEmailOnly).code).toBe('code_not_found');
      const unknown = await claim(
        mint(typed, { emailVerified: true, phoneVerified: false }),
        '00000000',
      ).expect(404);
      expect(proofOfEmailOnly.body).toEqual(unknown.body);
      // Nothing proven at all: asked to confirm a contact first.
      const nothing = await claim(
        mint(typed, { emailVerified: false, phoneVerified: false }),
        row.accessCode,
      ).expect(409);
      expect(reason(nothing).code).toBe('contact_not_verified');
      const still = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(still.claimedByWawuId).toBeNull();
      expect(
        await prisma.makerTier.count({ where: { wawuUserId: typed.sub } }),
      ).toBe(0);
    });

    describe("the Hub's own proof of a phone: a BVN check that matched the account's phone", () => {
      const noFlags = { emailVerified: false, phoneVerified: false };
      const identity = (
        who: Who,
        over: {
          verifiedPhone?: string | null;
          bvnVerifiedAt?: Date | null;
        } = {},
      ) =>
        prisma.walletIdentity.create({
          data: {
            wawuUserId: who.sub,
            verifiedPhone: who.phone,
            bvnVerifiedAt: new Date(),
            ...over,
          },
        });

      it('counts: the registration is claimed with a phone WAWU ID has not flagged, once the BVN check proved it', async () => {
        const who = person();
        const row = await registration(who);
        await identity(who);
        const res = await claim(
          mint({ ...who, email: `other-${who.sub}@test.wawu.dev` }, noFlags),
          row.accessCode,
        ).expect(200);
        expect(data(res).tier.tier.id).toBe('verify');
      });

      it('does not count without a passed check, for a phone the account no longer has, or from another person', async () => {
        const row0 = await registration(person());
        // A phone stored but the BVN check never passed.
        const a = {
          sub: `${WHO}hub-a-${next()}`,
          phone: row0.phone,
          email: `a-${next()}@test.wawu.dev`,
        };
        subs.add(a.sub);
        await identity(a, { bvnVerifiedAt: null });
        const r1 = await claim(mint(a, noFlags), row0.accessCode).expect(409);
        expect(reason(r1).code).toBe('contact_not_verified');
        // Proved a number the account has since given up (its phone now is another).
        const b = {
          sub: `${WHO}hub-b-${next()}`,
          phone: '+2348077770002',
          email: `b-${next()}@test.wawu.dev`,
        };
        subs.add(b.sub);
        await identity(b, { verifiedPhone: row0.phone });
        const r2 = await claim(mint(b, noFlags), row0.accessCode).expect(409);
        expect(reason(r2).code).toBe('contact_not_verified');
        // Somebody else's proof of the same phone is not the caller's.
        const owner: Who = {
          sub: `${WHO}hub-o-${next()}`,
          phone: row0.phone,
          email: `o-${next()}@test.wawu.dev`,
        };
        subs.add(owner.sub);
        await identity(owner);
        const c = {
          sub: `${WHO}hub-c-${next()}`,
          phone: row0.phone,
          email: `c-${next()}@test.wawu.dev`,
        };
        subs.add(c.sub);
        const r3 = await claim(mint(c, noFlags), row0.accessCode).expect(409);
        expect(reason(r3).code).toBe('contact_not_verified');
        const still = await prisma.waitlistRegistration.findUniqueOrThrow({
          where: { id: row0.id },
        });
        expect(still.claimedByWawuId).toBeNull();
      });
    });

    it("refuses someone who holds the code but proves neither of the registration's contacts, with the same answer as an unknown code", async () => {
      const owner = person();
      const row = await registration(owner);
      const thief = person();
      const stranger = await claim(mint(thief), row.accessCode).expect(404);
      const unknown = await claim(mint(thief), '00000000').expect(404);
      expect(reason(stranger).code).toBe('code_not_found');
      expect(reason(unknown).code).toBe('code_not_found');
      expect(stranger.body).toEqual(unknown.body);
      // The proven contact of the thief is not the registration's; the typed one is.
      const typed = await claim(
        mint(
          { ...thief, phone: owner.phone, email: owner.email },
          { phoneVerified: false, emailVerified: false },
          {},
        ),
        row.accessCode,
      ).expect(409);
      expect(reason(typed).code).toBe('contact_not_verified');
      // Proven phone of the thief, typed email of the owner: still not the owner's.
      const half = await claim(
        mint(
          { ...thief, email: owner.email },
          { phoneVerified: true, emailVerified: false },
        ),
        row.accessCode,
      ).expect(404);
      expect(reason(half).code).toBe('code_not_found');
      const still = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(still.claimedByWawuId).toBeNull();
    });

    it('answers an unpaid registration, a code that is not 8 letters and numbers, and a code that is not there, each in plain words', async () => {
      const who = person();
      const pending = await registration(who, {
        status: 'pending',
        flutterwaveTxId: null,
        paidKobo: null,
        paidAt: null,
      });
      const a = await claim(mint(who), pending.accessCode).expect(404);
      expect(reason(a).code).toBe('code_not_found');
      for (const bad of [
        '',
        '   ',
        'ABC',
        '1234 5678 9',
        'GHIJKLMN',
        '5F6C-15E',
      ]) {
        const res = await claim(mint(who), bad);
        expect([400]).toContain(res.status);
      }
      const short = await claim(mint(who), 'ABC').expect(400);
      expect(reason(short).code).toBe('code_invalid');
      expect(reason(short).message).toBe(
        'Type the 8 letters and numbers of your access code.',
      );
      const none = await claim(mint(who), 'FFFFFFFF').expect(404);
      expect(reason(none).code).toBe('code_not_found');
    });

    it("refuses a `failed` (refund) row's code with plain words to its own payer, and as an unknown code to anyone else", async () => {
      const who = person();
      const good = await registration(who);
      // A second PAID row for one phone is refused by the database; a
      // `failed` one is how the refund of the extra payment is kept.
      const extra = await registration(who, { status: 'failed' });
      expect(extra.accessCode).not.toBe(good.accessCode);
      const own = await claim(mint(who), extra.accessCode).expect(409);
      expect(reason(own).code).toBe('code_refunded');
      expect(reason(own).message).toBe(
        'That code is from an extra payment, which is being refunded, so it cannot be used. Use the code from your first payment.',
      );
      const stranger = await claim(mint(person()), extra.accessCode).expect(
        404,
      );
      expect(reason(stranger).code).toBe('code_not_found');
      const row = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: extra.id },
      });
      expect(row.claimedByWawuId).toBeNull();
      expect(
        await prisma.makerTier.count({ where: { wawuUserId: who.sub } }),
      ).toBe(0);
      // The first payment's code is still theirs to use.
      await claim(mint(who), good.accessCode).expect(200);
    });

    it('refuses a second claim, and says who: you, or someone else (the owner of the same phone on another account), and tells a stranger nothing', async () => {
      const who = person();
      const row = await registration(who);
      await claim(mint(who), row.accessCode).expect(200);
      const again = await claim(mint(who), row.accessCode).expect(409);
      expect(reason(again).code).toBe('claimed_by_you');
      // The same phone on a second account (a person with two WAWU IDs).
      const twin: Who = { ...who, sub: `${who.sub}-twin` };
      subs.add(twin.sub);
      const other = await claim(mint(twin), row.accessCode).expect(409);
      expect(reason(other).code).toBe('already_claimed');
      expect(reason(other).message).toBe('That code has already been used.');
      const stranger = await claim(mint(person()), row.accessCode).expect(404);
      expect(reason(stranger).code).toBe('code_not_found');
      // Nothing was granted twice.
      expect(
        await prisma.eventPass.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
      expect(
        await prisma.pointLot.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
      expect(
        await prisma.makerTier.count({ where: { wawuUserId: twin.sub } }),
      ).toBe(0);
    });

    it('never puts anyone else details in an answer: no name, phone, email, reference or transaction id', async () => {
      const owner = person();
      const row = await registration(owner);
      const secrets = [
        owner.phone,
        owner.phone.slice(4),
        owner.email,
        row.fullName,
        row.reference,
        row.flutterwaveTxId!,
        row.id,
        owner.sub,
      ];
      const stranger = person();
      await claim(mint(owner), row.accessCode).expect(200);
      const answers: Response[] = [
        await claim(mint(stranger), row.accessCode),
        await claim(mint(stranger, {}), row.accessCode),
        await claim(mint(stranger), '12345678'),
        await claim(
          mint(
            { ...stranger, phone: owner.phone },
            { phoneVerified: true, emailVerified: false },
          ),
          row.accessCode,
        ),
      ];
      // The last one is the owner's own proven phone on another account.
      expect(reason(answers[3]).code).toBe('already_claimed');
      for (const res of answers) {
        const body = JSON.stringify(res.body);
        for (const s of secrets) expect(body).not.toContain(s);
      }
    });
  });

  describe('once, even under two taps at once on two servers', () => {
    it('6 taps at once on one server, and 6 on two servers, leave one claim, one tier, one pass, one lot', async () => {
      for (const servers of [[app], [app, second]]) {
        const who = person();
        const row = await registration(who);
        const token = mint(who);
        const calls = Array.from({ length: 6 }, (_, i) =>
          request(servers[i % servers.length].getHttpServer())
            .post('/api/hub/waitlist/claims')
            .set('Authorization', `Bearer ${token}`)
            .send({ code: row.accessCode }),
        );
        const results = await Promise.all(calls);
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
        for (const r of results.filter((x) => x.status !== 200))
          expect(reason(r).code).toBe('claimed_by_you');
        expect(
          await prisma.eventPass.count({ where: { wawuUserId: who.sub } }),
        ).toBe(1);
        expect(
          await prisma.pointLot.count({ where: { wawuUserId: who.sub } }),
        ).toBe(1);
        const lot = await prisma.pointLot.findFirstOrThrow({
          where: { wawuUserId: who.sub },
        });
        expect(lot.remaining).toBe(verify.bonusPoints);
        const t = await prisma.makerTier.findUniqueOrThrow({
          where: { wawuUserId: who.sub },
        });
        expect(t.activeUntil.getTime() - t.activeFrom.getTime()).toBe(
          OFFER_DAYS * DAY,
        );
      }
    });

    it('two accounts holding the same phone, tapping at once: one gets the plan, the other is told it is used', async () => {
      const a = person();
      const row = await registration(a);
      const b: Who = { ...a, sub: `${a.sub}-b` };
      subs.add(b.sub);
      const results = await Promise.all([
        claim(mint(a), row.accessCode),
        claim(mint(b), row.accessCode),
        claim(mint(a), row.accessCode),
        claim(mint(b), row.accessCode),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const winner = (
        await prisma.waitlistRegistration.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).claimedByWawuId!;
      expect([a.sub, b.sub]).toContain(winner);
      expect(
        await prisma.makerTier.count({
          where: { wawuUserId: { in: [a.sub, b.sub] } },
        }),
      ).toBe(1);
      expect(
        await prisma.eventPass.count({
          where: { wawuUserId: { in: [a.sub, b.sub] } },
        }),
      ).toBe(1);
    });
  });

  describe('a person who already holds a plan', () => {
    it('adds the days to a tier that has not ended, whichever tier it is, and never lowers it', async () => {
      const who = person();
      const now = new Date();
      const heldUntil = new Date(now.getTime() + 200 * DAY);
      await prisma.makerTier.create({
        data: {
          wawuUserId: who.sub,
          tierId: 'founding',
          activeFrom: new Date(now.getTime() - 165 * DAY),
          activeUntil: heldUntil,
          productsIncluded: 10,
          extraProducts: 2,
          pointsIncluded: 600,
          voiceIntroIncluded: false,
        },
      });
      const row = await registration(who);
      const res = await claim(mint(who), row.accessCode).expect(200);
      const t = data(res).tier;
      expect(data(res)).toMatchObject({ extended: true, days: OFFER_DAYS });
      expect(t.tier.id).toBe('founding');
      expect(new Date(t.activeUntil).getTime()).toBe(
        heldUntil.getTime() + OFFER_DAYS * DAY,
      );
      expect(t.productsAllowed).toBe(12);
      expect(t.firstVoiceIntroIncluded).toBe(false);
      const stored = await prisma.makerTier.findUniqueOrThrow({
        where: { wawuUserId: who.sub },
      });
      expect(stored.productsIncluded).toBe(10);
      expect(stored.extraProducts).toBe(2);
      // The bonus points and the pass are still granted.
      expect(
        await prisma.pointLot.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
      expect(
        await prisma.eventPass.count({ where: { wawuUserId: who.sub } }),
      ).toBe(1);
    });

    it('starts a new period from the claim when the tier has ended, copying what this tier gives', async () => {
      const who = person();
      const now = Date.now();
      await prisma.makerTier.create({
        data: {
          wawuUserId: who.sub,
          tierId: 'founding',
          activeFrom: new Date(now - 400 * DAY),
          activeUntil: new Date(now - 35 * DAY),
          productsIncluded: 10,
          extraProducts: 0,
          pointsIncluded: 600,
          voiceIntroIncluded: false,
        },
      });
      const row = await registration(who);
      const res = await claim(mint(who), row.accessCode).expect(200);
      const t = data(res).tier;
      expect(data(res).extended).toBe(false);
      expect(t.state).toBe('active');
      expect(t.tier.id).toBe('verify');
      expect(t.productsAllowed).toBe(verify.products);
      expect(t.firstVoiceIntroIncluded).toBe(verify.firstVoiceIntro);
      expect(new Date(t.activeFrom).getTime()).toBeGreaterThan(now - 5000);
    });

    it('claiming a second code adds its days after the first period, with its own points and pass', async () => {
      const who = person();
      // One paid row per offer and phone is the database's rule, so the same
      // person's second registration is in a second offer.
      const first = await registration(who);
      const again = await registration(who, { offerId: SECOND_OFFER_ID });
      const r1 = await claim(mint(who), first.accessCode).expect(200);
      const r2 = await claim(mint(who), again.accessCode).expect(200);
      expect(data(r1).extended).toBe(false);
      expect(data(r2).extended).toBe(true);
      expect(new Date(data(r2).tier.activeUntil).getTime()).toBe(
        new Date(data(r1).tier.activeUntil).getTime() + OFFER_DAYS * DAY,
      );
      expect(
        await prisma.eventPass.count({ where: { wawuUserId: who.sub } }),
      ).toBe(2);
      expect(
        await prisma.pointLot.count({ where: { wawuUserId: who.sub } }),
      ).toBe(2);
    });
  });

  describe('when something is wrong on our side, nothing is half done', () => {
    it('a code whose offer is no longer in the plans file is refused in plain words and stays unclaimed', async () => {
      const who = person();
      const row = await registration(who, { offerId: 'event-removed' });
      const res = await claim(mint(who), row.accessCode).expect(409);
      expect(reason(res).code).toBe('offer_unavailable');
      const still = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(still.claimedByWawuId).toBeNull();
    });

    it('a grant that fails rolls the claim back: the code stays unclaimed and no tier, pass or lot is left', async () => {
      const who = person();
      const row = await registration(who);
      // Another person already holds the lot this claim would write: the
      // points service refuses (points_grant_conflict) inside the transaction.
      const squatter = person();
      await app.get(PointsService).grant({
        wawuUserId: squatter.sub,
        source: 'tier_bonus',
        sourceRef: `join:${row.id}`,
        points: 7,
        expiresAt: new Date(Date.now() + 10 * DAY),
      });
      const res = await claim(mint(who), row.accessCode);
      expect(res.status).toBe(409);
      expect(reason(res).code).toBe('points_grant_conflict');
      const still = await prisma.waitlistRegistration.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(still.claimedByWawuId).toBeNull();
      expect(still.claimedAt).toBeNull();
      expect(
        await prisma.makerTier.count({ where: { wawuUserId: who.sub } }),
      ).toBe(0);
      expect(
        await prisma.eventPass.count({
          where: { purchaseRef: `join:${row.id}` },
        }),
      ).toBe(0);
      expect(
        await prisma.pointLot.count({ where: { wawuUserId: who.sub } }),
      ).toBe(0);
    });

    it('the database itself refuses an owner on a row that is not paid', async () => {
      const who = person();
      for (const status of ['pending', 'failed']) {
        const row = await registration(
          {
            phone: `+23481${next().slice(-8)}`,
            email: `${MARK}-${next()}@test.wawu.dev`,
          },
          {
            status,
            ...(status === 'pending'
              ? { flutterwaveTxId: null, paidKobo: null, paidAt: null }
              : {}),
          },
        );
        await expect(
          prisma.waitlistRegistration.update({
            where: { id: row.id },
            data: { claimedByWawuId: who.sub, claimedAt: new Date() },
          }),
        ).rejects.toThrow(/claim_paid_check/);
      }
    });
  });

  describe('the purge and export maps cover everything a claim writes', () => {
    it("an export carries the claimed registration, the tier, the pass and the points lot, and a purge removes every one of them and nobody else's", async () => {
      const who = person();
      const bystander = person();
      const mine = await registration(who);
      const theirs = await registration(bystander);
      await claim(mint(who), mine.accessCode).expect(200);
      await claim(mint(bystander), theirs.accessCode).expect(200);

      const keys = [
        'eventRegistrations',
        'makerTier',
        'eventPasses',
        'pointLots',
      ];
      for (const key of keys) {
        const section = EXPORT_SECTIONS.find((s) => s.key === key)!;
        const rows = await section.load(prisma, who.sub);
        const list = Array.isArray(rows) ? rows : [rows];
        expect(list.filter(Boolean)).toHaveLength(1);
      }
      const registrations = JSON.stringify(
        await EXPORT_SECTIONS.find((s) => s.key === 'eventRegistrations')!.load(
          prisma,
          who.sub,
        ),
      );
      expect(registrations).toContain('claimedAt');
      expect(registrations).not.toContain(mine.reference);

      const purge = app.get(AccountPurgeService);
      const result = await purge.purge(who.sub);
      expect(result.deleted['WaitlistRegistration.claimedByWawuId']).toBe(1);
      expect(result.deleted['MakerTier.wawuUserId']).toBe(1);
      expect(result.deleted['EventPass.wawuUserId']).toBe(1);
      expect(result.deleted['PointLot.wawuUserId']).toBe(1);
      expect(
        await prisma.waitlistRegistration.count({ where: { id: mine.id } }),
      ).toBe(0);
      expect(
        await prisma.makerTier.count({ where: { wawuUserId: who.sub } }),
      ).toBe(0);
      expect(
        await prisma.pointLot.count({ where: { wawuUserId: who.sub } }),
      ).toBe(0);
      expect(
        await prisma.pointLedger.count({ where: { wawuUserId: who.sub } }),
      ).toBe(0);
      // The bystander kept all of theirs.
      expect(
        await prisma.waitlistRegistration.count({ where: { id: theirs.id } }),
      ).toBe(1);
      expect(
        await prisma.makerTier.count({ where: { wawuUserId: bystander.sub } }),
      ).toBe(1);
      expect(
        await prisma.eventPass.count({ where: { wawuUserId: bystander.sub } }),
      ).toBe(1);
      expect(
        await prisma.pointLot.count({ where: { wawuUserId: bystander.sub } }),
      ).toBe(1);
    });
  });
});
