// The spec reads response bodies from an untyped copy of the plans file.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReferralAdminService } from '../referral/referral-admin.service';
import { REFERRAL_HOLD_MS } from '../waitlist-config';
import { WaitlistService } from '../waitlist.service';
import {
  bootWaitlist,
  configWith,
  OFFER_ID,
  openOffer,
  ScriptedFlutterwave,
} from './waitlist-harness';

/**
 * SWEEP-JOIN round 2 (M1): the 30 minute hold of a place under a limited
 * referral code is measured the same whatever time zone the database session
 * runs in. Every other waitlist spec runs in UTC, where a wrong zone shift is
 * invisible, so this one starts the app with the session zone set to a zone
 * that is not UTC (PGOPTIONS, read by the pg driver when a connection opens)
 * and checks, with `SHOW timezone`, that the zone really is what it asked for.
 */

const MARK = 'sweepjoin-zone-spec';

describe.each(['Pacific/Auckland', 'America/Los_Angeles'])(
  'The hold of a referral place under a database session zone of %s (SWEEP-JOIN M1)',
  (zone) => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let waitlist: WaitlistService;
    let admin: ReferralAdminService;
    const fake = new ScriptedFlutterwave();
    const before = process.env.PGOPTIONS;
    let n = 0;
    let codeSeq = 0;

    const person = (over: Record<string, unknown> = {}) => {
      n += 1;
      const tail = String(60_000_000 + n).slice(-8);
      return {
        offerId: OFFER_ID,
        fullName: `Tester ${n} ${MARK}`,
        phone: `+23481${tail}`,
        email: `${MARK}-${n}@test.wawu.dev`,
        consent: true,
        ...over,
      };
    };

    const cleanUp = async () => {
      await prisma.waitlistRegistration.deleteMany({
        where: { fullName: { contains: MARK } },
      });
      await prisma.referralCode.deleteMany({
        where: { code: { startsWith: 'SJZ' } },
      });
    };

    beforeAll(async () => {
      process.env.PGOPTIONS = `-c timezone=${zone}`;
      app = await bootWaitlist(
        configWith((raw) => {
          raw.event_offers = [openOffer()];
        }),
        fake,
      );
      prisma = app.get(PrismaService);
      waitlist = app.get(WaitlistService);
      admin = app.get(ReferralAdminService);
      await cleanUp();
    }, 60_000);

    afterAll(async () => {
      await cleanUp();
      await app.close();
      if (before === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = before;
    });

    beforeEach(() => fake.reset());

    it('really runs in that zone', async () => {
      const rows = await prisma.$queryRaw<
        { TimeZone: string }[]
      >`SHOW timezone`;
      expect(rows[0].TimeZone).toBe(zone);
    });

    it('holds the place for 30 minutes and gives it back after', async () => {
      codeSeq += 1;
      const code = await prisma.referralCode.create({
        data: {
          code: `SJZ${process.pid}X${codeSeq}`.slice(0, 20),
          community: 'Zone',
          priceKobo: 100000,
          usageLimit: 1,
          active: true,
        },
      });
      const t0 = new Date();
      const first = await waitlist.register(
        person({ referralCode: code.code }),
        t0,
      );
      expect(first.referral?.applied).toBe(true);
      // 29 minutes on, the place is still held (the code is full, and the team's list counts it).
      const early = new Date(t0.getTime() + REFERRAL_HOLD_MS - 60_000);
      expect((await waitlist.referralCheck(code.code, early)).applies).toBe(
        false,
      );
      expect(
        (await admin.list(early)).find((c) => c.code === code.code)?.heldCount,
      ).toBe(1);
      const refused = await waitlist.register(
        person({ referralCode: code.code }),
        early,
      );
      expect(refused.referral).toEqual({
        code: code.code,
        applied: false,
        reason: 'full',
      });
      // 31 minutes on, the hold has ended: the next person takes it, nothing is held.
      const late = new Date(t0.getTime() + REFERRAL_HOLD_MS + 60_000);
      expect(
        (await admin.list(late)).find((c) => c.code === code.code)?.heldCount,
      ).toBe(0);
      const next = await waitlist.register(
        person({ referralCode: code.code }),
        late,
      );
      expect(next.referral).toEqual({ code: code.code, applied: true });
    });
  },
);
