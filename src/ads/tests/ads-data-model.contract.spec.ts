import { Client } from 'pg';
import { AD_WEIGHT_MAX, AD_WEIGHT_MIN } from '../ads-limits';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * ADS-03: the ads data model on a real database.
 *
 * No route reads or writes these tables yet (ADS-04 serves them, ADS-06 writes
 * them), so this spec talks to them as those services will: through the
 * generated client for valid rows, and through plain SQL for every row the
 * database must refuse, because the client would stop a bad enum value before
 * the database ever saw it and the point here is the database's own floor.
 *
 * It owns its rows (every id starts with "ads03-spec-"), deletes them after
 * each test, and checks at the end that every table in the schema has the row
 * count it had when the spec began, so it leaves the test database as it
 * found it and passes alone, first, last or twice in a row.
 */
const PREFIX = 'ads03-spec-';
const NOW = new Date('2026-10-18T00:00:00.000Z');
const LATER = new Date('2026-10-19T00:00:00.000Z');

const CAMPAIGN_SQL = `INSERT INTO "AdCampaign"
  (id, advertiser, placement, status, "startsAt", "endsAt", weight, "updatedAt")
  VALUES ($1, $2, $3, $4, $5, $6, $7, now())`;
const CREATIVE_SQL = `INSERT INTO "AdCreative"
  (id, "campaignId", headline, subline, "ctaLabel", "ctaDestination", "ctaDestinationId", "artworkUrl", "updatedAt")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`;

function databaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.search = '';
  return url.toString();
}

describe('Ads data model (ADS-03)', () => {
  const prisma = new PrismaService();
  const db = new Client({ connectionString: databaseUrl() });
  let countsBefore: Record<string, number> = {};

  /** Row count of every table in the public schema. */
  async function allCounts(): Promise<Record<string, number>> {
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    const counts: Record<string, number> = {};
    for (const { tablename } of tables.rows) {
      const r = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${tablename}"`,
      );
      counts[tablename] = Number(r.rows[0].n);
    }
    return counts;
  }

  async function cleanUp(): Promise<void> {
    // The creative goes with its campaign (ON DELETE CASCADE).
    await db.query(`DELETE FROM "AdCampaign" WHERE id LIKE $1`, [`${PREFIX}%`]);
  }

  /** The SQLSTATE and constraint name a statement was refused with. */
  async function refusal(
    sql: string,
    params: unknown[],
  ): Promise<{ code?: string; constraint?: string }> {
    try {
      await db.query(sql, params);
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      return { code: err.code, constraint: err.constraint };
    }
    throw new Error('the database accepted a row it must refuse');
  }

  async function campaign(
    id: string,
    over: Partial<{
      advertiser: string;
      placement: string;
      status: string;
      startsAt: Date;
      endsAt: Date;
      weight: number;
    }> = {},
  ): Promise<void> {
    const c = {
      advertiser: 'Spec Advertiser',
      placement: 'tgif_card',
      status: 'draft',
      startsAt: NOW,
      endsAt: LATER,
      weight: 1,
      ...over,
    };
    await db.query(CAMPAIGN_SQL, [
      id,
      c.advertiser,
      c.placement,
      c.status,
      c.startsAt,
      c.endsAt,
      c.weight,
    ]);
  }

  beforeAll(async () => {
    await prisma.$connect();
    await db.connect();
    await cleanUp();
    countsBefore = await allCounts();
  });

  afterEach(cleanUp);

  afterAll(async () => {
    await cleanUp();
    const after = await allCounts();
    await db.end();
    await prisma.$disconnect();
    // A table the spec added rows to and did not clean would show here.
    expect(after).toEqual(countsBefore);
  });

  describe('a valid card', () => {
    it('stores a campaign with its creative and reads every field back', async () => {
      await prisma.adCampaign.create({
        data: {
          id: `${PREFIX}full`,
          advertiser: 'Gospel Night Live',
          placement: 'tgif_card',
          status: 'scheduled',
          startsAt: NOW,
          endsAt: LATER,
          weight: 40,
          creative: {
            create: {
              id: `${PREFIX}full-creative`,
              headline: 'Gospel Night Live',
              subline: 'Abuja · Sat 18 October',
              ctaLabel: 'Get tickets',
              ctaDestination: 'event',
              ctaDestinationId: 'some-event-id',
              artworkUrl: 'https://storage.example/ads/gnl.jpg',
            },
          },
        },
      });

      const row = await prisma.adCampaign.findUniqueOrThrow({
        where: { id: `${PREFIX}full` },
        include: { creative: true },
      });
      expect(row).toMatchObject({
        advertiser: 'Gospel Night Live',
        placement: 'tgif_card',
        status: 'scheduled',
        weight: 40,
      });
      expect(row.startsAt.toISOString()).toBe(NOW.toISOString());
      expect(row.endsAt.toISOString()).toBe(LATER.toISOString());
      expect(row.creative).toMatchObject({
        campaignId: `${PREFIX}full`,
        headline: 'Gospel Night Live',
        subline: 'Abuja · Sat 18 October',
        ctaLabel: 'Get tickets',
        ctaDestination: 'event',
        ctaDestinationId: 'some-event-id',
        artworkUrl: 'https://storage.example/ads/gnl.jpg',
      });
    });

    it('defaults a new campaign to draft with weight 1, and a card to no subline and no artwork', async () => {
      await prisma.adCampaign.create({
        data: {
          id: `${PREFIX}defaults`,
          advertiser: 'Defaults Ltd',
          placement: 'today_slot',
          startsAt: NOW,
          endsAt: LATER,
          creative: {
            create: {
              headline: 'Headline',
              ctaLabel: 'Open',
              ctaDestination: 'event',
              ctaDestinationId: 'e1',
            },
          },
        },
      });
      const row = await prisma.adCampaign.findUniqueOrThrow({
        where: { id: `${PREFIX}defaults` },
        include: { creative: true },
      });
      expect(row).toMatchObject({ status: 'draft', weight: 1 });
      expect(row.creative).toMatchObject({ subline: null, artworkUrl: null });
    });

    it('accepts both placements, every status, and the ends of the weight range', async () => {
      let n = 0;
      for (const placement of ['tgif_card', 'today_slot']) {
        for (const status of [
          'draft',
          'scheduled',
          'live',
          'paused',
          'ended',
        ]) {
          await campaign(`${PREFIX}ok-${n++}`, { placement, status });
        }
      }
      await campaign(`${PREFIX}ok-w1`, { weight: 1 });
      await campaign(`${PREFIX}ok-w100`, { weight: 100 });
      const r = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "AdCampaign" WHERE id LIKE $1`,
        [`${PREFIX}ok-%`],
      );
      expect(r.rows[0].n).toBe(12);
    });
  });

  describe('the serving query (ADS-04)', () => {
    const SERVE = `SELECT c.id FROM "AdCampaign" c JOIN "AdCreative" a ON a."campaignId" = c.id
      WHERE c.placement = $1 AND c.status IN ('scheduled', 'live')
        AND c."startsAt" <= $2 AND c."endsAt" > $2
      ORDER BY c.weight DESC, c."startsAt" ASC`;

    it('finds only a servable campaign for the placement whose window holds the moment', async () => {
      const moment = new Date('2026-10-18T12:00:00.000Z');
      const day = (d: number) => new Date(`2026-10-${d}T00:00:00.000Z`);
      const rows: Array<[string, Record<string, unknown>]> = [
        ['live-low', { status: 'live', weight: 1 }],
        ['live-high', { status: 'scheduled', weight: 9 }],
        ['paused', { status: 'paused', weight: 100 }],
        ['draft', { status: 'draft', weight: 100 }],
        ['ended', { status: 'ended', weight: 100 }],
        ['before', { status: 'live', startsAt: day(19), endsAt: day(20) }],
        ['after', { status: 'live', startsAt: day(10), endsAt: day(11) }],
        ['other-slot', { status: 'live', placement: 'today_slot' }],
        // endsAt is exclusive: a window that ends at the moment is over.
        ['ends-now', { status: 'live', endsAt: moment }],
      ];
      for (const [name, over] of rows) {
        const id = `${PREFIX}serve-${name}`;
        await campaign(id, { startsAt: day(18), endsAt: day(19), ...over });
        await db.query(CREATIVE_SQL, [
          `${id}-c`,
          id,
          'h',
          null,
          'Go',
          'event',
          'e',
          null,
        ]);
      }
      const served = await db.query<{ id: string }>(SERVE, [
        'tgif_card',
        moment,
      ]);
      expect(served.rows.map((r) => r.id)).toEqual([
        `${PREFIX}serve-live-high`,
        `${PREFIX}serve-live-low`,
      ]);
    });

    it('is answered from the placement, status and window index', async () => {
      await db.query('BEGIN');
      try {
        // A table this small is read in full by default; this asks whether the
        // index could answer the filter, which is what ADS-04 depends on.
        await db.query('SET LOCAL enable_seqscan = off');
        const plan = await db.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT id FROM "AdCampaign"
             WHERE placement = 'tgif_card' AND status IN ('scheduled', 'live')
               AND "startsAt" <= now() AND "endsAt" > now()`,
        );
        const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
        expect(text).toContain(
          'AdCampaign_placement_status_startsAt_endsAt_idx',
        );
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  describe('what the database refuses on a campaign', () => {
    it.each<[string, { placement?: string; status?: string }]>([
      ['a placement outside tgif_card and today_slot', { placement: 'banner' }],
      ['an empty placement', { placement: '' }],
      ['a status outside the five', { status: 'archived' }],
      ['an upper-case status', { status: 'LIVE' }],
    ])('refuses %s (an enum)', async (_name, over) => {
      const r = await refusal(CAMPAIGN_SQL, [
        `${PREFIX}bad-enum`,
        'Adv',
        over.placement ?? 'tgif_card',
        over.status ?? 'draft',
        NOW,
        LATER,
        1,
      ]);
      expect(r.code).toBe('22P02');
    });

    it('refuses a window that ends before it starts, or at the same instant', async () => {
      for (const [startsAt, endsAt] of [
        [LATER, NOW],
        [NOW, NOW],
      ]) {
        const r = await refusal(CAMPAIGN_SQL, [
          `${PREFIX}bad-window`,
          'Adv',
          'tgif_card',
          'draft',
          startsAt,
          endsAt,
          1,
        ]);
        expect(r).toEqual({
          code: '23514',
          constraint: 'AdCampaign_window_check',
        });
      }
    });

    it.each([0, -1, 101, 1000])('refuses a weight of %i', async (weight) => {
      const r = await refusal(CAMPAIGN_SQL, [
        `${PREFIX}bad-weight`,
        'Adv',
        'tgif_card',
        'draft',
        NOW,
        LATER,
        weight,
      ]);
      expect(r).toEqual({
        code: '23514',
        constraint: 'AdCampaign_weight_check',
      });
    });

    it.each(['', '   ', '\t\n'])(
      'refuses a blank advertiser (%j)',
      async (a) => {
        const r = await refusal(CAMPAIGN_SQL, [
          `${PREFIX}bad-adv`,
          a,
          'tgif_card',
          'draft',
          NOW,
          LATER,
          1,
        ]);
        expect(r).toEqual({
          code: '23514',
          constraint: 'AdCampaign_advertiser_check',
        });
      },
    );

    it('refuses a missing placement, start or end (NOT NULL)', async () => {
      for (const [i, args] of [
        [2, [`${PREFIX}nn`, 'Adv', null, 'draft', NOW, LATER, 1]],
        [4, [`${PREFIX}nn`, 'Adv', 'tgif_card', 'draft', null, LATER, 1]],
        [5, [`${PREFIX}nn`, 'Adv', 'tgif_card', 'draft', NOW, null, 1]],
      ] as Array<[number, unknown[]]>) {
        const r = await refusal(CAMPAIGN_SQL, args);
        expect({ i, code: r.code }).toEqual({ i, code: '23502' });
      }
    });
  });

  describe('what the database refuses on a creative', () => {
    const good = (campaignId: string) => [
      `${campaignId}-c`,
      campaignId,
      'Headline',
      'Subline',
      'Get tickets',
      'event',
      'e1',
      'https://storage.example/a.jpg',
    ];
    const withArg = (campaignId: string, index: number, value: unknown) => {
      const a = good(campaignId);
      a[index] = value as string;
      return a;
    };

    it('refuses a creative with no campaign, or a campaign that does not exist', async () => {
      const none = await refusal(CREATIVE_SQL, withArg('x', 1, null));
      expect(none.code).toBe('23502');
      const missing = await refusal(CREATIVE_SQL, good(`${PREFIX}no-such`));
      expect(missing).toEqual({
        code: '23503',
        constraint: 'AdCreative_campaignId_fkey',
      });
    });

    it('refuses a second creative for one campaign', async () => {
      const id = `${PREFIX}one`;
      await campaign(id);
      await db.query(CREATIVE_SQL, good(id));
      const second = withArg(id, 0, `${id}-second`);
      const r = await refusal(CREATIVE_SQL, second);
      expect(r).toEqual({
        code: '23505',
        constraint: 'AdCreative_campaignId_key',
      });
    });

    it.each([['url'], ['creator'], ['https://evil.example'], [''], ['EVENT']])(
      'refuses the destination %j, which is not on the allow-list',
      async (d) => {
        const id = `${PREFIX}dest`;
        await campaign(id);
        const r = await refusal(CREATIVE_SQL, withArg(id, 5, d));
        expect(r.code).toBe('22P02');
      },
    );

    it('refuses a missing destination kind or id', async () => {
      const id = `${PREFIX}dest-null`;
      await campaign(id);
      expect((await refusal(CREATIVE_SQL, withArg(id, 5, null))).code).toBe(
        '23502',
      );
      expect((await refusal(CREATIVE_SQL, withArg(id, 6, null))).code).toBe(
        '23502',
      );
    });

    it.each([
      ['headline', 2],
      ['ctaLabel', 4],
      ['ctaDestinationId', 6],
    ])('refuses a blank %s', async (_name, index) => {
      const id = `${PREFIX}blank`;
      await campaign(id);
      for (const blank of ['', '  ']) {
        const r = await refusal(CREATIVE_SQL, withArg(id, index, blank));
        expect(r).toEqual({
          code: '23514',
          constraint: 'AdCreative_text_check',
        });
      }
    });

    it('allows no subline but not a blank one', async () => {
      const id = `${PREFIX}subline`;
      await campaign(id);
      const r = await refusal(CREATIVE_SQL, withArg(id, 3, '  '));
      expect(r).toEqual({ code: '23514', constraint: 'AdCreative_text_check' });
      await db.query(CREATIVE_SQL, withArg(id, 3, null));
    });

    it.each([
      ['javascript:alert(1)'],
      ['data:image/png;base64,AAAA'],
      ['ftp://storage.example/a.jpg'],
      ['//storage.example/a.jpg'],
      ['https://'],
      ['https://has space.example/a.jpg'],
      ['storage.example/a.jpg'],
    ])('refuses the artwork %j (not an http or https link)', async (url) => {
      const id = `${PREFIX}art`;
      await campaign(id);
      const r = await refusal(CREATIVE_SQL, withArg(id, 7, url));
      expect(r).toEqual({
        code: '23514',
        constraint: 'AdCreative_artworkUrl_check',
      });
    });

    it('accepts http and https artwork, and none', async () => {
      for (const [i, url] of [
        'http://localhost:9000/ads/a.jpg',
        'https://storage.example/a.jpg?X-Amz-Signature=abc&x=1',
        null,
      ].entries()) {
        const id = `${PREFIX}art-ok-${i}`;
        await campaign(id);
        await db.query(CREATIVE_SQL, withArg(id, 7, url));
      }
    });
  });

  describe('how the two tables hang together', () => {
    it('removes the creative with its campaign', async () => {
      const id = `${PREFIX}cascade`;
      await campaign(id);
      await db.query(CREATIVE_SQL, [
        `${id}-c`,
        id,
        'H',
        null,
        'Go',
        'event',
        'e',
        null,
      ]);
      const gone = await db.query(`DELETE FROM "AdCampaign" WHERE id = $1`, [
        id,
      ]);
      expect(gone.rowCount).toBe(1);
      const left = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "AdCreative" WHERE "campaignId" = $1`,
        [id],
      );
      expect(left.rows[0].n).toBe(0);
    });

    it('removing a creative leaves its campaign', async () => {
      const id = `${PREFIX}keep`;
      await campaign(id);
      await db.query(CREATIVE_SQL, [
        `${id}-c`,
        id,
        'H',
        null,
        'Go',
        'event',
        'e',
        null,
      ]);
      await db.query(`DELETE FROM "AdCreative" WHERE id = $1`, [`${id}-c`]);
      const left = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "AdCampaign" WHERE id = $1`,
        [id],
      );
      expect(left.rows[0].n).toBe(1);
    });

    it('does not let a campaign be edited into a state the checks refuse', async () => {
      const id = `${PREFIX}edit`;
      await campaign(id);
      const window = await refusal(
        `UPDATE "AdCampaign" SET "endsAt" = "startsAt" WHERE id = $1`,
        [id],
      );
      expect(window.constraint).toBe('AdCampaign_window_check');
      const weight = await refusal(
        `UPDATE "AdCampaign" SET weight = 0 WHERE id = $1`,
        [id],
      );
      expect(weight.constraint).toBe('AdCampaign_weight_check');
      const status = await refusal(
        `UPDATE "AdCampaign" SET status = 'archived' WHERE id = $1`,
        [id],
      );
      expect(status.code).toBe('22P02');
    });
  });

  describe('the weight range', () => {
    it('is the same in ads-limits.ts and in the database CHECK', async () => {
      const r = await db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'AdCampaign_weight_check'`,
      );
      expect(r.rows).toHaveLength(1);
      const def = r.rows[0].def;
      const min = /weight"?\s*>=\s*(\d+)/.exec(def);
      const max = /weight"?\s*<=\s*(\d+)/.exec(def);
      expect(min && Number(min[1])).toBe(AD_WEIGHT_MIN);
      expect(max && Number(max[1])).toBe(AD_WEIGHT_MAX);
    });

    it('accepts the constants and refuses one step outside them', async () => {
      await campaign(`${PREFIX}wmin`, { weight: AD_WEIGHT_MIN });
      await campaign(`${PREFIX}wmax`, { weight: AD_WEIGHT_MAX });
      for (const weight of [AD_WEIGHT_MIN - 1, AD_WEIGHT_MAX + 1]) {
        await campaign(`${PREFIX}wout`, { weight }).then(
          () => {
            throw new Error('accepted');
          },
          (e: { constraint?: string }) =>
            expect(e.constraint).toBe('AdCampaign_weight_check'),
        );
      }
    });
  });

  describe('text that draws as nothing is blank, in any locale (D2)', () => {
    // Each of these alone, and in a run of itself, draws nothing.
    const INVISIBLE: Array<[string, string]> = [
      ['NBSP U+00A0', '\u00A0'],
      ['ZWSP U+200B', '\u200B'],
      ['ZWNJ U+200C', '\u200C'],
      ['ZWJ U+200D', '\u200D'],
      ['WORD JOINER U+2060', '\u2060'],
      ['BOM U+FEFF', '\uFEFF'],
      ['EM SPACE U+2003', '\u2003'],
      ['IDEOGRAPHIC SPACE U+3000', '\u3000'],
      ['NARROW NBSP U+202F', '\u202F'],
      ['LINE SEPARATOR U+2028', '\u2028'],
      ['LRM U+200E', '\u200E'],
      ['SOFT HYPHEN U+00AD', '\u00AD'],
      ['COMBINING GRAPHEME JOINER U+034F', '\u034F'],
      ['MONGOLIAN VOWEL SEPARATOR U+180E', '\u180E'],
      ['HANGUL FILLER U+3164', '\u3164'],
      ['VARIATION SELECTOR U+FE0F', '\uFE0F'],
      ['tab', '\t'],
      ['newline', '\n'],
      ['carriage return', '\r'],
      ['space', ' '],
      ['a lone control character U+0001', '\u0001'],
      ['DEL U+007F', '\u007F'],
      ['NEL U+0085', '\u0085'],
      ['a mix of them', ' \u00A0\u200B\uFEFF\t\n\u3000 '],
    ];
    const cases: Array<[string, string]> = INVISIBLE.flatMap(([n, v]) => [
      [n, v],
      [`${n} repeated`, v.repeat(3)],
    ]);

    const columns: Array<[string, (value: string) => Promise<unknown>]> = [
      ['advertiser', (v) => campaign(`${PREFIX}inv-adv`, { advertiser: v })],
      ['headline', (v) => creativeWith(2, v)],
      ['ctaLabel', (v) => creativeWith(4, v)],
      ['ctaDestinationId', (v) => creativeWith(6, v)],
      ['subline', (v) => creativeWith(3, v)],
    ];

    async function creativeWith(index: number, value: string): Promise<void> {
      const id = `${PREFIX}inv-cr`;
      await db.query(
        `INSERT INTO "AdCampaign" (id, advertiser, placement, status, "startsAt", "endsAt", weight, "updatedAt")
         VALUES ($1, 'Adv', 'tgif_card', 'draft', $2, $3, 1, now()) ON CONFLICT DO NOTHING`,
        [id, NOW, LATER],
      );
      const args: unknown[] = [
        `${id}-c`,
        id,
        'H',
        'S',
        'Go',
        'event',
        'e',
        null,
      ];
      args[index] = value;
      await db.query(CREATIVE_SQL, args);
    }

    it.each(columns)('refuses a %s of nothing visible', async (_c, write) => {
      const failures: string[] = [];
      for (const [name, value] of cases) {
        await cleanUp();
        try {
          await write(value);
          failures.push(name);
        } catch (e) {
          if ((e as { code?: string }).code !== '23514') failures.push(name);
        }
      }
      // The names of every value the database accepted, so a failure says which.
      expect(failures).toEqual([]);
    });

    it.each(columns)(
      'still accepts a %s with a visible character among them',
      async (_c, write) => {
        for (const value of [
          'Gospel\u00A0Night',
          '\u200BA',
          'A\uFEFF',
          ' \u3000x\u2003 ',
          'Zo\u200Dë',
          'a',
          '\u00E9',
          '\u4E2D',
        ]) {
          await cleanUp();
          await write(value);
        }
      },
    );
  });

  describe('what it does not hold', () => {
    it('has no price, payment or person column (R-15, invoiced by hand)', async () => {
      const r = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ('AdCampaign', 'AdCreative')`,
      );
      const names = r.rows.map((c) => c.column_name).sort();
      expect(names).toEqual(
        [
          // AdCampaign
          'id',
          'advertiser',
          'placement',
          'status',
          'startsAt',
          'endsAt',
          'weight',
          'createdAt',
          'updatedAt',
          // AdCreative
          'id',
          'campaignId',
          'headline',
          'subline',
          'ctaLabel',
          'ctaDestination',
          'ctaDestinationId',
          'artworkUrl',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      expect(
        names.filter((n) => /price|kobo|amount|pay|wawu/i.test(n)),
      ).toEqual([]);
    });
  });
});
