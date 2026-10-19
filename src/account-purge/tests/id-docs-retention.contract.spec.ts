// SETTINGS-09 (R-73): a deleted account's ID documents are kept, hidden, for the
// days in the admin setting `id_docs_keep_days` (1826 = 5 years) after the
// deletion completed, then a daily sweep deletes the files and their rows.
//
// The people are made the way SETTINGS-06 leaves them: their files uploaded, the
// real purge run (it sets the ID documents aside under `deleted-account` and
// leaves the objects), the deletion marked `purged` on a chosen day. The bucket
// is a small server on this machine's loopback (7860 to 7867) that answers
// DELETE like S3 does: 204, 404 for a missing key, 500 on demand, slowly on
// demand. No real storage is called.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { AdminRole } from '../../../generated/prisma/enums';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DELETED_CREATOR_ID } from '../../content-piece/deleted-creator';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { StorageRemover } from '../../storage/storage-remover';
import { AccountPurgeModule } from '../account-purge.module';
import { AccountPurgeService } from '../account-purge.service';
import {
  ID_DOCS_KEEP_DAYS_LAUNCH,
  ID_DOCS_KEEP_DAYS_SETTING,
  ID_DOCS_RETENTION_CRON,
  ID_DOCS_RETENTION_NAME,
} from '../id-docs-retention.config';
import { IdDocsRetentionModule } from '../id-docs-retention.module';
import { IdDocsRetentionService } from '../id-docs-retention.service';

jest.setTimeout(180_000);

const DAY = 86_400_000;
const BUCKET = 'settings09-bucket';
const ENV: Record<string, string> = {
  STORAGE_ACCESS_KEY_ID: 'settings09-key',
  STORAGE_SECRET_ACCESS_KEY: 'settings09-secret',
  STORAGE_BUCKET: BUCKET,
  STORAGE_REGION: 'auto',
  STORAGE_FORCE_PATH_STYLE: 'true',
  STORAGE_REQUEST_TIMEOUT_MS: '2000',
};
const ADMIN = {
  id: 'settings09-admin',
  email: 'settings09@admin.test.wawu.dev',
  role: AdminRole.superadmin,
};

describe('SETTINGS-09: the ID documents of a deleted account are deleted after the days kept', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let purge: AccountPurgeService;
  let settings: PlanSettingsService;
  let sweep: IdDocsRetentionService;
  let remover: StorageRemover;
  let host: Server;
  const snapshot: Record<string, string | undefined> = {};

  /** What the bucket holds, which keys it refuses, every DELETE it was sent, and how slowly it answers. */
  const stored = new Set<string>();
  const refuse = new Set<string>();
  const deletes: string[] = [];
  let delayMs = 0;

  const made = {
    people: [] as string[],
    pieces: [] as string[],
    events: [] as string[],
    keys: [] as string[],
  };

  const keyOf = (url: string | undefined) =>
    decodeURIComponent((url ?? '').split('?')[0]).replace(`/${BUCKET}/`, '');

  async function listen(): Promise<number> {
    host = createServer((req, res) => {
      const key = keyOf(req.url);
      if (req.method !== 'DELETE') {
        res.statusCode = 405;
        res.end();
        return;
      }
      void (async () => {
        deletes.push(key);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (refuse.has(key)) res.statusCode = 500;
        else if (stored.delete(key)) res.statusCode = 204;
        else res.statusCode = 404;
        res.end();
      })();
    });
    for (let port = 7860; port <= 7867; port++) {
      const ok = await new Promise<boolean>((resolve) => {
        host.once('error', () => resolve(false));
        host.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (ok) return (host.address() as AddressInfo).port;
    }
    throw new Error('no free port in 7860-7867');
  }

  const resetSetting = async () => {
    await prisma.planSetting.deleteMany({
      where: { key: ID_DOCS_KEEP_DAYS_SETTING },
    });
    await prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: ADMIN.id },
    });
    await settings.refresh();
  };

  beforeAll(async () => {
    const port = await listen();
    Object.assign(ENV, { STORAGE_ENDPOINT: `http://127.0.0.1:${port}` });
    for (const [k, v] of Object.entries(ENV)) {
      snapshot[k] = process.env[k];
      process.env[k] = v;
    }
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AccountPurgeModule,
        IdDocsRetentionModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    purge = moduleRef.get(AccountPurgeService);
    settings = moduleRef.get(PlanSettingsService, { strict: false });
    sweep = moduleRef.get(IdDocsRetentionService);
    remover = moduleRef.get(StorageRemover, { strict: false });
    await resetSetting();
  });

  afterAll(async () => {
    await prisma.purchase.deleteMany({
      where: { contentId: { in: made.pieces } },
    });
    await prisma.accountDeletionContent.deleteMany({
      where: { contentPieceId: { in: made.pieces } },
    });
    await prisma.contentPiece.deleteMany({
      where: { id: { in: made.pieces } },
    });
    await prisma.event.deleteMany({ where: { id: { in: made.events } } });
    await prisma.verificationSubmission.deleteMany({
      where: { wawuUserId: { in: made.people } },
    });
    await prisma.accountDeletion.deleteMany({
      where: { wawuUserId: { in: made.people } },
    });
    await prisma.storageObject.deleteMany({
      where: { key: { in: made.keys } },
    });
    await resetSetting();
    await moduleRef.close();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    delayMs = 0;
    refuse.clear();
    deletes.length = 0;
    // The people of an earlier test must not be due in this one.
    await prisma.accountDeletion.deleteMany({
      where: { wawuUserId: { in: made.people } },
    });
    await resetSetting();
  });

  /** A file somebody uploaded: an object in the bucket and its row. */
  async function upload(
    owner: string,
    folder: string,
    ext = 'jpg',
    contentType = 'image/jpeg',
  ): Promise<string> {
    const key = `${folder}/${owner}/${randomUUID()}.${ext}`;
    stored.add(key);
    made.keys.push(key);
    await prisma.storageObject.create({
      data: {
        wawuUserId: owner,
        key,
        bytes: 100,
        contentType,
        folder,
        status: 'confirmed',
        confirmedAt: new Date(),
      },
    });
    return key;
  }

  const person = () => {
    const id = randomUUID();
    made.people.push(id);
    return id;
  };

  /**
   * A person whose deletion completed `daysAgo` days ago (or `minutesAgo`
   * more), made by the real purge: it sets the ID documents aside under
   * `deleted-account`, deletes the avatar, and keeps what a buyer paid for and
   * an event image that still stands.
   */
  async function deleted(
    purgedAt: Date,
    opts: { withDocuments?: boolean } = {},
  ) {
    const withDocuments = opts.withDocuments ?? true;
    const p = person();
    const docs: string[] = [];
    const t = {
      avatar: await upload(p, 'avatars'),
      standingBanner: await upload(p, 'event/banner'),
      soldPreview: await upload(p, 'content/preview'),
      soldFull: await upload(p, 'content/full', 'pdf', 'application/pdf'),
    };
    if (withDocuments) {
      docs.push(
        await upload(p, 'kyc/id-document'),
        await upload(
          p,
          'service-application/document',
          'pdf',
          'application/pdf',
        ),
        await upload(p, 'professional/document', 'pdf', 'application/pdf'),
      );
      // A verification document the client filed in a folder meant for something else.
      const verificationDoc = await upload(p, 'avatars');
      docs.push(verificationDoc);
      await prisma.verificationSubmission.create({
        data: {
          wawuUserId: p,
          tier: 'verified_user',
          documents: [verificationDoc],
        },
      });
    }
    const id = randomUUID();
    made.pieces.push(id);
    await prisma.contentPiece.create({
      data: {
        id,
        slug: `settings09-${id}`,
        creatorWawuId: p,
        contentType: 'pdf',
        title: 'A guide',
        description: 'A guide.',
        category: 'beauty',
        tags: [],
        specializations: [],
        accessType: 'paid',
        price: 500000,
        previewAssetUrl: t.soldPreview,
        fullAssetUrl: t.soldFull,
        status: 'live',
      },
    });
    await prisma.purchase.create({
      data: {
        contentId: id,
        type: 'content',
        buyerWawuId: randomUUID(),
        creatorWawuId: p,
        amount: 500000,
        commissionRate: '0.15',
        flutterwaveTxRef: `settings09-${randomUUID()}`,
        status: 'completed',
      },
    });
    const event = await prisma.event.create({
      data: {
        hostWawuId: 'erased-host',
        name: 'A kept event',
        description: 'Its host left; buyers still hold tickets.',
        hostOrg: 'Org',
        format: 'in_person',
        type: 'workshop',
        startsAt: new Date(Date.now() - DAY),
        location: 'Lagos',
        status: 'removed',
        bannerUrl: `https://bucket.example/${BUCKET}/${t.standingBanner}?X-Amz-Signature=x`,
      },
    });
    made.events.push(event.id);

    await prisma.accountDeletion.create({
      data: {
        wawuUserId: p,
        status: 'purging',
        scheduledAt: new Date(Date.now() - 31 * DAY),
        purgeAfter: new Date(Date.now() - 60_000),
        identityMarkedAt: new Date(),
      },
    });
    deletes.length = 0;
    const out = await purge.purge(p);
    expect(out.failed).toEqual([]);
    await prisma.accountDeletion.update({
      where: { wawuUserId: p },
      data: { status: 'purged', purgedAt },
    });
    deletes.length = 0;
    return { p, docs, ...t };
  }

  const ago = (days: number, extraMs = 0) =>
    new Date(Date.now() - days * DAY - extraMs);

  const rowsFor = (key: string) =>
    prisma.storageObject.findUnique({ where: { key } });
  const holdsAll = (...keys: string[]) => keys.every((k) => stored.has(k));
  const goneFrom = (...keys: string[]) => keys.every((k) => !stored.has(k));
  const rowsGone = async (...keys: string[]) =>
    (await prisma.storageObject.count({ where: { key: { in: keys } } })) === 0;
  const rowsKept = async (...keys: string[]) =>
    (await prisma.storageObject.count({ where: { key: { in: keys } } })) ===
    keys.length;
  const deletion = (p: string) =>
    prisma.accountDeletion.findUniqueOrThrow({ where: { wawuUserId: p } });

  it('the setting is a registry row, 1826 days at launch, an owner figure, and a bad value is refused', async () => {
    expect(ID_DOCS_KEEP_DAYS_LAUNCH).toBe(1826);
    const view = settings
      .describe()
      .settings.find((s) => s.key === ID_DOCS_KEEP_DAYS_SETTING)!;
    expect(view).toMatchObject({
      value: 1826,
      default: 1826,
      unit: 'days',
      source: 'default',
    });
    expect(view.provisional).toBeNull();
    expect(settings.number(ID_DOCS_KEEP_DAYS_SETTING)).toBe(1826);
    for (const bad of [0, 5, 364, 3651, 1826.5, '1826', null as never]) {
      if (bad === null) continue;
      await expect(
        settings.set(ADMIN, { settings: { [ID_DOCS_KEEP_DAYS_SETTING]: bad } }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(settings.number(ID_DOCS_KEEP_DAYS_SETTING)).toBe(1826);
    await settings.set(ADMIN, {
      settings: { [ID_DOCS_KEEP_DAYS_SETTING]: 2000 },
    });
    expect(settings.number(ID_DOCS_KEEP_DAYS_SETTING)).toBe(2000);
    const audit = await prisma.adminOpsAudit.findMany({
      where: {
        resource: 'plan_setting',
        resourceId: ID_DOCS_KEEP_DAYS_SETTING,
      },
    });
    expect(audit).toHaveLength(1);
  });

  it('the daily job is registered at 03:41 under its name, and the account module loads it', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ScheduleModule.forRoot(),
        PrismaModule,
        IdDocsRetentionModule,
      ],
    }).compile();
    const own = mod.createNestApplication();
    await own.init();
    try {
      const job = own.get(SchedulerRegistry).getCronJob(ID_DOCS_RETENTION_NAME);
      expect(job.cronTime.source).toBe(ID_DOCS_RETENTION_CRON);
      expect(ID_DOCS_RETENTION_CRON).toBe('41 3 * * *');
    } finally {
      await own.close();
    }
    // AccountModule (mounted by AppModule) lists the module. Read as text, so
    // this spec does not load the wallet code the account module reaches.
    const accountModule = readFileSync('src/account/account.module.ts', 'utf8');
    expect(accountModule).toMatch(
      /imports: \[[^\]]*\bIdDocsRetentionModule\b[^\]]*\]/s,
    );
  });

  it('deletes the files and rows of an account whose deletion completed more than the days ago, and only those; not due by one day is left', async () => {
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const due = await deleted(at(1827)); // one day more than the days kept
    const edge = await deleted(at(1826)); // exactly the days: not "more than"
    const notDue = await deleted(at(1825)); // one day short
    const fresh = await deleted(now); // just now
    expect(due.docs).toHaveLength(4);
    expect(holdsAll(...due.docs, ...notDue.docs)).toBe(true);
    expect(await rowsKept(...due.docs)).toBe(true);
    // The purge set them aside under the deleted account.
    expect((await rowsFor(due.docs[0]))!.wawuUserId).toBe(DELETED_CREATOR_ID);

    const report = await sweep.run(now);
    expect(report).toMatchObject({
      skipped: null,
      days: 1826,
      accountsFinished: 1,
      accountsLeft: 0,
      filesErased: 4,
    });

    // Due: the four ID documents are out of the bucket and their rows are gone.
    expect(goneFrom(...due.docs)).toBe(true);
    expect(await rowsGone(...due.docs)).toBe(true);
    expect(deletes.sort()).toEqual([...due.docs].sort());
    // Not due, by one day or by none: every document is still there, rows too.
    for (const other of [edge, notDue, fresh]) {
      expect(holdsAll(...other.docs)).toBe(true);
      expect(await rowsKept(...other.docs)).toBe(true);
      expect((await deletion(other.p)).idDocsErasedAt).toBeNull();
    }
  });

  it('the days are read at every run: a shorter setting makes more accounts due, a longer one fewer', async () => {
    const a = await deleted(ago(1000));
    const b = await deleted(ago(1825));

    // Longer: nothing is due at 3000 days.
    await settings.set(ADMIN, {
      settings: { [ID_DOCS_KEEP_DAYS_SETTING]: 3000 },
    });
    let r = await sweep.run();
    expect(r).toMatchObject({ days: 3000, accountsWorked: 0, filesErased: 0 });
    expect(deletes).toEqual([]);

    // Shorter: 1100 days makes b due but not a.
    await settings.set(ADMIN, {
      settings: { [ID_DOCS_KEEP_DAYS_SETTING]: 1100 },
    });
    r = await sweep.run();
    expect(r).toMatchObject({
      days: 1100,
      accountsFinished: 1,
      filesErased: 4,
    });
    expect(goneFrom(...b.docs)).toBe(true);
    expect(holdsAll(...a.docs)).toBe(true);

    // The setting put back to its default: a is not due at 1826.
    await settings.set(ADMIN, {
      settings: { [ID_DOCS_KEEP_DAYS_SETTING]: null },
    });
    r = await sweep.run();
    expect(r).toMatchObject({ days: 1826, accountsWorked: 0 });
    expect(holdsAll(...a.docs)).toBe(true);
    expect((await deletion(b.p)).idDocsKeepDays).toBe(1100);
  });

  it('never touches a live account, a deletion not yet completed, or anything else of the deleted account', async () => {
    const gone = await deleted(ago(2000));

    // A live person, with the same kinds of files under their own id.
    const live = person();
    const liveFiles = [
      await upload(live, 'kyc/id-document'),
      await upload(
        live,
        'service-application/document',
        'pdf',
        'application/pdf',
      ),
      await upload(live, 'avatars'),
    ];
    // A person whose deletion is scheduled long ago but not complete: their
    // files are still their own, and a scheduled row has no purgedAt.
    const scheduled = person();
    const scheduledFiles = [await upload(scheduled, 'kyc/id-document')];
    await prisma.accountDeletion.create({
      data: {
        wawuUserId: scheduled,
        status: 'scheduled',
        scheduledAt: ago(2000),
        purgeAfter: ago(1970),
        identityMarkedAt: new Date(),
      },
    });
    // A deletion that is still being purged, old: not purged, so not touched.
    const purging = person();
    const purgingFiles = [await upload(purging, 'kyc/id-document')];
    await prisma.accountDeletion.create({
      data: {
        wawuUserId: purging,
        status: 'purging',
        scheduledAt: ago(2000),
        purgeAfter: ago(1970),
        identityMarkedAt: new Date(),
      },
    });
    // A cancelled deletion.
    const cancelled = person();
    const cancelledFiles = [await upload(cancelled, 'kyc/id-document')];
    await prisma.accountDeletion.create({
      data: {
        wawuUserId: cancelled,
        status: 'cancelled',
        scheduledAt: ago(2000),
        purgeAfter: ago(1970),
        cancelledAt: ago(1990),
      },
    });
    // A file filed under the deleted account that names nobody who was purged.
    const nobody = `kyc/id-document/${randomUUID()}/${randomUUID()}.jpg`;
    stored.add(nobody);
    made.keys.push(nobody);
    await prisma.storageObject.create({
      data: {
        wawuUserId: DELETED_CREATOR_ID,
        key: nobody,
        bytes: 1,
        contentType: 'image/jpeg',
        folder: 'kyc/id-document',
        status: 'confirmed',
      },
    });

    const r = await sweep.run();
    expect(r).toMatchObject({ accountsFinished: 1, filesErased: 4 });
    expect(goneFrom(...gone.docs)).toBe(true);

    const untouched = [
      ...liveFiles,
      ...scheduledFiles,
      ...purgingFiles,
      ...cancelledFiles,
      nobody,
    ];
    expect(holdsAll(...untouched)).toBe(true);
    expect(await rowsKept(...untouched)).toBe(true);
    expect(deletes.sort()).toEqual([...gone.docs].sort());

    // Everything else of the deleted account stays: what a buyer paid for, the
    // event image that still stands, the account's own deletion row.
    expect(holdsAll(gone.soldPreview, gone.soldFull, gone.standingBanner)).toBe(
      true,
    );
    expect(
      await rowsKept(gone.soldPreview, gone.soldFull, gone.standingBanner),
    ).toBe(true);
    expect((await rowsFor(gone.soldFull))!.wawuUserId).toBe(DELETED_CREATOR_ID);
    expect(
      await prisma.contentPiece.count({
        where: {
          creatorWawuId: DELETED_CREATOR_ID,
          fullAssetUrl: gone.soldFull,
        },
      }),
    ).toBe(1);
    const row = await deletion(gone.p);
    expect(row.status).toBe('purged');
    expect(row.purgedAt).not.toBeNull();
    // The purge had deleted the avatar already.
    expect(goneFrom(gone.avatar)).toBe(true);
  });

  it('writes one audit line per account with counts only, and none with a name, a key or a number', async () => {
    const withDocs = await deleted(ago(1900));
    const without = await deleted(ago(1900), { withDocuments: false });
    const logged: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => {
        logged.push(String(m));
      }),
    );
    let r;
    try {
      r = await sweep.run();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(r).toMatchObject({ accountsFinished: 2, filesErased: 4 });

    const a = await deletion(withDocs.p);
    expect(a.idDocsErasedAt).not.toBeNull();
    expect(a.idDocsErased).toBe(4);
    expect(a.idDocsKeepDays).toBe(1826);
    expect(a.idDocsClaimedUntil).toBeNull();
    const b = await deletion(without.p);
    expect(b.idDocsErasedAt).not.toBeNull();
    expect(b.idDocsErased).toBe(0);

    // The report and the log lines carry counts: no id, no key, no folder.
    const said = logged.join('\n') + JSON.stringify(r);
    for (const secret of [withDocs.p, without.p, ...withDocs.docs]) {
      expect(said).not.toContain(secret);
    }
    expect(said).not.toMatch(/kyc\/|id-document|professional\//);
    expect(said).toContain('4 file(s)');
  });

  it('is safe to run twice: the second run finds nothing, calls nothing, changes nothing', async () => {
    const a = await deleted(ago(1900));
    await sweep.run();
    const first = await deletion(a.p);
    expect(first.idDocsErased).toBe(4);
    deletes.length = 0;

    const again = await sweep.run();
    expect(again).toMatchObject({
      accountsWorked: 0,
      accountsFinished: 0,
      filesErased: 0,
    });
    expect(deletes).toEqual([]);
    const second = await deletion(a.p);
    expect(second.idDocsErased).toBe(4);
    expect(second.idDocsErasedAt!.getTime()).toBe(
      first.idDocsErasedAt!.getTime(),
    );
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it('two sweeps at once on two servers delete each file once and count it once', async () => {
    const a = await deleted(ago(1900));
    const b = await deleted(ago(1900));
    delayMs = 120; // long enough that both servers are in the account together
    const other = new IdDocsRetentionService(prisma, settings, remover);

    const [x, y] = await Promise.all([sweep.run(), other.run()]);
    const reports = [x, y];

    // Every key was sent one DELETE, never two.
    const all = [...a.docs, ...b.docs];
    expect(deletes.sort()).toEqual([...all].sort());
    expect(new Set(deletes).size).toBe(deletes.length);
    expect(goneFrom(...all)).toBe(true);
    expect(await rowsGone(...all)).toBe(true);
    expect(reports.reduce((n, r) => n + r.filesErased, 0)).toBe(8);
    expect(reports.reduce((n, r) => n + r.accountsFinished, 0)).toBe(2);
    for (const p of [a.p, b.p]) {
      const row = await deletion(p);
      expect(row.idDocsErased).toBe(4);
      expect(row.idDocsErasedAt).not.toBeNull();
      expect(row.idDocsClaimedUntil).toBeNull();
    }
  });

  it('the same server asked twice at once does the work once', async () => {
    const a = await deleted(ago(1900));
    delayMs = 100;
    const [x, y] = await Promise.all([sweep.run(), sweep.run()]);
    expect([x.skipped, y.skipped]).toEqual(
      expect.arrayContaining([null, 'already_running']),
    );
    expect(deletes.sort()).toEqual([...a.docs].sort());
    expect((await deletion(a.p)).idDocsErased).toBe(4);
  });

  it('an account another server holds is left alone until its claim runs out (a crashed server)', async () => {
    const a = await deleted(ago(1900));
    const now = new Date();
    await prisma.accountDeletion.update({
      where: { wawuUserId: a.p },
      data: { idDocsClaimedUntil: new Date(now.getTime() + 10 * 60_000) },
    });
    const held = await sweep.run(now);
    expect(held).toMatchObject({
      accountsWorked: 0,
      accountsHeldByOthers: 0, // not even listed as due while held
      filesErased: 0,
    });
    expect(deletes).toEqual([]);
    expect(holdsAll(...a.docs)).toBe(true);

    // Twenty minutes on, the claim has run out and the next run finishes it.
    const later = await sweep.run(new Date(now.getTime() + 20 * 60_000));
    expect(later).toMatchObject({ accountsFinished: 1, filesErased: 4 });
    expect(goneFrom(...a.docs)).toBe(true);
    expect((await deletion(a.p)).idDocsErased).toBe(4);
  });

  it('a crash after the objects are removed and before the rows go is finished by the next run, and counted once', async () => {
    const a = await deleted(ago(1900));
    const boom = jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('the process died'));
    let r;
    try {
      r = await sweep.run();
    } finally {
      boom.mockRestore();
    }
    // The objects went; their rows did not, and the account is not finished.
    expect(r).toMatchObject({
      accountsWorked: 1,
      accountsLeft: 1,
      accountsFinished: 0,
    });
    expect(goneFrom(...a.docs)).toBe(true);
    expect(await rowsKept(...a.docs)).toBe(true);
    let row = await deletion(a.p);
    expect(row.idDocsErasedAt).toBeNull();
    expect(row.idDocsErased).toBe(0);
    expect(row.idDocsClaimedUntil).toBeNull(); // freed on the way out

    // The next run: the bucket says "gone" for each, the rows are deleted, the line is written.
    deletes.length = 0;
    const next = await sweep.run();
    expect(next).toMatchObject({ accountsFinished: 1, filesErased: 4 });
    expect(await rowsGone(...a.docs)).toBe(true);
    row = await deletion(a.p);
    expect(row.idDocsErased).toBe(4);
    expect(row.idDocsErasedAt).not.toBeNull();
  });

  it('a missing object does not stop the rest; a refused one keeps its row and is retried', async () => {
    const a = await deleted(ago(1900));
    const [missing, refused, ...fine] = a.docs;
    stored.delete(missing); // never reached the bucket: it answers 404
    refuse.add(refused);

    const first = await sweep.run();
    expect(first).toMatchObject({
      accountsWorked: 1,
      accountsLeft: 1,
      accountsFinished: 0,
      filesErased: 3,
    });
    // The missing one counts as gone, and so do the two that were fine.
    expect(await rowsGone(missing, ...fine)).toBe(true);
    expect(goneFrom(...fine)).toBe(true);
    // The refused one keeps its object and its row.
    expect(holdsAll(refused)).toBe(true);
    expect(await rowsKept(refused)).toBe(true);
    let row = await deletion(a.p);
    expect(row.idDocsErasedAt).toBeNull();
    expect(row.idDocsErased).toBe(3);
    expect(row.idDocsClaimedUntil).toBeNull();

    refuse.clear();
    deletes.length = 0;
    const second = await sweep.run();
    expect(second).toMatchObject({ accountsFinished: 1, filesErased: 1 });
    expect(deletes).toEqual([refused]);
    expect(goneFrom(refused)).toBe(true);
    row = await deletion(a.p);
    expect(row.idDocsErased).toBe(4);
    expect(row.idDocsErasedAt).not.toBeNull();
  });

  it('one account failing does not stop the next', async () => {
    const a = await deleted(ago(1900));
    const b = await deleted(ago(1900));
    const [first, second] = [a, b].sort((x, y) => (x.p < y.p ? -1 : 1));
    refuse.add(first.docs[0]);
    const r = await sweep.run();
    expect(r).toMatchObject({
      accountsWorked: 2,
      accountsFinished: 1,
      accountsLeft: 1,
    });
    expect(goneFrom(...second.docs)).toBe(true);
    expect(goneFrom(...first.docs.slice(1))).toBe(true);
    expect(holdsAll(first.docs[0])).toBe(true);
  });

  it('does nothing when the settings cannot be read, and nothing on a server with no bucket', async () => {
    const a = await deleted(ago(1900));
    const unreadable = jest.spyOn(settings, 'refresh').mockResolvedValue(false);
    let r;
    try {
      r = await sweep.run();
    } finally {
      unreadable.mockRestore();
    }
    expect(r.skipped).toBe('setting_unreadable');
    expect(deletes).toEqual([]);
    expect(holdsAll(...a.docs)).toBe(true);

    const noBucket = new IdDocsRetentionService(prisma, settings, {
      isConfigured: false,
    } as unknown as StorageRemover);
    const n = await noBucket.run();
    expect(n.skipped).toBe('no_bucket');
    expect(deletes).toEqual([]);
    expect(await rowsKept(...a.docs)).toBe(true);
    expect((await deletion(a.p)).idDocsErasedAt).toBeNull();

    const none = new IdDocsRetentionService(prisma, settings);
    expect((await none.run()).skipped).toBe('no_bucket');
  });

  it('a run that is out of time stops, and the next run takes the rest', async () => {
    const a = await deleted(ago(1900));
    const b = await deleted(ago(1900));
    const r = await sweep.run(new Date(), {
      budgetMs: -1,
      accountPage: 100,
      filePage: 200,
      claimMs: 60_000,
    });
    expect(r.stoppedEarly).toBe(true);
    expect(deletes).toEqual([]);
    const next = await sweep.run();
    expect(next).toMatchObject({ accountsFinished: 2, filesErased: 8 });
    expect(goneFrom(...a.docs, ...b.docs)).toBe(true);
  });

  it('works through more accounts than one page, and more files than one call', async () => {
    const people = [
      await deleted(ago(1900)),
      await deleted(ago(1900)),
      await deleted(ago(1900)),
    ];
    const r = await sweep.run(new Date(), {
      budgetMs: 60_000,
      accountPage: 2,
      filePage: 3,
      claimMs: 60_000,
    });
    expect(r).toMatchObject({ accountsFinished: 3, filesErased: 12 });
    for (const p of people) {
      expect(goneFrom(...p.docs)).toBe(true);
      expect((await deletion(p.p)).idDocsErased).toBe(4);
    }
  });
});
