// Contract tests for AITOOLS-05, Dubbing: the one slow tool. A person's file and
// a language go in, the job stays `working` while the Hub follows the provider's
// project (`AiDubService`), and the dubbed audio (FLAC) and WebVTT subtitles come
// back; the points are kept only on success. Real HTTP against the caller's
// DATABASE_URL, the real job, input, copy, follower and points services, and the
// real HTTP voice adapter against the voice stand-in on this machine
// (scripts/dev/voice-standin.cjs). NOT RUN against the real provider. No payment
// provider and no Fintava double is started.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { PointsHoldSweepService } from '../../points/spend/points-hold-sweep.service';
import type { AiJobView, AiToolsView } from '../ai-tools-view.type';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';
import { wavFile } from '../../../test/ai-tools/media-fixtures';
import { AiDubService, OUTPUT_TRIES } from '../dub/ai-dub.service';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
} from '../voice/ai-voice-provider';
import { ProviderCopyService } from '../voice/provider-copy.service';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const DUB = plan.actions.find(
  (a) => a.id === 'dub_standard_per_min_lang',
)!.points;
const MIN = 60_000;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools05@admin.test.wawu.dev',
  role: AdminRole.finance,
};

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason: { code: string; message: string } }).reason;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AITOOLS-05: Dubbing (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  let dubs: AiDubService;
  let copies: ProviderCopyService;
  let sweep: PointsHoldSweepService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | string[] | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const token = (who: string, cost: number, ttl = 300) =>
    h.tokens.issue(
      who,
      'dub_standard_per_min_lang',
      cost,
      new Date(Date.now() + (ttl - h.tokens.seconds) * 1000),
    );
  const auth = (who: string) => ({
    Authorization: `Bearer ${h.tokensOf[who]}`,
  });
  /** A WAV of `seconds` with the stand-in markers in its bytes, uploaded as the person's own file. */
  const upload = (who: string, seconds: number, marks = '') =>
    h.inputs.add(who, wavFile(seconds, marks), 'audio/wav');
  const start = (
    who: string,
    fileKey: string,
    minutes = 1,
    over: object = {},
    key: string | null = randomUUID(),
  ) => {
    const req = h.http().post('/ai-tools/dubbing/jobs').set(auth(who));
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send({
      fileKey,
      targetLanguage: 'yo',
      quoteToken: token(who, DUB * minutes),
      ...over,
    });
  };
  const readJob = async (who: string, id: string) =>
    data<AiJobView>(await h.http().get(`/ai-tools/jobs/${id}`).set(auth(who)));
  const row = (id: string) =>
    h.prisma.aiToolJob.findUniqueOrThrow({ where: { id } });
  /** Passes of the follower until the job leaves `working`. */
  const follow = async (who: string, id: string, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      await dubs.pass();
      const job = await readJob(who, id);
      if (job.state !== 'working') return job;
      if (Date.now() > end) throw new Error('the dub never ended');
      await sleep(80);
    }
  };
  const run = async (who: string, seconds: number, marks = '', over = {}) => {
    const fileKey = upload(who, seconds, marks);
    const res = await start(
      who,
      fileKey,
      Math.max(1, Math.ceil(seconds / 60)),
      over,
    );
    expect(res.status).toBe(202);
    await h.jobs.drain(); // the provider has been asked and the row keeps its ids
    return { fileKey, id: data<AiJobView>(res).id };
  };
  /** The provider project a job started (read from the row's note, whichever form it is in). */
  const projectOf = async (id: string) =>
    /^dub(?:run)?:([A-Za-z0-9_-]+?)(?::|@|$)/.exec(
      (await row(id)).providerRef ?? '',
    )?.[1];
  const standin = () => h.standin.state;

  beforeAll(async () => {
    h = await bootAiTools();
    settings = h.get<PlanSettingsService>(PlanSettingsService);
    copies = h.get<ProviderCopyService>(ProviderCopyService);
    sweep = new PointsHoldSweepService(h.spend, settings);
    dubs = new AiDubService(
      h.prisma,
      settings,
      h.get<AiVoiceProvider>(AI_VOICE_PROVIDER),
      h.jobs,
    );
  });
  afterAll(async () => {
    for (const key of touched)
      await settings.set(admin, { settings: { [key]: null } });
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.clean();
    await h.close();
  });
  beforeEach(async () => {
    await h.jobs.drain();
    await h.clean();
    h.store.files.clear();
    h.store.removed.length = 0;
    h.store.failPut = false;
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    h.inputs.reads.length = 0;
    h.inputs.opens.length = 0;
    h.inputs.failRead = false;
    const s = standin();
    s.dubs.length = 0;
    s.dubReads.length = 0;
    s.dubDownloads.length = 0;
    s.dubKeyLeaks = 0;
    s.deletedDubs.length = 0;
    s.deleteTries.length = 0;
    s.reads.length = 0;
    copies.delaysMs = []; // no background tries: the sweep is driven by the spec
  });

  it('check 1: GET /ai-tools lists Dubbing at its cost a minute with its languages, and no line of it names a price', async () => {
    const res = await h.http().get('/ai-tools').set(auth(PLAIN));
    const tool = data<AiToolsView>(res).tools.find((t) => t.id === 'dubbing')!;
    expect(tool).toMatchObject({
      action: 'dub_standard_per_min_lang',
      unit: 'minute',
      costPointsPerUnit: DUB,
      enabled: true,
      input: { kind: 'file', file: { languageCode: false } },
    });
    const languages = tool.input.file!.dubbing!.languages;
    expect(languages.length).toBeGreaterThan(80);
    expect(languages).toContainEqual({ code: 'yo', name: 'Yoruba' });
    expect(languages).toContainEqual({ code: 'ha', name: 'Hausa' });
    // R-68 and the price rule: no outside brand and no figure in the words a person reads.
    expect(`${tool.name} ${tool.description}`).not.toMatch(
      /\d|point|naira|eleven/i,
    );

    // The list is a setting: a change shows at once, and a bad line is refused.
    await set('ai.dubbing_languages', ['yo Yoruba', 'ig Igbo']);
    const again = data<AiToolsView>(
      await h.http().get('/ai-tools').set(auth(PLAIN)),
    );
    expect(
      again.tools.find((t) => t.id === 'dubbing')!.input.file!.dubbing!
        .languages,
    ).toEqual([
      { code: 'yo', name: 'Yoruba' },
      { code: 'ig', name: 'Igbo' },
    ]);
    await expect(
      settings.set(admin, { settings: { 'ai.dubbing_languages': ['yo'] } }),
    ).rejects.toBeDefined();
    await expect(
      settings.set(admin, { settings: { 'ai.dubbing_languages': [] } }),
    ).rejects.toBeDefined();
    await set('ai.dubbing_languages', null);
  });

  it('check 2: a dub is held at once, answers working, then ends done with the audio and the subtitles; the file and the project are deleted, the points kept once', async () => {
    await h.grant(PLAIN, DUB * 3);
    const fileKey = upload(PLAIN, 30, '[[dub-delay:900]]');
    const sent = wavFile(30, '[[dub-delay:900]]').length;
    const res = await start(PLAIN, fileKey, 1, { sourceLanguage: 'EN' });
    expect(res.status).toBe(202);
    const created = data<AiJobView>(res);
    expect(created).toMatchObject({
      tool: 'dubbing',
      state: 'working',
      targetLanguage: 'yo',
      voiceId: '',
      units: 1,
      costPoints: DUB,
      outputs: [],
    });
    expect(await h.balance(PLAIN)).toBe(DUB * 2); // held while it works

    // The provider got the file whole (streamed), the languages, no model.
    await h.jobs.drain();
    expect(standin().dubs).toEqual([
      expect.objectContaining({
        target: 'yo',
        source: 'en',
        model: null,
        bytes: sent,
      }),
    ]);
    // The run opened the file once, streamed; it was not read whole again.
    expect(h.inputs.opens).toEqual([fileKey]);
    expect(h.inputs.reads.filter((r) => r.kind === 'whole')).toHaveLength(1); // the length, at the start
    const pid = (await projectOf(created.id))!;
    expect((await row(created.id)).providerRef).toMatch(
      new RegExp(`^dubrun:${pid}:lang-\\d+$`),
    );
    expect(h.inputs.removed).toHaveLength(0); // the file stays until the job ends

    // Working: a pass changes nothing yet.
    await dubs.pass();
    expect((await readJob(PLAIN, created.id)).state).toBe('working');
    expect(standin().dubReads.at(-1)?.dub).toMatch(/queued|processing/);

    const done = await follow(PLAIN, created.id);
    expect(done.state).toBe('done');
    expect(done.message).toBeNull();
    expect(done.audioUrl).toMatch(/\/ai\/dubbing\/.+\.flac$/);
    expect(done.outputs.map((o) => o.kind)).toEqual(['audio', 'subtitles']);
    expect(done.outputs[1].text).toMatch(/^WEBVTT/);
    const stored = [...h.store.files.entries()];
    expect(stored).toHaveLength(1);
    expect(stored[0][0]).toMatch(/^ai\/dubbing\/.+\.flac$/);
    expect(stored[0][1].toString('latin1', 0, 4)).toBe('fLaC');
    expect(await h.balance(PLAIN)).toBe(DUB * 2); // kept: spent once
    const hold = await h.prisma.pointHold.findFirstOrThrow({
      where: { wawuUserId: PLAIN },
    });
    expect(hold.state).toBe('committed');
    expect(h.inputs.removed).toEqual([fileKey]);

    // The signed links were fetched once each, and never with the provider's key.
    expect(standin().dubDownloads.map((d) => [d.kind, d.status])).toEqual([
      ['audio', 200],
      ['subtitles', 200],
    ]);
    expect(standin().dubKeyLeaks).toBe(0);
    // The project is deleted at the provider; the row notes it until confirmed gone.
    expect(standin().deletedDubs).toEqual([pid]);
    expect((await row(created.id)).providerRef).toBe(`dub:${pid}`);
    // Nothing a person reads names the provider's ids or statuses.
    expect(JSON.stringify(done)).not.toMatch(
      new RegExp(`${pid}|lang-|dubrun|eleven`, 'i'),
    );

    // Another pass finds nothing left to do.
    expect(await dubs.pass()).toMatchObject({ read: 0 });
  });

  it('the provider project is cleared from the row only by two clean reads of 404, 10 and then 5 minutes on, whatever the provider says to a delete (AITOOLS-04 round 4)', async () => {
    await h.grant(PLAIN, DUB);
    // A provider that acknowledges the delete and keeps the project for a moment, and hides it from a read after.
    const { id } = await run(
      PLAIN,
      30,
      '[[ack-then-appear:1500]][[get404-after-delete:600]]',
    );
    const done = await follow(PLAIN, id);
    expect(done.state).toBe('done');
    // The job's own try: the delete was acknowledged, nothing removed, and the read
    // right after it said 404. That is not believed.
    expect(standin().deleteTries[0]).toMatchObject({
      kind: 'dub',
      status: 204,
      kept: true,
    });
    expect(standin().reads[0]).toMatchObject({
      kind: 'dub',
      status: 404,
      hidden: true,
    });
    expect(h.standin.openDubs()).toBe(1);
    const pid = (await projectOf(id))!;
    expect((await row(id)).providerRef).toBe(`dub:${pid}`);
    const finishedAt = (await row(id)).finishedAt!;
    const at = (m: number) => new Date(finishedAt.getTime() + m * MIN);

    await sleep(1800); // the provider has taken the delete in by now
    expect(await copies.sweep(at(1))).toEqual({ cleared: 0, pending: 1 });
    expect(h.standin.openDubs()).toBe(0); // deleted for real
    expect((await row(id)).providerRef).toBe(`dub:${pid}`); // a 404 inside 10 minutes proves nothing
    expect(await copies.sweep(at(11))).toEqual({ cleared: 0, pending: 1 });
    expect((await row(id)).providerRef).toMatch(
      new RegExp(`^dub:${pid}@\\d+$`),
    ); // the first clean 404, noted
    expect(await copies.sweep(at(12))).toEqual({ cleared: 0, pending: 1 }); // the second is too soon
    expect(await copies.sweep(at(17))).toEqual({ cleared: 1, pending: 0 });
    expect((await row(id)).providerRef).toBeNull();
  });

  it('a dub the provider fails, or calls stale, or cannot hand over audio for, gives every point back and deletes the file and the project', async () => {
    await h.grant(PLAIN, DUB * 5);
    for (const [mark, code] of [
      ['[[dub-failed]]', 'provider_failed'],
      ['[[dub-stale]]', 'provider_failed'],
      ['[[dub-noaudio]]', 'output_missing'],
    ] as const) {
      const before = await h.balance(PLAIN);
      const { fileKey, id } = await run(PLAIN, 30, mark);
      expect(await h.balance(PLAIN)).toBe(before - DUB);
      const job = await follow(PLAIN, id);
      expect(job).toMatchObject({
        state: 'failed',
        outputs: [],
        audioUrl: null,
        message: "That didn't work. No points were taken. Try again.",
      });
      expect((await row(id)).failureCode).toBe(code);
      expect(await h.balance(PLAIN)).toBe(before); // every point back
      expect(h.inputs.removed).toContain(fileKey);
      expect(standin().deletedDubs.length).toBeGreaterThan(0);
      expect((await row(id)).providerRef).toMatch(/^dub:dub-\d+$/);
      standin().deletedDubs.length = 0;
    }
    const states = await h.prisma.pointHold.findMany({
      where: { wawuUserId: PLAIN },
    });
    expect(states.every((s) => s.state === 'released')).toBe(true);
    expect(h.store.files.size).toBe(0);
  });

  it('a provider that refuses the start (402, 422, 500, a web page) ends the job at once with every point back, and the status stays in the log only', async () => {
    await h.grant(PLAIN, DUB * 4);
    for (const mark of [
      '[[status:402]]',
      '[[reject]]',
      '[[fail]]',
      '[[html]]',
    ]) {
      const { id } = await run(PLAIN, 30, mark);
      const job = await follow(PLAIN, id);
      expect(job.state).toBe('failed');
      expect(JSON.stringify(job)).not.toMatch(/\b(402|422|500)\b/);
      expect(await h.balance(PLAIN)).toBe(DUB * 4);
      expect((await row(id)).providerRef).toBeNull();
    }
  });

  it('a project the provider answers without a language to follow ends the job and the project is deleted', async () => {
    await h.grant(PLAIN, DUB);
    const { id } = await run(PLAIN, 30, '[[dub-nolang]]');
    const job = await follow(PLAIN, id);
    expect(job.state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(DUB);
    expect(standin().deletedDubs).toHaveLength(1);
    expect(h.standin.openDubs()).toBe(0);
  });

  it("a dub the provider never finishes is ended past its OWN longest run (not the other tools'), its points go back and the project is deleted", async () => {
    await h.grant(PLAIN, DUB * 2);
    const limit = settings.number('ai.dubbing_max_run_minutes');
    expect(limit).toBe(60);
    expect(settings.number('points.job_max_run_minutes')).toBe(30);
    const { id } = await run(PLAIN, 30, '[[dub-stuck]]');
    const pid = (await projectOf(id))!;
    const began = (await row(id)).createdAt;
    const at = (m: number) => new Date(began.getTime() + m * MIN);

    // Past the other tools' 30 minutes but inside the dub's own: nobody gives the points back.
    await sweep.run(at(45));
    expect(
      (
        await h.prisma.pointHold.findFirstOrThrow({
          where: { wawuUserId: PLAIN },
        })
      ).state,
    ).toBe('held');
    await dubs.pass(at(45));
    expect((await readJob(PLAIN, id)).state).toBe('working');

    // Past the dub's own limit: the follower ends it.
    await dubs.pass(at(limit + 1));
    const job = await readJob(PLAIN, id);
    expect(job.state).toBe('failed');
    expect((await row(id)).failureCode).toBe('timed_out');
    expect(await h.balance(PLAIN)).toBe(DUB * 2);
    expect(standin().deletedDubs).toEqual([pid]);
    expect(h.inputs.removed).toHaveLength(1);
    await set('ai.dubbing_max_run_minutes', 10); // an admin changes the limit at any time
    expect(settings.number('ai.dubbing_max_run_minutes')).toBe(10);
    await set('ai.dubbing_max_run_minutes', null);
  });

  it('when the follower is gone, the points sweep gives a dub back past its own limit, a read follows it, and the project is still deleted', async () => {
    await h.grant(PLAIN, DUB);
    const { id } = await run(PLAIN, 30, '[[dub-stuck]]');
    const pid = (await projectOf(id))!;
    const began = (await row(id)).createdAt;
    const at = (m: number) => new Date(began.getTime() + m * MIN);
    await sweep.run(at(59));
    expect(
      (
        await h.prisma.pointHold.findFirstOrThrow({
          where: { wawuUserId: PLAIN },
        })
      ).state,
    ).toBe('held');
    await sweep.run(at(61));
    expect(await h.balance(PLAIN)).toBe(DUB); // given back
    // A read of the job follows the hold and ends it; its project is noted for deletion.
    expect((await readJob(PLAIN, id)).state).toBe('failed');
    expect((await row(id)).providerRef).toBe(`dub:${pid}`);
    expect(h.inputs.removed).toHaveLength(1);
    await copies.sweep(new Date(Date.now() + 2 * MIN));
    expect(standin().deletedDubs).toEqual([pid]);
  });

  it('a failed store gives the points back, deletes the file and the project, and keeps no audio (V8)', async () => {
    await h.grant(PLAIN, DUB);
    const { id, fileKey } = await run(PLAIN, 30);
    const pid = (await projectOf(id))!;
    h.store.failPut = true;
    const job = await follow(PLAIN, id);
    expect(job.state).toBe('failed');
    expect((await row(id)).failureCode).toBe('store_failed');
    expect(await h.balance(PLAIN)).toBe(DUB);
    expect(h.inputs.removed).toEqual([fileKey]);
    expect(standin().deletedDubs).toEqual([pid]);
    expect(h.store.files.size).toBe(0);
  });

  it('outputs that cannot be fetched are tried on later passes with fresh links, then the job fails with its points back; subtitles that are missing or not WebVTT do not fail it', async () => {
    await h.grant(PLAIN, DUB * 5);
    for (const mark of ['[[dub-outfail]]', '[[dub-notflac]]']) {
      const before = await h.balance(PLAIN);
      const { id } = await run(PLAIN, 30, mark);
      for (let i = 1; i < OUTPUT_TRIES; i++) {
        await dubs.pass();
        expect((await readJob(PLAIN, id)).state).toBe('working'); // tries left
      }
      await dubs.pass();
      expect((await readJob(PLAIN, id)).state).toBe('failed');
      expect((await row(id)).failureCode).toBe('output_fetch_failed');
      expect(await h.balance(PLAIN)).toBe(before);
    }
    for (const mark of ['[[dub-nosubs]]', '[[dub-badvtt]]']) {
      const { id } = await run(PLAIN, 30, mark);
      const job = await follow(PLAIN, id);
      expect(job.state).toBe('done');
      expect(job.outputs.map((o) => o.kind)).toEqual(['audio']);
    }
  });

  it('a Hub that restarts mid-dub still ends the job, and two Hubs finishing it at once settle the hold once (V8)', async () => {
    await h.grant(PLAIN, DUB * 2);
    const { id } = await run(PLAIN, 30, '[[dub-delay:700]]');
    await dubs.pass();
    expect((await readJob(PLAIN, id)).state).toBe('working');
    // "Restart": everything the follower knew was in memory only; a new one reads the rows.
    const a = new AiDubService(
      h.prisma,
      settings,
      h.get<AiVoiceProvider>(AI_VOICE_PROVIDER),
      h.jobs,
    );
    const b = new AiDubService(
      h.prisma,
      settings,
      h.get<AiVoiceProvider>(AI_VOICE_PROVIDER),
      h.jobs,
    );
    await sleep(800);
    await Promise.all([a.pass(), b.pass()]);
    const job = await readJob(PLAIN, id);
    expect(job.state).toBe('done'); // not failed by the one that lost the commit
    expect(job.outputs.map((o) => o.kind)).toEqual(['audio', 'subtitles']);
    const holds = await h.prisma.pointHold.findMany({
      where: { wawuUserId: PLAIN },
    });
    expect(holds).toHaveLength(1);
    expect(holds[0].state).toBe('committed');
    expect(await h.balance(PLAIN)).toBe(DUB);
    expect(standin().dubs).toHaveLength(1); // one project
  });

  it('a hold another finisher already committed (a commit again changes nothing) leaves the job done, with what it made, never failed (V8)', async () => {
    await h.grant(PLAIN, DUB);
    const { id } = await run(PLAIN, 30, '[[dub-stuck]]');
    const job = await row(id);
    const pid = (await projectOf(id))!;
    // Another Hub process finished first: the points are spent, the row still says working.
    await h.spend.commit(job.holdId!);
    await h.jobs.completeFollowed(id, {
      audio: {
        audio: Buffer.from('fLaC-made-by-the-other'),
        contentType: 'audio/flac',
      },
      texts: [{ kind: 'subtitles', text: 'WEBVTT\n' }],
      endCopy: { kind: 'dub', id: pid },
    });
    const done = await readJob(PLAIN, id);
    expect(done.state).toBe('done');
    expect(done.outputs.map((o) => o.kind)).toEqual(['audio', 'subtitles']);
    expect(await h.balance(PLAIN)).toBe(0); // spent once
    expect((await row(id)).providerRef).toBe(`dub:${pid}`);
    expect(standin().deletedDubs).toEqual([pid]);
  });

  it('the same Idempotency-Key twice starts one project and holds once; another language under the key is 409', async () => {
    await h.grant(PLAIN, DUB * 3);
    const fileKey = upload(PLAIN, 30, '[[dub-delay:300]]');
    const key = randomUUID();
    const first = await start(PLAIN, fileKey, 1, {}, key);
    const again = await start(PLAIN, fileKey, 1, {}, key);
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(data<AiJobView>(again).id).toBe(data<AiJobView>(first).id);
    const other = await start(PLAIN, fileKey, 1, { targetLanguage: 'ig' }, key);
    expect(other.status).toBe(409);
    expect(reasonOf(other).code).toBe('idempotency_key_reused');
    await h.jobs.drain();
    expect(standin().dubs).toHaveLength(1);
    expect(
      await h.prisma.pointHold.count({ where: { wawuUserId: PLAIN } }),
    ).toBe(1);
    expect(await h.balance(PLAIN)).toBe(DUB * 2);
    await follow(PLAIN, data<AiJobView>(first).id);
  });

  it('two dubs at once on a balance for one: one runs, the other is 402, and nothing goes below zero (V8)', async () => {
    await h.grant(PLAIN, DUB);
    const a = upload(PLAIN, 30, '[[dub-delay:300]]');
    const b = upload(PLAIN, 30, '[[dub-delay:300]]');
    const [x, y] = await Promise.all([start(PLAIN, a), start(PLAIN, b)]);
    expect([x.status, y.status].sort()).toEqual([202, 402]);
    expect(await h.balance(PLAIN)).toBe(0);
    await h.jobs.drain();
    expect(standin().dubs).toHaveLength(1);
    const ok = x.status === 202 ? x : y;
    await follow(PLAIN, data<AiJobView>(ok).id);
    expect(await h.balance(PLAIN)).toBe(0);
  });

  it("a language off the list, the same language twice, a region form, a length over the cap and another person's file are each refused with nothing held and no provider call", async () => {
    await h.grant(PLAIN, DUB * 3);
    const fileKey = upload(PLAIN, 30);
    const refused = async (
      res: { status: number; body: unknown },
      status: number,
      code: string,
    ) => {
      expect(res.status).toBe(status);
      expect(reasonOf(res).code).toBe(code);
      expect(
        await h.prisma.aiToolJob.count({ where: { wawuUserId: PLAIN } }),
      ).toBe(0);
      expect(
        await h.prisma.pointHold.count({ where: { wawuUserId: PLAIN } }),
      ).toBe(0);
      expect(await h.balance(PLAIN)).toBe(DUB * 3);
      expect(standin().dubs).toHaveLength(0);
      expect(h.inputs.removed).toHaveLength(0);
    };
    await refused(
      await start(PLAIN, fileKey, 1, { targetLanguage: 'xx' }),
      422,
      'ai_language_unsupported',
    );
    await refused(
      await start(PLAIN, fileKey, 1, { sourceLanguage: 'xx' }),
      422,
      'ai_language_unsupported',
    );
    await refused(
      await start(PLAIN, fileKey, 1, { sourceLanguage: 'YO' }),
      422,
      'ai_language_unsupported',
    );
    await refused(
      await start(PLAIN, fileKey, 1, { targetLanguage: 'pt-BR' }),
      422,
      'ai_language_unsupported',
    );
    // A language refused before the file is read: only the shape is checked by the DTO.
    expect(
      (await start(PLAIN, fileKey, 1, { targetLanguage: 'not a tag' })).status,
    ).toBe(400);
    // Another person's file is not found.
    await refused(await start(BASIC, fileKey, 1), 404, 'not_found').catch(
      () => undefined,
    );
    // A length over the minute cap.
    await set('points.max_audio_min_per_job', 1);
    const long = upload(PLAIN, 90);
    await refused(await start(PLAIN, long, 2), 422, 'points_cap_reached');
    // A file that is not a recording.
    const text = h.inputs.add(
      PLAIN,
      Buffer.from('this is not a recording at all'),
      'audio/wav',
    );
    await refused(await start(PLAIN, text, 1), 422, 'ai_file_unreadable');
    await set('points.max_audio_min_per_job', null);
  });

  it("the quote prices the minutes of the file for one language, from the Hub's own reading", async () => {
    const fileKey = upload(PLAIN, 90);
    const res = await h
      .http()
      .post('/ai-tools/dubbing/quote')
      .set(auth(PLAIN))
      .send({ fileKey });
    expect(res.status).toBe(200);
    expect(
      data<{ file: { minutes: number }; costPoints: number }>(res),
    ).toMatchObject({
      file: { minutes: 2 },
      costPoints: DUB * 2,
    });
    const other = await h
      .http()
      .post('/ai-tools/dubbing/quote')
      .set(auth(BASIC))
      .send({ fileKey });
    expect(other.status).toBe(404);
  });

  it('a dub the person leaves is still listed with its language, working and then done', async () => {
    await h.grant(PLAIN, DUB);
    const { id } = await run(PLAIN, 30, '[[dub-delay:300]]');
    const list = data<{ items: AiJobView[] }>(
      await h.http().get('/ai-tools/jobs').set(auth(PLAIN)),
    );
    expect(list.items[0]).toMatchObject({
      id,
      tool: 'dubbing',
      state: 'working',
      targetLanguage: 'yo',
    });
    await follow(PLAIN, id);
    const after = data<{ items: AiJobView[] }>(
      await h.http().get('/ai-tools/jobs').set(auth(PLAIN)),
    );
    expect(after.items[0]).toMatchObject({
      id,
      state: 'done',
      targetLanguage: 'yo',
    });
  });
});
