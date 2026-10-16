// The spec reads untyped export rows.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EXPORT_SECTIONS } from '../../data-export-request/data-export-sections';
import { newReference } from '../waitlist.service';

/**
 * JOIN-01: the purge and export maps decide the new table. A registration an
 * account claimed goes with the account and appears in its export; one nobody
 * has claimed names no account and is left alone.
 */

const MARK = 'join01-maps-spec';
const WHO = 'j01-maps-person';
const OTHER = 'j01-maps-other';

describe('the registration table in the purge and export maps (JOIN-01)', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;

  const row = (over: Record<string, unknown>) => {
    const ref = newReference();
    return prisma.waitlistRegistration.create({
      data: {
        offerId: 'event-maps',
        fullName: `Maps Person ${MARK}`,
        phone: `+2348${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
        email: `${MARK}-${ref.slice(-8)}@test.wawu.dev`,
        consentAt: new Date(),
        reference: ref,
        amountKobo: 200000,
        status: 'paid',
        flutterwaveTxId: `maps-${ref.slice(-12)}`,
        paidKobo: 200000,
        paidAt: new Date(),
        ...over,
      } as never,
    });
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
      ],
      providers: [AccountPurgeService],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    (global as any).__purge = mod.get(AccountPurgeService);
    close = () => mod.close();
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
  });

  afterAll(async () => {
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    await close();
  });

  it('deleting an account removes the registrations it claimed, and only those', async () => {
    const mine = await row({ claimedByWawuId: WHO, claimedAt: new Date() });
    const theirs = await row({ claimedByWawuId: OTHER, claimedAt: new Date() });
    const unclaimed = await row({});
    const result = await ((global as any).__purge as AccountPurgeService).purge(
      WHO,
    );
    expect(result.deleted['WaitlistRegistration.claimedByWawuId']).toBe(1);
    expect(
      await prisma.waitlistRegistration.count({ where: { id: mine.id } }),
    ).toBe(0);
    expect(
      await prisma.waitlistRegistration.count({ where: { id: theirs.id } }),
    ).toBe(1);
    expect(
      await prisma.waitlistRegistration.count({ where: { id: unclaimed.id } }),
    ).toBe(1);
  });

  it("an export carries the person's claimed registration, never another's, and no payment reference or transaction id", async () => {
    const mine = await row({
      claimedByWawuId: WHO,
      claimedAt: new Date(),
      state: 'Lagos',
    });
    await row({ claimedByWawuId: OTHER, claimedAt: new Date() });
    await row({});
    const section = EXPORT_SECTIONS.find((s) =>
      s.models.includes('WaitlistRegistration'),
    )!;
    const rows = (await section.load(prisma, WHO)) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      offerId: 'event-maps',
      fullName: mine.fullName,
      state: 'Lagos',
      status: 'paid',
      amountKobo: 200000,
    });
    expect(Object.keys(rows[0])).not.toEqual(
      expect.arrayContaining(['reference']),
    );
    expect(Object.keys(rows[0])).not.toEqual(
      expect.arrayContaining(['flutterwaveTxId']),
    );
    expect(JSON.stringify(rows)).not.toContain(mine.reference);
    expect(JSON.stringify(rows)).not.toContain(mine.flutterwaveTxId!);
  });
});
