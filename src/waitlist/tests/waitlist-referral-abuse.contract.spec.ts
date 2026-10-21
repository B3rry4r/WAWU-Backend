// The spec reads response bodies and edits an untyped copy of the plans file.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlansConfig } from '../../plans/plans-config';
import { ReferralAdminService } from '../referral/referral-admin.service';
import {
  REFERRAL_HOLD_MS,
  REFERRAL_MISS_LIMIT,
  REFERRAL_MISS_WINDOW_MS,
  REFERRAL_PROBING_WORDS,
} from '../waitlist-config';
import { WaitlistService } from '../waitlist.service';
import {
  bootWaitlist,
  configWith,
  OFFER_ID,
  openOffer,
  ScriptedFlutterwave,
} from './waitlist-harness';

/**
 * SWEEP-JOIN D3 and D4, on the real WaitlistModule and a real database,
 * Flutterwave stood in at its two seams.
 *
 * D3: the unpaid starts of one person hold ONE place under a limited code, and
 * a person starting again keeps their place.
 * D4: an address that tries too many codes we do not have is asked to wait.
 * Every figure is read from waitlist-config.ts.
 *
 * The one test that goes over HTTP from the test's own address is the last in
 * the file, because it uses that address up.
 */

const MARK = 'sweepjoin-spec';

describe('Referral hold spam and code probing (SWEEP-JOIN D3, D4)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let waitlist: WaitlistService;
  let admin: ReferralAdminService;
  let config: PlansConfig;
  const fake = new ScriptedFlutterwave();
  let n = 0;
  let codeSeq = 0;

  const person = (over: Record<string, unknown> = {}) => {
    n += 1;
    const tail = String(50_000_000 + n).slice(-8);
    return {
      offerId: OFFER_ID,
      fullName: `Tester ${n} ${MARK}`,
      phone: `+23481${tail}`,
      email: `${MARK}-${n}@test.wawu.dev`,
      consent: true,
      ...over,
    };
  };

  const makeCode = (over: Record<string, unknown> = {}) => {
    codeSeq += 1;
    return prisma.referralCode.create({
      data: {
        code: `SJS${process.pid}X${codeSeq}`.slice(0, 20),
        community: `Community ${codeSeq}`,
        priceKobo: 100000,
        usageLimit: null,
        active: true,
        ...over,
      },
    });
  };

  const cleanUp = async () => {
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    await prisma.referralCode.deleteMany({
      where: { code: { startsWith: 'SJS' } },
    });
  };

  beforeAll(async () => {
    config = configWith((raw) => {
      raw.event_offers = [openOffer()];
    });
    app = await bootWaitlist(config, fake);
    prisma = app.get(PrismaService);
    waitlist = app.get(WaitlistService);
    admin = app.get(ReferralAdminService);
    await cleanUp();
  }, 60_000);

  beforeEach(() => fake.reset());

  afterAll(async () => {
    await cleanUp();
    await app.close();
  });

  describe('D3: one person holds one place', () => {
    it('does not let one person starting again and again use up a limited code', async () => {
      const code = await makeCode({ usageLimit: 2 });
      const spammer = person();
      for (let i = 0; i < 6; i += 1) {
        const start = await waitlist.register({
          ...spammer,
          referralCode: code.code,
        });
        expect(start.referral?.applied).toBe(true);
      }
      expect(
        await prisma.waitlistRegistration.count({
          where: { referralCode: code.code },
        }),
      ).toBe(6);
      // Six unpaid starts are one place: the second person still gets the code.
      const second = await waitlist.register(
        person({ referralCode: code.code }),
      );
      expect(second.referral).toEqual({ code: code.code, applied: true });
      // Two people hold the two places; the third is told it is full.
      const third = await waitlist.register(
        person({ referralCode: code.code }),
      );
      expect(third.referral).toEqual({
        code: code.code,
        applied: false,
        reason: 'full',
      });
    });

    it('keeps the place of a person who starts again, even when the code is down to its last place', async () => {
      const code = await makeCode({ usageLimit: 1 });
      const me = person();
      const first = await waitlist.register({ ...me, referralCode: code.code });
      const again = await waitlist.register({ ...me, referralCode: code.code });
      expect(first.referral?.applied).toBe(true);
      expect(again.referral).toEqual({ code: code.code, applied: true });
      expect(again.reference).not.toBe(first.reference);
      const other = await waitlist.register(
        person({ referralCode: code.code }),
      );
      expect(other.referral?.reason).toBe('full');
    });

    it('does not make a new person of a changed phone alone or a changed email alone, but counts people who share only an email', async () => {
      const code = await makeCode({ usageLimit: 3 });
      const me = person();
      await waitlist.register({ ...me, referralCode: code.code });
      // Same email, another phone: still the larger of (1 phone, 1 email) per
      // person, so the count of distinct phones is what grows.
      await waitlist.register({
        ...me,
        phone: '+2348199990001',
        referralCode: code.code,
      });
      await waitlist.register({
        ...me,
        email: `${MARK}-alt-${n}@test.wawu.dev`,
        referralCode: code.code,
      });
      const held = await admin.list();
      // Two phones among the starts, two emails: two people, not three starts.
      expect(held.find((c) => c.code === code.code)?.heldCount).toBe(2);
    });

    it('shows the team the places held as people, not starts', async () => {
      const code = await makeCode({ usageLimit: 5 });
      const a = person();
      for (let i = 0; i < 4; i += 1)
        await waitlist.register({ ...a, referralCode: code.code });
      await waitlist.register(person({ referralCode: code.code }));
      const row = (await admin.list()).find((c) => c.code === code.code);
      expect(row?.heldCount).toBe(2);
    });

    it('still gives a held place back after the hold ends', async () => {
      const code = await makeCode({ usageLimit: 1 });
      const t0 = new Date();
      await waitlist.register(person({ referralCode: code.code }), t0);
      const early = await waitlist.register(
        person({ referralCode: code.code }),
        new Date(t0.getTime() + REFERRAL_HOLD_MS - 60_000),
      );
      expect(early.referral?.reason).toBe('full');
      const late = await waitlist.register(
        person({ referralCode: code.code }),
        new Date(t0.getTime() + REFERRAL_HOLD_MS + 60_000),
      );
      expect(late.referral?.applied).toBe(true);
    });
  });

  describe('D4: trying codes one after another', () => {
    const address = (label: string) => `203.0.113.${label}`;
    const miss = (i: number, addr: string, now: Date) =>
      waitlist.referralCheck(`NOPE${i}X${process.pid}`.slice(0, 20), now, addr);

    it('refuses an address that has tried the limit of codes we do not have, with a plain sentence, and then waits out the window', async () => {
      const code = await makeCode({ priceKobo: 0 });
      const addr = address('10');
      const t0 = new Date();
      for (let i = 0; i < REFERRAL_MISS_LIMIT; i += 1)
        await expect(miss(i, addr, t0)).rejects.toMatchObject({
          code: 'referral_unknown',
        });
      // Even a code that exists is not looked up for this address now.
      const blocked = await waitlist
        .referralCheck(code.code, t0, addr)
        .catch((e: unknown) => e);
      expect(blocked).toMatchObject({
        code: 'referral_attempts_limited',
        response: {
          reason: {
            code: 'referral_attempts_limited',
            message: REFERRAL_PROBING_WORDS,
          },
        },
      });
      expect((blocked as { getStatus(): number }).getStatus()).toBe(429);
      expect(REFERRAL_PROBING_WORDS).not.toMatch(/[—–]/);
      // The window passes, and the address may try again.
      const later = new Date(t0.getTime() + REFERRAL_MISS_WINDOW_MS + 1000);
      await expect(
        waitlist.referralCheck(code.code, later, addr),
      ).resolves.toMatchObject({ applies: true, priceKobo: 0 });
    });

    it('slows registrations that carry a code, and never one that carries none', async () => {
      const code = await makeCode({ priceKobo: 0 });
      const addr = address('20');
      const t0 = new Date();
      for (let i = 0; i < REFERRAL_MISS_LIMIT; i += 1)
        await expect(
          waitlist.register(
            person({ referralCode: `ZZZ${i}X${process.pid}`.slice(0, 20) }),
            t0,
            addr,
          ),
        ).rejects.toMatchObject({ code: 'referral_unknown' });
      await expect(
        waitlist.register(person({ referralCode: code.code }), t0, addr),
      ).rejects.toMatchObject({ code: 'referral_attempts_limited' });
      // No code: the standard registration goes through, as it always did.
      const plain = await waitlist.register(person(), t0, addr);
      expect(plain.flutterwaveConfig).toBeDefined();
      expect(plain.referral).toBeUndefined();
    });

    it('does not count codes that exist, and keeps addresses apart', async () => {
      const code = await makeCode({ priceKobo: 0 });
      const kind = address('30');
      const t0 = new Date();
      for (let i = 0; i < REFERRAL_MISS_LIMIT * 2; i += 1)
        await expect(
          waitlist.referralCheck(code.code, t0, kind),
        ).resolves.toMatchObject({ applies: true });
      const prober = address('31');
      for (let i = 0; i < REFERRAL_MISS_LIMIT; i += 1)
        await expect(miss(i, prober, t0)).rejects.toMatchObject({
          code: 'referral_unknown',
        });
      await expect(
        waitlist.referralCheck(code.code, t0, prober),
      ).rejects.toMatchObject({ code: 'referral_attempts_limited' });
      await expect(
        waitlist.referralCheck(code.code, t0, kind),
      ).resolves.toMatchObject({ applies: true });
    });

    it('answers over HTTP with the one error shape and the stable reason code', async () => {
      const code = await makeCode({ priceKobo: 0 });
      const http = () => request(app.getHttpServer());
      const check = (c: string): Promise<Response> =>
        http().get(`/api/hub/waitlist/referral-codes/${c}`);
      for (let i = 0; i < REFERRAL_MISS_LIMIT; i += 1)
        expect((await check(`HTTP${i}X${process.pid}`)).status).toBe(404);
      const blocked = await check(code.code);
      expect(blocked.status).toBe(429);
      expect(blocked.body.reason).toEqual({
        code: 'referral_attempts_limited',
        message: REFERRAL_PROBING_WORDS,
      });
      expect(blocked.headers['cache-control']).toBe('no-store');
    });
  });
});
