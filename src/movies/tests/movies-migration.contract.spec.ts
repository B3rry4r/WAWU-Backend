// FLIX-01: the migration's rollback refuses while a person's link or consent
// is stored, and drops the four tables when there are none.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';

jest.setTimeout(60_000);

describe('FLIX-01: rollback.sql refuses while a link or a consent is stored', () => {
  const file = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20261031100000_flix_movies/rollback.sql',
    ),
    'utf8',
  );
  // The first line is psql's `\set ON_ERROR_STOP on` (FIX-96); this runner is not psql, so it leaves out lines that start with a backslash.
  const sql = file
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Runs the whole rollback in a transaction that is always rolled back; returns the refusal, or null when it went through (and the tables were dropped inside it). */
  const roll = async (setup: string | null): Promise<string | null> => {
    class Done extends Error {}
    let refused: string | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('DELETE FROM "MoviePartnerLink"');
        await tx.$executeRawUnsafe('DELETE FROM "MoviePartnerConsent"');
        if (setup) await tx.$executeRawUnsafe(setup);
        await tx.$executeRawUnsafe('SAVEPOINT roll');
        try {
          await tx.$executeRawUnsafe(sql);
        } catch (e) {
          refused = (e as Error).message;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT roll');
        }
        throw new Done();
      });
    } catch (e) {
      if (!(e instanceof Done)) throw e;
    }
    return refused;
  };

  it('starts with the stop line', () => {
    expect(file.split('\n', 1)[0]).toBe('\\set ON_ERROR_STOP on');
  });

  it('stops on a stored link or consent and changes nothing', async () => {
    for (const setup of [
      `INSERT INTO "MoviePartnerLink" ("id","provider","wawuUserId","firstLinkAt","lastLinkAt","updatedAt") VALUES ('${randomUUID()}','standin','flix-rollback-x',now(),now(),now())`,
      `INSERT INTO "MoviePartnerConsent" ("id","provider","wawuUserId","how") VALUES ('${randomUUID()}','standin','flix-rollback-x','mv4')`,
    ])
      expect(await roll(setup)).toMatch(
        /FLIX-01 rollback.*Nothing was changed/,
      );
    // the tables are all still there
    for (const t of [
      'MoviePartnerMovie',
      'MoviePartnerSync',
      'MoviePartnerLink',
      'MoviePartnerConsent',
    ])
      await expect(
        prisma.$queryRawUnsafe(`SELECT 1 FROM "${t}" LIMIT 1`),
      ).resolves.toBeDefined();
  });

  it('goes through with no link and no consent, even with a copy of the catalog and a sync marker', async () => {
    expect(
      await roll(
        `INSERT INTO "MoviePartnerSync" ("provider","updatedAt") VALUES ('flix-rollback-p', now())`,
      ),
    ).toBeNull();
    expect(await roll(null)).toBeNull();
  });
});
