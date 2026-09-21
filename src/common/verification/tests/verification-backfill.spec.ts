import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '../../../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { deriveVerificationState } from '../verification-state';

/**
 * THE BACKFILL, RUN.
 *
 * The mapping off the old five-rung ladder exists as SQL inside a migration,
 * which is the one kind of code that runs exactly once and can never be
 * corrected afterwards on a database that has already taken it. So this
 * reads the statement out of the migration file and executes it against
 * fixture rows, rather than asserting about a copy of it:
 *
 *   basic, verified_user                    -> no tick at all
 *   verified_business, certified_professional,
 *   trusted_partner, official               -> professional tick, perpetual
 *   nobody                                  -> the creator tick
 *
 * Fixture accounts live under this suite's own `7b……` prefix and are removed
 * afterwards, so nothing seeded is read or written.
 */
const MIGRATION = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20260921160000_two_tick_verification',
  'migration.sql',
);

/** The one UPDATE that does the backfill, lifted out of the migration. */
function backfillStatement(): string {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('UPDATE "UserProfile" p');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf(';', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 1);
}

const GRANDFATHERED = [
  'verified_business',
  'certified_professional',
  'trusted_partner',
] as const;
const NOT_GRANDFATHERED = ['basic', 'verified_user'] as const;

const SUBJECTS = [...GRANDFATHERED, ...NOT_GRANDFATHERED];
const subFor = (tier: string) =>
  `7b000000-0000-4000-8000-0000000000${(SUBJECTS.indexOf(tier as never) + 1)
    .toString()
    .padStart(2, '0')}`;
const SUBS = SUBJECTS.map(subFor);

describe('two-tick backfill (the migration statement, executed)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });

    await cleanup();
    await prisma.userProfile.createMany({
      data: SUBJECTS.map((tier) => ({
        wawuUserId: subFor(tier),
        accountType: 'creator' as const,
      })),
    });
    await prisma.verificationSubmission.createMany({
      data: SUBJECTS.map((tier) => ({
        wawuUserId: subFor(tier),
        tier,
        status: 'approved' as const,
        documents: ['doc.pdf'],
      })),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.verificationSubmission.deleteMany({
      where: { wawuUserId: { in: SUBS } },
    });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: SUBS } } });
  }

  it('grandfathers the business and professional rungs onto a PERPETUAL professional tick', async () => {
    await prisma.$executeRawUnsafe(backfillStatement());

    for (const tier of GRANDFATHERED) {
      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { wawuUserId: subFor(tier) },
      });
      const state = deriveVerificationState(row);
      expect(state.professional.verified).toBe(true);
      // Perpetual. These accounts were vetted by hand and never bought an
      // annual term, so expiring them on a date they were never told about
      // would take away a badge somebody earned.
      expect(state.professional.expiresAt).toBeNull();
      expect(row.professionalVerifiedUntil).toBeNull();
    }
  });

  it('gives the lower two rungs no tick at all', async () => {
    await prisma.$executeRawUnsafe(backfillStatement());

    for (const tier of NOT_GRANDFATHERED) {
      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { wawuUserId: subFor(tier) },
      });
      expect(deriveVerificationState(row)).toEqual({
        creator: { verified: false, expiresAt: null },
        professional: { verified: false, expiresAt: null },
      });
    }
  });

  it('gives NOBODY the creator tick: a paid creator tick never existed before', async () => {
    await prisma.$executeRawUnsafe(backfillStatement());

    const rows = await prisma.userProfile.findMany({
      where: { wawuUserId: { in: SUBS } },
    });
    expect(rows).toHaveLength(SUBJECTS.length);
    for (const row of rows) {
      expect(row.creatorVerifiedAt).toBeNull();
      expect(row.creatorVerifiedUntil).toBeNull();
    }
  });

  it('is idempotent: running it again does not move an existing grant', async () => {
    await prisma.$executeRawUnsafe(backfillStatement());
    const first = await prisma.userProfile.findUniqueOrThrow({
      where: { wawuUserId: subFor('trusted_partner') },
    });
    await prisma.$executeRawUnsafe(backfillStatement());
    const second = await prisma.userProfile.findUniqueOrThrow({
      where: { wawuUserId: subFor('trusted_partner') },
    });
    expect(second.professionalVerifiedAt?.toISOString()).toBe(
      first.professionalVerifiedAt?.toISOString(),
    );
  });

  it('names "official" too, which this database never had but the shared contract does', () => {
    const statement = backfillStatement();
    for (const tier of [...GRANDFATHERED, 'official']) {
      expect(statement).toContain(`'${tier}'`);
    }
    for (const tier of NOT_GRANDFATHERED) {
      expect(statement).not.toContain(`'${tier}'`);
    }
  });

  it('only looks at APPROVED submissions, so a pending application grants nothing', async () => {
    const pendingSub = '7b000000-0000-4000-8000-0000000000fe';
    await prisma.userProfile.create({
      data: { wawuUserId: pendingSub, accountType: 'creator' },
    });
    await prisma.verificationSubmission.create({
      data: {
        wawuUserId: pendingSub,
        tier: 'trusted_partner',
        status: 'pending',
        documents: ['doc.pdf'],
      },
    });
    try {
      await prisma.$executeRawUnsafe(backfillStatement());
      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { wawuUserId: pendingSub },
      });
      expect(row.professionalVerifiedAt).toBeNull();
    } finally {
      await prisma.verificationSubmission.deleteMany({
        where: { wawuUserId: pendingSub },
      });
      await prisma.userProfile.delete({ where: { wawuUserId: pendingSub } });
    }
  });
});
