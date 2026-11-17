/**
 * ADS-SWAP (owner, 16 Nov 2026): "Update the ads on the WHO made this app please, remove the current ones and replace
 * with these." WRITTEN, NOT RUN by the task that wrote it: the owner runs it on the server, through the manual
 * workflow .github/workflows/ads-swap-1116.yml or by hand.
 *
 * It ends every current ad campaign (status scheduled, live or paused) and puts three new ones on air, each with one
 * landscape picture from scripts/ops/ads-1116/. Drafts and ended campaigns are not touched.
 *
 *   dry run (default)  writes and uploads nothing; prints every current campaign, what the new three will take, and the
 *                      confirmation phrase (it carries the count of campaigns to end and a short hash of their ids).
 *   apply              needs --apply AND --confirm "<the exact phrase the dry run printed>". Uploads the three pictures
 *                      with the Hub's own StorageService.putAdArtwork, then ONE transaction ends the current campaigns
 *                      and creates the three.
 *
 * The three new campaigns have fixed ids (NEW_ADS below), so a second run finds them and does nothing.
 *
 * Link, end and weight of the new ones are COPIED from the campaign being replaced: the first current campaign, in
 * AD_TIE_BREAK order, that is ON AIR (live or scheduled), inside its window, shows in the landscape places and opens a link; only when there is none, a paused one. startsAt is now.
 *   --link <https url>   use this link instead (the rule the admin API uses for ctaUrl: checkCtaUrl)
 *   --ends <UTC instant> use this end instead, like 2026-12-31T23:59:59Z (must be in the future)
 *   --weight <n>         use this weight instead (a whole number, the range the admin API allows)
 * With no campaign to copy a link from and no --link, or an end that is not in the future and no --ends, the dry run says
 * so and --apply refuses, writing nothing.
 *
 * What it writes, and where that was read (src/admin/ads/admin-ads.service.ts, ad-campaign-state.ts):
 *   end    transition(): status -> ended by a conditional update (where status is what was read), and an AdminAdAudit row
 *          { action ended, previousStatus, newStatus ended, changes { status: { from, to } } }. No other field changes.
 *   create create(): a draft with its creative and an AdminAdAudit row { action created, previousStatus null, newStatus draft,
 *          changes: diff(null, snapshotOf(...)) }; then transition('schedule'): status draft -> onAirStatus(startsAt, now)
 *          (live, because startsAt is now) and a row { action scheduled, draft -> live, changes { status } }.
 * Who the audit rows name: AdminAdAudit keeps adminId, adminEmail and adminRole as plain snapshots with no foreign key to
 * AdminUser, and this command has no admin. It does not invent one: adminId is the marker `ops:ads-swap-1116`
 * (matches no AdminUser), adminEmail is `ops-command@wawu.invalid` (an address that cannot exist) and adminRole is
 * `superadmin`, the one role the enum has for someone who can run commands on the server. Nothing else is written: no AdEvent,
 * no AdDailyTotal.
 *
 * Inside the transaction the AdCampaign table is locked against writes (SHARE ROW EXCLUSIVE; reads and serving go on), the
 * campaigns to end are locked FOR UPDATE, and the phrase is recomputed from a fresh read: it binds every current advert (id, status,
 * weight, window, place, tap, link), the advert the values are copied from, and the link, end and weight the new ones will take after the
 * flags. A booking, end, pause, resume or edit since the dry run, or other flags, refuses and writes nothing. Prints no email, phone or name of a person: ads hold none, and a picture's address is
 * printed as the last part of its object key only.
 *
 * On record: a later run ends an advert booked after the three, behind a new phrase; and pictures already uploaded stay in the
 * bucket, harmless, when a race is lost or the transaction fails.
 *
 *   cd /srv/wawu/hub-api
 *   set -a; . /etc/wawu/hub-api.env; set +a
 *   node dist/scripts/ops/ads-swap-1116.js
 *   node dist/scripts/ops/ads-swap-1116.js --apply --confirm "<phrase>" [--link https://...] [--ends 2026-12-31T23:59:59Z]
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '../../generated/prisma/client';
import type { AdCampaignStatus } from '../../generated/prisma/enums';
import { diff, snapshotOf } from '../../src/admin/ads/admin-ads.service';
import { onAirStatus } from '../../src/admin/ads/ad-campaign-state';
import { derivedPlacement } from '../../src/admin/ads/ad-pictures-input';
import {
  checkCtaUrl,
  isHubArtworkShape,
  parseUtcInstant,
} from '../../src/admin/ads/ad-text';
import { AD_WEIGHT_MAX, AD_WEIGHT_MIN } from '../../src/ads/ads-limits';
import { showsIn } from '../../src/ads/ads-pictures';
import {
  AD_TIE_BREAK,
  servableCampaigns,
  type ServingDeps,
} from '../../src/ads/ads-serving';
import type { AdPlacementName } from '../../src/ads/dto/ads.dto';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  AD_ARTWORK_MAX_BYTES,
  sniffAdArtwork,
} from '../../src/storage/ad-artwork';
import { StorageModule } from '../../src/storage/storage.module';
import { StorageService } from '../../src/storage/storage.service';

/** The three new campaigns, in the order the app shows them. Fixed ids: a second run finds them. */
export const NEW_ADS = [
  {
    id: '70391042-b688-42c7-b66e-547314d561bb',
    advertiser: 'WAWU with SOUEAST',
    headline: 'Drive.',
    subline: 'Gifted to one creator.',
    file: '1-drive-car.png',
  },
  {
    id: 'e71b0059-e2f8-43e4-a430-7f60913ad5a9',
    advertiser: 'WAWU',
    headline: '5 DJI Osmo Pocket 3.',
    subline: 'Shoot your next big thing.',
    file: '2-dji-osmo-pocket-3.png',
  },
  {
    id: '19fdc589-622e-451e-ab67-e249ef470b0a',
    advertiser: 'WAWU with VERGIO',
    headline: '4 Gaming Systems.',
    subline: 'Built to create.',
    file: '3-gaming-systems.png',
  },
] as const;

export const CTA_LABEL = 'Register now';
export const PICTURE_DIR = 'scripts/ops/ads-1116';
/** The marker the audit rows carry as "who": no AdminUser has this id (see the header). */
export const AUDIT_ADMIN = {
  adminId: 'ops:ads-swap-1116',
  adminEmail: 'ops-command@wawu.invalid',
  adminRole: 'superadmin',
} as const;
const CURRENT: AdCampaignStatus[] = ['scheduled', 'live', 'paused'];
const PLACES: AdPlacementName[] = ['explore_slider', 'today_slot', 'tgif_card'];
/** No viewer: nobody is signed in, so nobody is blocked (a card is chosen by its rules alone). */
const NO_VIEWER = '00000000-0000-4000-8000-000000000000';

export interface Deps {
  prisma: PrismaService;
  storage: Pick<StorageService, 'putAdArtwork'>;
  out: (line: string) => void;
  /** Where scripts/ops/ads-1116 is found. The command line uses process.cwd(), the repo root on the server. */
  root: string;
  /** A test hook, never set by the command line: look only at these campaigns (a shared test database holds other specs' ads). */
  onlyIds?: string[];
  /** A test hook, never set by the command line: runs after the pictures are uploaded and before the transaction. */
  beforeTransaction?: () => Promise<void>;
}

export interface Options {
  apply: boolean;
  confirm?: string;
  link?: string;
  ends?: string;
  weight?: string;
}

/** What the new adverts will take, and where it came from. */
export interface Taken {
  link: string | null;
  endsAt: Date | null;
  weight: number;
  sourceId: string | null;
  from: string;
  problems: string[];
}

/**
 * The phrase binds everything the lead read in the dry run: for every current advert, in id order, its id, status, weight,
 * window, place, tap and link; the id the values are copied from; and the link, end and weight the new ones take after the
 * flags. `taken` is null when the three already exist (nothing is created).
 */
export function phraseFor(rows: Row[], taken: Taken | null): string {
  const text = [
    ...[...rows]
      .sort((x, y) => (x.id < y.id ? -1 : 1))
      .map((r) =>
        [
          r.id,
          r.status,
          r.weight,
          iso(r.startsAt),
          iso(r.endsAt),
          r.placement,
          r.creative?.ctaDestination ?? 'none',
          r.creative?.ctaUrl ?? '',
        ].join('|'),
      ),
    `source|${taken?.sourceId ?? 'none'}`,
    taken
      ? `new|${taken.link ?? ''}|${taken.endsAt ? iso(taken.endsAt) : ''}|${taken.weight}`
      : 'new|none',
  ].join('\n');
  return `SWAP ADS: END ${rows.length} CAMPAIGNS ${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

type Db = Pick<
  Prisma.TransactionClient,
  'adCampaign' | 'adminAdAudit' | '$queryRaw'
>;

const withCreative = {
  creative: true,
} satisfies Prisma.AdCampaignInclude;
type Row = Prisma.AdCampaignGetPayload<{ include: typeof withCreative }>;

/** The campaigns to end: current, in AD_TIE_BREAK order, never the three this command makes. */
async function currentCampaigns(
  db: Pick<Db, 'adCampaign'>,
  onlyIds?: string[],
): Promise<Row[]> {
  return db.adCampaign.findMany({
    where: {
      status: { in: CURRENT },
      id: {
        notIn: NEW_ADS.map((n) => n.id),
        ...(onlyIds ? { in: onlyIds } : {}),
      },
    },
    include: withCreative,
    orderBy: [...AD_TIE_BREAK],
  });
}

const last = (url: string | null): string => {
  if (!url) return 'none';
  const tail = url.split(/[?#]/)[0].split('/').pop();
  return tail || 'none';
};
const iso = (d: Date) => d.toISOString();

function describe(r: Row, i: number): string[] {
  const c = r.creative;
  const pictures = c
    ? [
        c.artworkLandscapeUrl && `landscape ${last(c.artworkLandscapeUrl)}`,
        c.artworkPortraitUrl && `portrait ${last(c.artworkPortraitUrl)}`,
        c.artworkUrl && `single ${last(c.artworkUrl)}`,
      ].filter(Boolean)
    : [];
  const tap = !c
    ? 'no card'
    : c.ctaDestination === 'link'
      ? `link ${c.ctaUrl ?? 'none'}`
      : c.ctaDestination === 'event'
        ? 'opens an event'
        : 'nothing (shown only)';
  return [
    `${i + 1}. ${r.id} | ${r.advertiser} | ${c?.headline ?? '(no card)'} | ${r.status} | ${r.placement}${c ? ` (shows in ${showsIn({ placement: r.placement, creative: c }).join(', ') || 'nowhere'})` : ''}`,
    `   window ${iso(r.startsAt)} to ${iso(r.endsAt)}; weight ${r.weight}; a tap: ${tap}; pictures: ${pictures.join(', ') || 'none'}`,
  ];
}

/**
 * The advert the values are copied from: the first one ON AIR (live or scheduled), in AD_TIE_BREAK order, that is in its window,
 * shows in the landscape places and opens a link. Only when there is none, the first paused one that fits.
 */
function sourceOf(rows: Row[], now: Date): Row | null {
  const fits = (r: Row) => {
    const c = r.creative;
    if (!c || c.ctaDestination !== 'link' || !c.ctaUrl) return false;
    if (r.startsAt > now || r.endsAt <= now) return false;
    const places = showsIn({ placement: r.placement, creative: c });
    return places.includes('explore_slider') || places.includes('today_slot');
  };
  return (
    rows.find((r) => r.status !== 'paused' && fits(r)) ??
    rows.find((r) => r.status === 'paused' && fits(r)) ??
    null
  );
}

/** The weight rule the admin API uses (a whole number from AD_WEIGHT_MIN to AD_WEIGHT_MAX), or null. */
function parseWeight(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= AD_WEIGHT_MIN && n <= AD_WEIGHT_MAX ? n : null;
}

/** Works out the link, end and weight the new adverts take, from THIS read of the current adverts and the flags. */
function takeFrom(rows: Row[], opts: Options, now: Date): Taken {
  const src = sourceOf(rows, now);
  const problems: string[] = [];
  let link = src?.creative?.ctaUrl ?? null;
  let endsAt = src ? src.endsAt : null;
  let weight = src ? src.weight : AD_WEIGHT_MIN;
  if (opts.link !== undefined) {
    const checked = checkCtaUrl(opts.link);
    if (checked.ok) link = checked.value;
    else {
      link = null;
      problems.push(`--link is not usable: ${checked.message}`);
    }
  }
  if (opts.ends !== undefined) {
    const parsed = parseUtcInstant(opts.ends);
    if (!parsed)
      problems.push(
        '--ends must be a UTC time like 2026-12-31T23:59:59Z (with the Z).',
      );
    else endsAt = parsed;
  }
  if (opts.weight !== undefined) {
    const w = parseWeight(opts.weight);
    if (w === null)
      problems.push(
        `--weight must be a whole number from ${AD_WEIGHT_MIN} to ${AD_WEIGHT_MAX}.`,
      );
    else weight = w;
  }
  if (link === null && opts.link === undefined)
    problems.push(
      'there is no current campaign to copy a link from (in its window, shown in Explore or Today, opening a link) and no --link was given.',
    );
  if (endsAt === null)
    problems.push(
      'there is no campaign to copy an end from and no --ends was given.',
    );
  else if (endsAt <= now)
    problems.push(
      `the end to use (${iso(endsAt)}) is not in the future. Give --ends.`,
    );
  const how = !src
    ? 'no campaign to copy from; weight is the minimum unless --weight is given'
    : src.status === 'paused'
      ? `copied from campaign ${src.id}, which is PAUSED (no live or scheduled advert had a link to copy)`
      : `copied from campaign ${src.id}, which is ${src.status === 'live' ? 'live' : 'scheduled'} and on air`;
  return {
    link,
    endsAt,
    weight,
    sourceId: src?.id ?? null,
    from: how,
    problems,
  };
}

/** Reads the three pictures from the source tree and checks each really is a PNG. Throws one clear line. */
async function readPictures(root: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const n of NEW_ADS) {
    const path = join(root, PICTURE_DIR, n.file);
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch {
      throw new Error(
        `the picture ${PICTURE_DIR}/${n.file} is missing under ${root}. Run this from the repo root (the deploy puts it at /srv/wawu/hub-api).`,
      );
    }
    if (body.length === 0 || body.length > AD_ARTWORK_MAX_BYTES)
      throw new Error(
        `the picture ${n.file} is empty or over ${AD_ARTWORK_MAX_BYTES} bytes.`,
      );
    if (sniffAdArtwork(body) !== 'image/png')
      throw new Error(`the picture ${n.file} is not a PNG file.`);
    out.push(body);
  }
  return out;
}

/** The error's class name and its code if it has one: never its message, which can hold a file path and source text. */
function errorWords(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number'
    ? `${name} ${code}`
    : name;
}

/** Thrown inside the transaction to stop it with a plain reason. */
class Refused extends Error {}

/** Runs the command. Returns the exit code: 0 done or nothing to do, 1 refused, 2 failed. */
export async function adsSwap(deps: Deps, opts: Options): Promise<number> {
  const { out, prisma } = deps;
  const refuse = (why: string) => {
    out(`REFUSED: ${why}`);
    out('Nothing was changed.');
    return 1;
  };

  let pictures: Buffer[];
  try {
    pictures = await readPictures(deps.root);
  } catch (e) {
    return refuse((e as Error).message);
  }

  const now = new Date();
  const rows = await currentCampaigns(prisma, deps.onlyIds);
  const existing = await prisma.adCampaign.findMany({
    where: { id: { in: NEW_ADS.map((n) => n.id) } },
    select: { id: true },
  });

  out(opts.apply ? 'APPLY' : 'DRY RUN (nothing is written or uploaded)');
  out(`Current campaigns (scheduled, live or paused): ${rows.length}`);
  rows.forEach((r, i) => describe(r, i).forEach(out));

  if (existing.length > 0 && existing.length < NEW_ADS.length)
    return refuse(
      `only ${existing.length} of the three new campaigns exist. This command does not repair a half-made set; look at them first.`,
    );
  const creating = existing.length === 0;
  if (!creating && rows.length === 0) {
    out(
      'The three new campaigns are already there and no other campaign is current. Nothing to do.',
    );
    return 0;
  }

  const taken: Taken | null = creating ? takeFrom(rows, opts, now) : null;
  const phrase = phraseFor(rows, taken);
  if (taken) {
    out(
      `The new campaigns will take: link ${taken.link ?? 'NONE'}; end ${taken.endsAt ? iso(taken.endsAt) : 'NONE'}; weight ${taken.weight}; start now (${taken.from}).`,
    );
    NEW_ADS.forEach((n, i) =>
      out(
        `   new ${i + 1}. ${n.advertiser} | ${n.headline} | ${n.subline} | picture ${n.file} (${pictures[i].length} bytes) | landscape only: shows in explore_slider and today_slot, never tgif_card`,
      ),
    );
    for (const p of taken.problems) out(`CANNOT APPLY: ${p}`);
  } else {
    out(
      'The three new campaigns already exist; this run only ends the campaigns above.',
    );
  }
  out(`Will end: ${rows.length}`);
  out(`Confirmation phrase: ${phrase}`);
  if (!opts.apply) {
    out(
      taken && taken.problems.length > 0
        ? 'Dry run only. Fix what is listed under CANNOT APPLY first.'
        : 'Dry run only. To swap: add --apply --confirm "<the phrase above>".',
    );
    return 0;
  }
  if (taken && taken.problems.length > 0)
    return refuse(taken.problems.join(' '));
  if (opts.confirm === undefined)
    return refuse('--apply needs --confirm with the exact phrase above.');
  if (opts.confirm !== phrase)
    return refuse('the confirmation phrase is not the one printed above.');

  // Pictures go up first, with the Hub's own call, exactly as POST /admin/ads/artwork stores one.
  const urls: string[] = [];
  if (creating) {
    try {
      for (let i = 0; i < NEW_ADS.length; i++) {
        const stored = await deps.storage.putAdArtwork(
          pictures[i],
          'image/png',
        );
        if (!isHubArtworkShape(stored.artworkUrl))
          throw new Error('the stored picture address is not one of ours');
        urls.push(stored.artworkUrl);
        out(`Uploaded ${NEW_ADS[i].file} as ${last(stored.key)}`);
      }
    } catch (e) {
      out(
        `FAILED: a picture could not be uploaded (${errorWords(e)}). ${urls.length} picture(s) already uploaded are left in the bucket and are harmless. The database was not touched.`,
      );
      return 2;
    }
  }
  await deps.beforeTransaction?.();

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE "AdCampaign" IN SHARE ROW EXCLUSIVE MODE`;
        const nowTx = new Date();
        const ids = rows.map((r) => r.id);
        if (ids.length > 0)
          await tx.$queryRaw`SELECT "id" FROM "AdCampaign" WHERE "id" IN (${Prisma.join(ids)}) FOR UPDATE`;
        // Read again under the lock; the source and the values the new ones take are worked out from THIS read.
        const again = await currentCampaigns(tx, deps.onlyIds);
        const takenNow = creating ? takeFrom(again, opts, nowTx) : null;
        if (phraseFor(again, takenNow) !== phrase)
          throw new Refused(
            'what the dry run showed has changed (an advert was booked, ended, paused, resumed or edited). Run the dry run again.',
          );
        if (takenNow && takenNow.problems.length > 0)
          throw new Refused(takenNow.problems.join(' '));
        for (const r of again) {
          const claimed = await tx.adCampaign.updateMany({
            where: { id: r.id, status: r.status },
            data: { status: 'ended' },
          });
          if (claimed.count !== 1)
            throw new Refused('a campaign changed underneath; run it again.');
          await tx.adminAdAudit.create({
            data: {
              campaignId: r.id,
              action: 'ended',
              previousStatus: r.status,
              newStatus: 'ended',
              changes: { status: { from: r.status, to: 'ended' } },
              ...AUDIT_ADMIN,
            },
          });
        }
        if (!creating || !takenNow || !takenNow.link || !takenNow.endsAt)
          return;
        const base = nowTx.getTime();
        for (let i = 0; i < NEW_ADS.length; i++) {
          const n = NEW_ADS[i];
          const created = await tx.adCampaign.create({
            data: {
              id: n.id,
              advertiser: n.advertiser,
              placement: derivedPlacement(urls[i]),
              status: 'draft',
              startsAt: nowTx,
              endsAt: takenNow.endsAt,
              weight: takenNow.weight,
              createdAt: new Date(base + i),
              creative: {
                create: {
                  headline: n.headline,
                  subline: n.subline,
                  ctaLabel: CTA_LABEL,
                  ctaDestination: 'link',
                  ctaDestinationId: null,
                  ctaUrl: takenNow.link,
                  artworkUrl: null,
                  artworkLandscapeUrl: urls[i],
                  artworkPortraitUrl: null,
                },
              },
            },
            include: withCreative,
          });
          await tx.adminAdAudit.create({
            data: {
              campaignId: n.id,
              action: 'created',
              previousStatus: null,
              newStatus: 'draft',
              changes: diff(
                null,
                snapshotOf(created, created.creative!),
              ) as Prisma.InputJsonObject,
              ...AUDIT_ADMIN,
            },
          });
          const to = onAirStatus(created.startsAt, new Date());
          const claimed = await tx.adCampaign.updateMany({
            where: { id: n.id, status: 'draft' },
            data: { status: to },
          });
          if (claimed.count !== 1)
            throw new Refused('a new campaign changed underneath.');
          await tx.adminAdAudit.create({
            data: {
              campaignId: n.id,
              action: 'scheduled',
              previousStatus: 'draft',
              newStatus: to,
              changes: { status: { from: 'draft', to } },
              ...AUDIT_ADMIN,
            },
          });
        }
      },
      { timeout: 60_000, maxWait: 30_000 },
    );
  } catch (e) {
    const note = urls.length
      ? ` The ${urls.length} uploaded picture(s) are left in the bucket and are harmless.`
      : '';
    if (e instanceof Refused) {
      out(`REFUSED: ${e.message} Nothing was changed.${note}`);
      return 1;
    }
    out(
      `FAILED: the swap could not be written (${errorWords(e)}). The transaction was rolled back; nothing was changed.${note}`,
    );
    return 2;
  }

  out(`Ended ${rows.length} campaigns.`);
  await readBack(deps, creating);
  out(
    'Done. Running the dry run again says there is nothing to do. The app shows the new ads on its next fetch.',
  );
  return 0;
}

/** After apply: the new rows as stored, and how many campaigns are served now in each place. */
async function readBack(deps: Deps, created: boolean): Promise<void> {
  const { out, prisma } = deps;
  const rows = await prisma.adCampaign.findMany({
    where: { id: { in: NEW_ADS.map((n) => n.id) } },
    include: withCreative,
    orderBy: [...AD_TIE_BREAK],
  });
  out(`Read back: ${rows.length} of the three new campaigns, in serving order`);
  rows.forEach((r, i) => {
    const c = r.creative;
    out(
      `${i + 1}. ${r.id} | ${r.advertiser} | ${c?.headline} | ${c?.subline} | ${r.status} | ${r.placement} | ${iso(r.startsAt)} to ${iso(r.endsAt)} | weight ${r.weight} | createdAt ${iso(r.createdAt)}`,
    );
    out(
      `   button "${c?.ctaLabel}" opens ${c?.ctaUrl}; landscape ${last(c?.artworkLandscapeUrl ?? null)}; portrait ${last(c?.artworkPortraitUrl ?? null)}; single ${last(c?.artworkUrl ?? null)}`,
    );
  });
  if (!created) return;
  const serving: ServingDeps = {
    prisma,
    blocked: { hiddenFrom: () => Promise.resolve([]) } as never,
  };
  const at = new Date();
  for (const place of PLACES) {
    const mine = deps.onlyIds
      ? new Set([...deps.onlyIds, ...NEW_ADS.map((n) => n.id)])
      : null;
    const served = (
      await servableCampaigns(serving, NO_VIEWER, at, { placement: place })
    ).filter((c) => !mine || mine.has(c.id));
    out(
      `Served now in ${place}: ${served.length}${served.length > 0 ? ` (first: ${served[0].creative.headline})` : ''}`,
    );
  }
}

export function parseArgs(argv: string[]): Options | string {
  const withValue = ['--confirm', '--link', '--ends', '--weight'];
  const known = ['--apply', ...withValue];
  const unknown = argv.filter(
    (a, i) =>
      a.startsWith('--') &&
      !known.includes(a) &&
      !withValue.includes(argv[i - 1]),
  );
  if (unknown.length > 0) return `unknown option ${unknown[0]}.`;
  const opts: Options = { apply: argv.includes('--apply') };
  for (const flag of withValue) {
    const i = argv.indexOf(flag);
    if (i < 0) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--'))
      return 'usage: [--apply --confirm "<phrase>"] [--link <https url>] [--ends <UTC time>] [--weight <n>]';
    opts[flag.slice(2) as 'confirm' | 'link' | 'ends' | 'weight'] = v;
  }
  return opts;
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    StorageModule,
  ],
})
class OpsModule {}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === 'string') {
    console.error(opts);
    return 1;
  }
  const app = await NestFactory.createApplicationContext(OpsModule, {
    logger: ['error', 'warn'],
  });
  try {
    return await adsSwap(
      {
        prisma: app.get(PrismaService, { strict: false }),
        storage: app.get(StorageService, { strict: false }),
        out: (l) => console.log(l),
        root: process.cwd(),
      },
      opts,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(
        `FAILED: the command could not finish (${errorWords(e)}). Nothing was changed.`,
      );
      process.exit(2);
    },
  );
}
