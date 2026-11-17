import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  adsSwap,
  parseArgs,
  AUDIT_ADMIN,
  CTA_LABEL,
  NEW_ADS,
  type Deps,
  type Options,
} from '../../../../scripts/ops/ads-swap-1116';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { servableCampaigns } from '../../../ads/ads-serving';
import { AdsCountsService } from '../../../ads/ads-counts.service';
import { AdsEventsService } from '../../../ads/ads-events.service';
import { AdsService } from '../../../ads/ads.service';
import type { CreateAdCampaignDto } from '../dto/admin-ad.dto';
import { AdminAdsService } from '../admin-ads.service';
import { AD_ARTWORK_KEY } from '../../../storage/ad-artwork';
import { StorageModule } from '../../../storage/storage.module';
import {
  StorageService,
  objectKeyFrom,
} from '../../../storage/storage.service';

/**
 * ADS-SWAP (owner, 16 Nov 2026): the one-time command that ends every current ad and puts three new ones on air.
 * Made-up campaigns only, on the test database; the Hub's real StorageService writes to the local storage stand-in
 * (scripts/dev/storage-standin.cjs). The command is scoped to the specs' own campaigns by its `onlyIds` test hook, so a
 * shared database's other ads are not touched.
 */
const PORT = Number(process.env.ASW_STANDIN_PORT ?? 9951);
const BUCKET = 'asw-bucket';
const DAY = 86_400_000;
const LINK = 'https://example.com/who-made-this-app';
const ROOT = join(__dirname, '../../../..');

describe('ads-swap-1116 (ADS-SWAP)', () => {
  let prisma: PrismaService;
  let storage: StorageService;
  let standin: ChildProcess;
  let closeApp: () => Promise<void>;
  const env: Record<string, string | undefined> = {};
  const seeded: string[] = [];
  const ids: Record<string, string> = {};
  let onlyIds: string[] = [];
  let lines: string[] = [];

  const run = async (
    opts: Partial<Options> = {},
    over: Partial<Deps> = {},
  ): Promise<number> => {
    lines = [];
    return adsSwap(
      {
        prisma,
        storage,
        out: (l) => lines.push(l),
        root: ROOT,
        onlyIds,
        ...over,
      },
      { apply: false, ...opts },
    );
  };
  const text = () => lines.join('\n');
  const phrase = () => /Confirmation phrase: (.*)/.exec(text())![1];

  const counts = async () => ({
    campaigns: await prisma.adCampaign.count(),
    creatives: await prisma.adCreative.count(),
    audits: await prisma.adminAdAudit.count(),
    events: await prisma.adEvent.count(),
    totals: await prisma.adDailyTotal.count(),
    objects: (await standinKeys()).length,
  });
  async function standinKeys(): Promise<string[]> {
    const r = await fetch(`http://127.0.0.1:${PORT}/__standin/state`);
    return ((await r.json()) as { keys: string[] }).keys;
  }
  async function statuses(keys: string[]): Promise<Record<string, string>> {
    const rows = await prisma.adCampaign.findMany({
      where: { id: { in: keys.map((k) => ids[k]) } },
    });
    const out: Record<string, string> = {};
    for (const r of rows)
      out[keys.find((k) => ids[k] === r.id) ?? r.id] = r.status;
    return out;
  }

  async function seed(
    key: string,
    status: 'draft' | 'scheduled' | 'live' | 'paused' | 'ended',
    o: {
      weight?: number;
      kind?: 'link' | 'none' | 'event';
      endsInDays?: number;
      endsAt?: Date;
      portrait?: boolean;
      both?: boolean;
    } = {},
  ) {
    const id = randomUUID();
    ids[key] = id;
    seeded.push(id);
    const kind = o.kind ?? 'link';
    await prisma.adCampaign.create({
      data: {
        id,
        advertiser: `asw ${key}`,
        placement: o.portrait ? 'tgif_card' : 'explore_slider',
        status,
        startsAt: new Date(Date.now() - 2 * DAY),
        endsAt: o.endsAt ?? new Date(Date.now() + (o.endsInDays ?? 20) * DAY),
        weight: o.weight ?? 1,
        creative: {
          create: {
            headline: `asw ${key}`,
            subline: null,
            ctaLabel: kind === 'none' ? null : 'Open',
            ctaDestination: kind,
            ctaDestinationId: kind === 'event' ? randomUUID() : null,
            ctaUrl: kind === 'link' ? `${LINK}/${key}` : null,
            artworkLandscapeUrl:
              o.portrait && !o.both
                ? null
                : `https://example.com/ads/artwork/${key}.png`,
            artworkPortraitUrl:
              o.portrait || o.both
                ? `https://example.com/ads/artwork/${key}-p.png`
                : null,
          },
        },
      },
    });
    onlyIds.push(id);
    return id;
  }

  beforeAll(async () => {
    for (const k of [
      'STORAGE_ENDPOINT',
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY',
      'STORAGE_BUCKET',
      'STORAGE_REGION',
      'STORAGE_FORCE_PATH_STYLE',
    ])
      env[k] = process.env[k];
    process.env.STORAGE_ENDPOINT = `http://127.0.0.1:${PORT}`;
    process.env.STORAGE_ACCESS_KEY_ID = 'asw-key';
    process.env.STORAGE_SECRET_ACCESS_KEY = 'asw-secret';
    process.env.STORAGE_BUCKET = BUCKET;
    process.env.STORAGE_REGION = 'auto';
    process.env.STORAGE_FORCE_PATH_STYLE = 'true';
    standin = spawn(
      process.execPath,
      [
        join(__dirname, '../../../../scripts/dev/storage-standin.cjs'),
        String(PORT),
        BUCKET,
      ],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/__standin/state`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        StorageModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    storage = moduleRef.get(StorageService);
    closeApp = () => moduleRef.close();

    // Current campaigns of every kind, plus a draft and an ended one that must be left alone.
    await seed('live', 'live', { weight: 7, endsInDays: 30 });
    await seed('sched', 'scheduled', { weight: 3 });
    await seed('paused', 'paused', { weight: 1, portrait: true });
    await seed('draft', 'draft');
    await seed('ended', 'ended');
    // The new three may be left by an earlier failed run of this spec.
    await prisma.adminAdAudit.deleteMany({
      where: { campaignId: { in: NEW_ADS.map((n) => n.id) } },
    });
    await prisma.adCampaign.deleteMany({
      where: { id: { in: NEW_ADS.map((n) => n.id) } },
    });
  });

  afterAll(async () => {
    const all = [...seeded, ...NEW_ADS.map((n) => n.id)];
    await prisma.adEvent.deleteMany({ where: { campaignId: { in: all } } });
    await prisma.adDailyTotal.deleteMany({
      where: { campaignId: { in: all } },
    });
    await prisma.adminAdAudit.deleteMany({
      where: { campaignId: { in: all } },
    });
    await prisma.adCampaign.deleteMany({ where: { id: { in: all } } });
    await closeApp();
    standin.kill();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('parses its flags and refuses unknown ones', () => {
    expect(
      parseArgs([
        '--apply',
        '--confirm',
        'x y',
        '--link',
        'https://a.b',
        '--ends',
        '2030-01-01T00:00:00Z',
      ]),
    ).toEqual({
      apply: true,
      confirm: 'x y',
      link: 'https://a.b',
      ends: '2030-01-01T00:00:00Z',
    });
    expect(typeof parseArgs(['--nope'])).toBe('string');
    expect(typeof parseArgs(['--link'])).toBe('string');
  });

  it('dry run writes and uploads nothing, lists the current campaigns and prints the phrase', async () => {
    const before = await counts();
    expect(await run()).toBe(0);
    expect(await counts()).toEqual(before);
    const t = text();
    expect(t).toContain('DRY RUN');
    expect(t).toContain('Current campaigns (scheduled, live or paused): 3');
    for (const k of ['live', 'sched', 'paused']) expect(t).toContain(ids[k]);
    expect(t).not.toContain(ids.draft);
    expect(t).not.toContain(ids.ended);
    expect(t).toContain(`link ${LINK}/live`);
    const liveEnd = (
      await prisma.adCampaign.findUniqueOrThrow({ where: { id: ids.live } })
    ).endsAt.toISOString();
    expect(t).toContain(
      `link ${LINK}/live; end ${liveEnd}; weight 7; start now (copied from campaign ${ids.live}, which is live and on air)`,
    );
    expect(phrase()).toMatch(/^SWAP ADS: END 3 CAMPAIGNS [0-9a-f]{8}$/);
    // no signed picture address, no person
    expect(t).not.toMatch(/X-Amz|@/);
  });

  it('refuses without the phrase or with a wrong one, and writes nothing', async () => {
    const before = await counts();
    expect(await run({ apply: true })).toBe(1);
    expect(text()).toContain('needs --confirm');
    expect(
      await run({ apply: true, confirm: 'SWAP ADS: END 3 CAMPAIGNS 00000000' }),
    ).toBe(1);
    expect(text()).toContain('not the one printed');
    expect(await counts()).toEqual(before);
  });

  it('refuses when there is no link to copy and none given, and when the end is in the past', async () => {
    const before = await counts();
    const saved = [...onlyIds];
    // Nothing current at all: there is nothing to copy from.
    onlyIds = [];
    expect(await run()).toBe(0);
    expect(text()).toContain(
      'CANNOT APPLY: there is no current campaign to copy from',
    );
    // Only a card that opens an event is current: its tap is not copied (adverts are not tied to events).
    const none = await seed('nolink', 'live', { kind: 'event' });
    onlyIds = [none];
    expect(await run()).toBe(0);
    expect(text()).toContain('opens an event');
    const p = phrase();
    expect(await run({ apply: true, confirm: p })).toBe(1);
    expect(text()).toContain('REFUSED');
    expect(await counts()).toEqual({
      ...before,
      campaigns: before.campaigns + 1,
      creatives: before.creatives + 1,
    });
    // A link given by hand is checked by the admin API's own rule.
    expect(
      await run({
        link: 'http://insecure.example.com',
        ends: '2099-01-01T00:00:00Z',
      }),
    ).toBe(0);
    expect(text()).toContain('--link is not usable');
    // An end in the past is refused whoever gave it.
    onlyIds = saved;
    expect(await run({ ends: '2020-01-01T00:00:00Z' })).toBe(0);
    expect(text()).toContain('is not in the future');
    expect(
      await run({
        apply: true,
        confirm: phrase(),
        ends: '2020-01-01T00:00:00Z',
      }),
    ).toBe(1);
    expect(text()).toContain('REFUSED');
    expect(await run({ ends: 'tomorrow' })).toBe(0);
    expect(text()).toContain('--ends must be a UTC time');
    await prisma.adCampaign.delete({ where: { id: none } });
    seeded.splice(seeded.indexOf(none), 1);
    expect(
      await statuses(['live', 'sched', 'paused', 'draft', 'ended']),
    ).toEqual({
      live: 'live',
      sched: 'scheduled',
      paused: 'paused',
      draft: 'draft',
      ended: 'ended',
    });
    expect((await counts()).audits).toBe(before.audits);
    expect((await counts()).objects).toBe(0);
  });

  it('refuses, and writes nothing, when a campaign is booked between the dry run and the apply', async () => {
    await run();
    const p = phrase();
    const before = await counts();
    const code = await run(
      { apply: true, confirm: p },
      {
        beforeTransaction: async () => {
          await seed('late', 'live');
        },
      },
    );
    expect(code).toBe(1);
    expect(text()).toContain('has changed');
    expect(text()).toContain('left in the bucket and are harmless');
    expect(await statuses(['live', 'sched', 'paused'])).toEqual({
      live: 'live',
      sched: 'scheduled',
      paused: 'paused',
    });
    const after = await counts();
    expect(after.campaigns).toBe(before.campaigns + 1); // only the late one the hook made
    expect(after.audits).toBe(before.audits);
    expect(after.objects).toBe(before.objects + 3);
    expect(
      await prisma.adCampaign.count({
        where: { id: { in: NEW_ADS.map((n) => n.id) } },
      }),
    ).toBe(0);
    // The late one is now part of what the swap ends: take it out for the real run below.
    await prisma.adCampaign.delete({ where: { id: ids.late } });
    seeded.splice(seeded.indexOf(ids.late), 1);
    onlyIds = onlyIds.filter((i) => i !== ids.late);
  });

  /** An apply whose dry run is made first and whose world is changed by `mutate` just before the transaction. */
  async function staleBetween(
    mutate: () => Promise<void>,
    restore: () => Promise<void>,
  ) {
    await run();
    const p = phrase();
    const before = await counts();
    const code = await run(
      { apply: true, confirm: p },
      { beforeTransaction: mutate },
    );
    const refusal = text();
    await restore();
    expect(code).toBe(1);
    expect(refusal).toContain('has changed');
    expect(
      await statuses(['live', 'sched', 'paused', 'draft', 'ended']),
    ).toEqual({
      live: 'live',
      sched: 'scheduled',
      paused: 'paused',
      draft: 'draft',
      ended: 'ended',
    });
    const after = await counts();
    expect(after.campaigns).toBe(before.campaigns);
    expect(after.audits).toBe(before.audits);
    expect(
      await prisma.adCampaign.count({
        where: { id: { in: NEW_ADS.map((n) => n.id) } },
      }),
    ).toBe(0);
  }

  it('refuses when an advert is paused between the dry run and the apply (then resumed after)', async () => {
    await staleBetween(
      async () => {
        await prisma.adCampaign.update({
          where: { id: ids.live },
          data: { status: 'paused' },
        });
      },
      async () => {
        await prisma.adCampaign.update({
          where: { id: ids.live },
          data: { status: 'live' },
        });
      },
    );
  });

  it('refuses when weight, link or end of an advert is edited between the dry run and the apply', async () => {
    const row = await prisma.adCampaign.findUniqueOrThrow({
      where: { id: ids.live },
    });
    await staleBetween(
      async () => {
        await prisma.adCampaign.update({
          where: { id: ids.live },
          data: { weight: 8 },
        });
      },
      async () => {
        await prisma.adCampaign.update({
          where: { id: ids.live },
          data: { weight: 7 },
        });
      },
    );
    await staleBetween(
      async () => {
        await prisma.adCreative.update({
          where: { campaignId: ids.live },
          data: { ctaUrl: `${LINK}/CHANGED` },
        });
      },
      async () => {
        await prisma.adCreative.update({
          where: { campaignId: ids.live },
          data: { ctaUrl: `${LINK}/live` },
        });
      },
    );
    await staleBetween(
      async () => {
        await prisma.adCampaign.update({
          where: { id: ids.live },
          data: { endsAt: new Date(row.endsAt.getTime() + DAY) },
        });
      },
      async () => {
        await prisma.adCampaign.update({
          where: { id: ids.live },
          data: { endsAt: row.endsAt },
        });
      },
    );
  });

  it('refuses the same phrase used with a different --link, --ends or --weight, before anything is uploaded', async () => {
    const ends1 = '2098-01-01T00:00:00Z';
    const cases: [Partial<Options>, Partial<Options>][] = [
      [{ weight: '9' }, { weight: '10' }],
      [
        { link: 'https://example.com/one' },
        { link: 'https://example.com/two' },
      ],
      [{ ends: ends1 }, { ends: '2098-01-02T00:00:00Z' }],
      [{}, { weight: '9' }],
    ];
    for (const [dry, applied] of cases) {
      await run(dry);
      const p = phrase();
      const before = await counts();
      expect(await run({ apply: true, confirm: p, ...applied })).toBe(1);
      expect(text()).toContain('not the one printed');
      expect(await counts()).toEqual(before);
    }
  });

  it('--weight is checked by the admin rule and shown in the dry run', async () => {
    for (const bad of ['0', '101', 'x', '2.5', '-1', '']) {
      expect(await run({ weight: bad })).toBe(0);
      expect(text()).toContain('CANNOT APPLY: --weight must be a whole number');
    }
    expect(await run({ weight: '12' })).toBe(0);
    expect(text()).toContain('weight 12; start now');
    expect(text()).not.toContain('CANNOT APPLY');
    expect(await run({ apply: true, confirm: phrase(), weight: '0' })).toBe(1);
  });

  it('a heavier paused advert no longer beats a live one as the source, and the line says the status', async () => {
    const heavy = await seed('heavy', 'paused', { weight: 9 });
    expect(await run()).toBe(0);
    expect(text()).toContain(
      `weight 7; start now (copied from campaign ${ids.live}, which is live and on air)`,
    );
    expect(text()).not.toContain(`copied from campaign ${heavy}`);
    // With nothing else on air, the paused one is the source, and the line says so.
    const saved = onlyIds;
    onlyIds = [heavy];
    expect(await run()).toBe(0);
    expect(text()).toContain(
      `weight 9; start now (copied from campaign ${heavy}, which is PAUSED`,
    );
    onlyIds = saved.filter((i) => i !== heavy);
    await prisma.adCampaign.delete({ where: { id: heavy } });
    seeded.splice(seeded.indexOf(heavy), 1);
  });

  it('a failure prints a plain sentence with the class name, no path and no cut source text', async () => {
    const boom = Object.assign(
      new Error(
        'Invalid `x` invocation in /srv/secret/path.js:294:53 INSERT INTO',
      ),
      {
        code: 'P2002',
      },
    );
    await run();
    const code = await run(
      { apply: true, confirm: phrase() },
      {
        storage: {
          putAdArtwork: () => Promise.reject(boom),
        },
      },
    );
    expect(code).toBe(2);
    expect(text()).toContain('(Error P2002)');
    expect(text()).toContain('The database was not touched');
    expect(text()).not.toMatch(/\/srv|INSERT|invocation/);
  });

  it('apply ends scheduled, live and paused, leaves draft and ended alone, and makes the three', async () => {
    // A live advert outside the command's scope, as on a database that holds other adverts: it is left alone
    // and not counted in the read-back.
    await seed('outsider', 'live', { weight: 50 });
    onlyIds = onlyIds.filter((i) => i !== ids.outsider);
    const live = await prisma.adCampaign.findUniqueOrThrow({
      where: { id: ids.live },
    });
    await run();
    const p = phrase();
    const before = await counts();
    const t0 = Date.now();
    expect(await run({ apply: true, confirm: p })).toBe(0);
    const t = text();
    expect(t).toContain('Ended 3 campaigns.');
    expect(
      await statuses(['live', 'sched', 'paused', 'draft', 'ended']),
    ).toEqual({
      live: 'ended',
      sched: 'ended',
      paused: 'ended',
      draft: 'draft',
      ended: 'ended',
    });
    // Only the ends and the three campaigns changed: no event, no daily total.
    const after = await counts();
    expect(after.campaigns).toBe(before.campaigns + 3);
    expect(after.creatives).toBe(before.creatives + 3);
    expect(after.audits).toBe(before.audits + 3 + 6);
    expect(after.events).toBe(before.events);
    expect(after.totals).toBe(before.totals);
    expect(after.objects).toBe(before.objects + 3);

    // The ends: the same row the admin end route writes, naming the command as the actor.
    const ended = await prisma.adminAdAudit.findMany({
      where: { campaignId: ids.live },
      orderBy: { seq: 'asc' },
    });
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      action: 'ended',
      previousStatus: 'live',
      newStatus: 'ended',
      changes: { status: { from: 'live', to: 'ended' } },
      ...AUDIT_ADMIN,
    });
    // Nothing else of an ended campaign changed.
    const live2 = await prisma.adCampaign.findUniqueOrThrow({
      where: { id: ids.live },
      include: { creative: true },
    });
    expect({
      ...live2,
      status: 'live',
      updatedAt: live.updatedAt,
      creative: null,
    }).toEqual({ ...live, creative: null });

    // The three, in order, in the state create-then-schedule leaves them in.
    const rows = await prisma.adCampaign.findMany({
      where: { id: { in: NEW_ADS.map((n) => n.id) } },
      include: { creative: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual(NEW_ADS.map((n) => n.id));
    rows.forEach((r, i) => {
      const n = NEW_ADS[i];
      expect(r).toMatchObject({
        advertiser: n.advertiser,
        status: 'live',
        placement: 'explore_slider',
        weight: 7,
      });
      expect(r.startsAt.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
      expect(r.startsAt.getTime()).toBe(rows[0].startsAt.getTime());
      expect(r.createdAt.getTime() - rows[0].createdAt.getTime()).toBe(i);
      expect(r.endsAt.getTime()).toBe(live.endsAt.getTime());
      expect(r.creative).toMatchObject({
        headline: n.headline,
        subline: n.subline,
        ctaLabel: CTA_LABEL,
        ctaDestination: 'link',
        ctaDestinationId: null,
        ctaUrl: `${LINK}/live`,
        artworkUrl: null,
        artworkPortraitUrl: null,
      });
      expect(
        AD_ARTWORK_KEY.test(objectKeyFrom(r.creative!.artworkLandscapeUrl!)),
      ).toBe(true);
    });
    const audits = await prisma.adminAdAudit.findMany({
      where: { campaignId: NEW_ADS[0].id },
      orderBy: { seq: 'asc' },
    });
    expect(
      audits.map((a) => [a.action, a.previousStatus, a.newStatus]),
    ).toEqual([
      ['created', null, 'draft'],
      ['scheduled', 'draft', 'live'],
    ]);
    expect(audits[0].changes).toMatchObject({
      advertiser: { from: null, to: NEW_ADS[0].advertiser },
      ctaUrl: { from: null, to: `${LINK}/live` },
    });
    expect(audits.every((a) => a.adminId === AUDIT_ADMIN.adminId)).toBe(true);

    // What the app is served: the three in order in Explore, the first on Today, none in TGIF.
    const serving = {
      prisma,
      blocked: { hiddenFrom: () => Promise.resolve([]) } as never,
    };
    const mine = (r: { id: string }) => NEW_ADS.some((n) => n.id === r.id);
    const at = new Date();
    const explore = (
      await servableCampaigns(serving, randomUUID(), at, {
        placement: 'explore_slider',
      })
    ).filter(mine);
    expect(explore.map((c) => c.id)).toEqual(NEW_ADS.map((n) => n.id));
    const today = (
      await servableCampaigns(serving, randomUUID(), at, {
        placement: 'today_slot',
      })
    ).filter(mine);
    expect(today[0].id).toBe(NEW_ADS[0].id);
    expect(
      (
        await servableCampaigns(serving, randomUUID(), at, {
          placement: 'tgif_card',
        })
      ).filter(mine),
    ).toEqual([]);

    // The report: a read-back and the counts by place, with no signed address.
    expect(t).toContain('Read back: 3 of the three new campaigns');
    expect(t).toContain('Served now in explore_slider: 3');
    expect(await statuses(['outsider'])).toEqual({ outsider: 'live' });
    expect(t).toContain('Served now in tgif_card: 0');
    expect(t).not.toMatch(/X-Amz|@/);
  });

  it('a second run finds the three and does nothing', async () => {
    const before = await counts();
    expect(await run()).toBe(0);
    expect(text()).toContain('Nothing to do');
    expect(await run({ apply: true, confirm: 'anything' })).toBe(0);
    expect(text()).toContain('Nothing to do');
    expect(await counts()).toEqual(before);
  });

  // ── fix round 2: a source whose tap does nothing is copied ──────────────────────────────────────────
  const END = new Date('2027-01-29T05:14:58.000Z');
  const viewer = randomUUID();
  const noBlocks = { hiddenFrom: () => Promise.resolve([]) } as never;

  async function dropAll(extra: string[] = []) {
    const all = [...extra, ...NEW_ADS.map((n) => n.id)];
    await prisma.adEvent.deleteMany({ where: { campaignId: { in: all } } });
    await prisma.adDailyTotal.deleteMany({
      where: { campaignId: { in: all } },
    });
    await prisma.adminAdAudit.deleteMany({
      where: { campaignId: { in: all } },
    });
    await prisma.adCampaign.deleteMany({ where: { id: { in: all } } });
    for (const id of extra) {
      if (seeded.includes(id)) seeded.splice(seeded.indexOf(id), 1);
    }
    onlyIds = onlyIds.filter((i) => !extra.includes(i));
  }

  it('the live server case: four adverts that do nothing are ended and replaced by three that do nothing', async () => {
    await dropAll();
    onlyIds = [];
    const four: string[] = [];
    for (const [i, w] of [40, 30, 20, 10].entries())
      four.push(
        await seed(`four${i}`, 'live', {
          weight: w,
          kind: 'none',
          both: true,
          endsAt: END,
        }),
      );
    expect(await run()).toBe(0);
    expect(text()).toContain(
      `The new campaigns will take: a tap does nothing (shown only); end 2027-01-29T05:14:58.000Z; weight 40; start now (copied from campaign ${four[0]}, which is live and on air).`,
    );
    expect(text()).not.toContain('CANNOT APPLY');
    expect(await run({ apply: true, confirm: phrase() })).toBe(0);
    expect(text()).toContain('Ended 4 campaigns.');
    expect(text()).toContain('no button, a tap does nothing');
    expect(
      Object.values(await statuses(['four0', 'four1', 'four2', 'four3'])),
    ).toEqual(['ended', 'ended', 'ended', 'ended']);

    const rows = await prisma.adCampaign.findMany({
      where: { id: { in: NEW_ADS.map((n) => n.id) } },
      include: { creative: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual(NEW_ADS.map((n) => n.id));
    for (const r of rows) {
      expect(r).toMatchObject({ status: 'live', weight: 40 });
      expect(r.endsAt.getTime()).toBe(END.getTime());
      expect(r.creative).toMatchObject({
        ctaDestination: 'none',
        ctaLabel: null,
        ctaUrl: null,
        ctaDestinationId: null,
        artworkUrl: null,
        artworkPortraitUrl: null,
      });
    }

    // What the app is served: Explore 1, 2, 3; Today 1; TGIF none of ours; no link, no label on the card.
    const serving = { prisma, blocked: noBlocks };
    const mine = (r: { id: string }) => NEW_ADS.some((n) => n.id === r.id);
    const at = new Date();
    const explore = (
      await servableCampaigns(serving, viewer, at, {
        placement: 'explore_slider',
      })
    ).filter(mine);
    expect(explore.map((c) => c.id)).toEqual(NEW_ADS.map((n) => n.id));
    expect(
      (
        await servableCampaigns(serving, viewer, at, {
          placement: 'today_slot',
        })
      ).filter(mine)[0].id,
    ).toBe(NEW_ADS[0].id);
    expect(
      (
        await servableCampaigns(serving, viewer, at, {
          placement: 'tgif_card',
        })
      ).filter(mine),
    ).toEqual([]);
    const cards = (
      await new AdsService(prisma, noBlocks, storage, () => new Date()).slider(
        viewer,
      )
    ).filter(mine);
    expect(cards).toHaveLength(3);
    for (const c of cards) {
      expect(c.ctaDestination).toBe('none');
      expect(c).not.toHaveProperty('ctaLabel');
      expect(c).not.toHaveProperty('ctaUrl');
    }

    // Counting: the app's rule counts a view and a tap for a card that does nothing, once a day each (ads-events.service.ts).
    const events = new AdsEventsService(prisma, noBlocks, () => new Date());
    await events.record(viewer, NEW_ADS[0].id, 'view');
    await events.record(viewer, NEW_ADS[0].id, 'tap');
    await events.record(viewer, NEW_ADS[0].id, 'tap');
    expect(
      await prisma.adEvent.groupBy({
        by: ['type'],
        where: { campaignId: NEW_ADS[0].id },
        _count: { _all: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'view', _count: { _all: 1 } }),
        expect.objectContaining({ type: 'tap', _count: { _all: 1 } }),
      ]),
    );

    // The rows are field for field what POST /admin/ads with ctaDestination none, then schedule, leaves.
    const admin = {
      id: randomUUID(),
      email: 'twin@test.invalid',
      name: 'twin',
      role: 'superadmin',
      status: 'active',
      lastLoginAt: null,
      createdAt: new Date(),
    } as const;
    const svc = new AdminAdsService(
      prisma,
      new AdsCountsService(prisma),
      storage,
    );
    const pic = await storage.putAdArtwork(
      await readFile(join(ROOT, 'scripts/ops/ads-1116/1-drive-car.png')),
      'image/png',
    );
    const made = await svc.create(
      {
        advertiser: NEW_ADS[0].advertiser,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: END.toISOString(),
        weight: 40,
        creative: {
          headline: NEW_ADS[0].headline,
          subline: NEW_ADS[0].subline,
          ctaDestination: 'none',
          landscapeUrl: pic.artworkUrl,
        },
      } as unknown as CreateAdCampaignDto,
      admin,
    );
    const twinId = made.campaign.id;
    seeded.push(twinId);
    await svc.schedule(twinId, admin);
    const load = (id: string) =>
      prisma.adCampaign.findUniqueOrThrow({
        where: { id },
        include: { creative: true },
      });
    const strip = (r: Awaited<ReturnType<typeof load>>) => {
      const { creative, ...c } = r;
      const cr = { ...creative! };
      return {
        c: {
          advertiser: c.advertiser,
          placement: c.placement,
          status: c.status,
          weight: c.weight,
          endsAt: c.endsAt,
        },
        cr: {
          headline: cr.headline,
          subline: cr.subline,
          ctaLabel: cr.ctaLabel,
          ctaDestination: cr.ctaDestination,
          ctaDestinationId: cr.ctaDestinationId,
          ctaUrl: cr.ctaUrl,
          artworkUrl: cr.artworkUrl,
          artworkPortraitUrl: cr.artworkPortraitUrl,
          landscapeIsStored: AD_ARTWORK_KEY.test(
            objectKeyFrom(cr.artworkLandscapeUrl!),
          ),
        },
      };
    };
    expect(strip(await load(NEW_ADS[0].id))).toEqual(strip(await load(twinId)));
    const trail = async (id: string) =>
      (
        await prisma.adminAdAudit.findMany({
          where: { campaignId: id },
          orderBy: { seq: 'asc' },
        })
      ).map((a) => {
        const ch = { ...((a.changes ?? {}) as Record<string, unknown>) };
        delete ch.startsAt; // the instant of the run
        delete ch.landscapeUrl; // each holds its own stored picture
        return [a.action, a.previousStatus, a.newStatus, ch];
      });
    expect(await trail(NEW_ADS[0].id)).toEqual(await trail(twinId));
    await dropAll([...four, twinId]);
  });

  it('--link over a none source gives three link adverts with "Register now"', async () => {
    await dropAll();
    onlyIds = [];
    const a = await seed('nl', 'live', {
      weight: 6,
      kind: 'none',
      endsAt: END,
    });
    const link = 'https://example.com/chosen';
    await run({ link });
    expect(text()).toContain(
      `The new campaigns will take: link ${link}; end 2027-01-29T05:14:58.000Z; weight 6`,
    );
    const p = phrase();
    expect(await run({ apply: true, confirm: p, link })).toBe(0);
    const rows = await prisma.adCreative.findMany({
      where: { campaignId: { in: NEW_ADS.map((n) => n.id) } },
    });
    expect(rows).toHaveLength(3);
    for (const r of rows)
      expect(r).toMatchObject({
        ctaDestination: 'link',
        ctaLabel: 'Register now',
        ctaUrl: link,
        ctaDestinationId: null,
      });
    await dropAll([a]);
  });

  it('an event source is refused without --link and accepted with it', async () => {
    await dropAll();
    onlyIds = [];
    const a = await seed('ev', 'live', { weight: 4, kind: 'event' });
    expect(await run()).toBe(0);
    expect(text()).toContain('opens an event');
    expect(text()).toContain('CANNOT APPLY');
    const before = await counts();
    expect(await run({ apply: true, confirm: phrase() })).toBe(1);
    expect(text()).toContain('REFUSED');
    expect(await counts()).toEqual(before);
    expect(await run({ link: 'https://example.com/ev' })).toBe(0);
    expect(text()).not.toContain('CANNOT APPLY');
    expect(text()).toContain('link https://example.com/ev');
    await dropAll([a]);
  });

  it('the phrase binds the tap: a source that changes tap, or a --link added, is refused', async () => {
    await dropAll();
    onlyIds = [];
    const a = await seed('tap', 'live', { weight: 5, kind: 'none' });
    // A different --link than the dry run's.
    await run();
    const p = phrase();
    const before = await counts();
    expect(
      await run({ apply: true, confirm: p, link: 'https://example.com/late' }),
    ).toBe(1);
    expect(text()).toContain('not the one printed');
    expect(await counts()).toEqual(before);
    // The source's tap changes between the dry run and the transaction.
    expect(
      await run(
        { apply: true, confirm: p },
        {
          beforeTransaction: async () => {
            await prisma.adCreative.update({
              where: { campaignId: a },
              data: {
                ctaDestination: 'link',
                ctaLabel: 'Open',
                ctaUrl: 'https://example.com/now-a-link',
              },
            });
          },
        },
      ),
    ).toBe(1);
    expect(text()).toContain('has changed');
    expect(await statuses(['tap'])).toEqual({ tap: 'live' });
    await dropAll([a]);
  });
});
