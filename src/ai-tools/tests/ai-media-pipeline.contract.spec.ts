// Contract tests for AITOOLS-08, AITOOLS-09 and AITOOLS-10 (R-109): the media
// pipeline (pictures and videos made in the background by the provider,
// followed by the Hub, streamed into its own storage), "result into Create",
// the listing switch of each new tool, the long-job notice, Make an image, Edit
// a photo, Make a video and Talking photo. Real HTTP against the caller's
// DATABASE_URL, the real job, input, copy, follower and points services, and the
// real HTTP voice adapter against the voice stand-in on this machine
// (scripts/dev/voice-standin.cjs). NOT RUN against the real provider (the
// owner's credits are not bought yet). No payment provider and no Fintava
// double is started.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { PayloadTooLargeException } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { PointsHoldSweepService } from '../../points/spend/points-hold-sweep.service';
import type {
  AiJobView,
  AiPieceView,
  AiToolsView,
} from '../ai-tools-view.type';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
  PRO,
} from '../../../test/ai-tools/ai-tools-harness';
import { wavFile } from '../../../test/ai-tools/media-fixtures';
import { AiDubService } from '../dub/ai-dub.service';
import { AiFlowService } from '../flow/ai-flow.service';
import { AiToolsPurgeService } from '../ai-tools-purge.service';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
} from '../voice/ai-voice-provider';
import { ProviderCopyService } from '../voice/provider-copy.service';
import { Readable } from 'node:stream';
import { FILE_KINDS } from '../../account-purge/purge-files';
import {
  GENERATED_KEY_FOLDERS,
  KEY_FOLDERS,
} from '../../storage/storage.service';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const cost = (id: string) => plan.actions.find((a) => a.id === id)!.points;
const IMAGE = cost('image_per_use');
const EDIT = cost('photo_edit_per_use');
const VIDEO_SEC = cost('video_per_sec');
const TALK_SEC = cost('talking_photo_per_sec');
const MIN = 60_000;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools0810@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const LONG_DASH = /[\u2013\u2014]/;

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason: { code: string; message: string } }).reason;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small PNG picture (16 by 16) with the stand-in markers after its header, as the person's own photo. */
function pngFile(tail = ''): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(16, 16);
  head.writeUInt32BE(16, 20);
  return Buffer.concat([head, Buffer.from(`photo ${tail}`)]);
}

/** What the live app's `readAiTools` (studioApi.ts, origin/main, 30 Oct 2026) accepts: whole tools or nothing. */
function readAiToolsLikeTheApp(value: unknown): { id: string; name: string }[] {
  const v = value as {
    tools?: unknown;
    caps?: { dailyPoints?: unknown };
  } | null;
  const filled = (x: unknown): x is string =>
    typeof x === 'string' && x.trim() !== '';
  const count = (x: unknown): x is number =>
    typeof x === 'number' && Number.isInteger(x) && x >= 0;
  if (!v || typeof v !== 'object' || !Array.isArray(v.tools))
    throw new Error('AI tools unreadable');
  const tools = v.tools.map((row: unknown) => {
    const t = row as Record<string, unknown> | null;
    if (
      !t ||
      typeof t !== 'object' ||
      !filled(t.id) ||
      !filled(t.name) ||
      !count(t.costPointsPerUnit) ||
      typeof t.enabled !== 'boolean'
    )
      throw new Error('AI tools unreadable');
    return { id: t.id, name: t.name.trim() };
  });
  if (!count(v.caps?.dailyPoints)) throw new Error('AI tools unreadable');
  return tools;
}

describe('AITOOLS-08 to AITOOLS-10: the Studio media pipeline (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  let sweep: PointsHoldSweepService;
  let copies: ProviderCopyService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | string[] | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const switchOn = async () => {
    for (const id of ['image', 'photo-edit', 'video', 'talking-photo'])
      await set(`ai.listed.${id}`, 1);
  };
  const auth = (who: string) => ({
    Authorization: `Bearer ${h.tokensOf[who]}`,
  });
  const token = (who: string, action: string, points: number, ttl = 300) =>
    h.tokens.issue(
      who,
      action,
      points,
      new Date(Date.now() + (ttl - h.tokens.seconds) * 1000),
    );
  const row = (id: string) =>
    h.prisma.aiToolJob.findUniqueOrThrow({ where: { id } });
  const standin = () => h.standin.state;
  const readJob = async (who: string, id: string) =>
    data<AiJobView>(await h.http().get(`/ai-tools/jobs/${id}`).set(auth(who)));

  /** POST a job route with a fresh key and the quote token the person saw. */
  const post = (
    who: string,
    route: string,
    action: string,
    points: number,
    body: Record<string, unknown>,
    key: string | null = randomUUID(),
  ) => {
    const req = h.http().post(`/ai-tools/${route}`).set(auth(who));
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send({ ...body, quoteToken: token(who, action, points) });
  };
  const makeImage = (
    who: string,
    prompt: string,
    over: Record<string, unknown> = {},
    key?: string,
  ) =>
    post(
      who,
      'image/jobs',
      'image_per_use',
      IMAGE,
      { prompt, shape: '1:1', ...over },
      key,
    );
  const photoKey = (who: string, tail = '') =>
    h.inputs.add(who, pngFile(tail), 'image/png', 'ai/input-image');
  const makeEdit = (
    who: string,
    prompt: string,
    key: string,
    over: Record<string, unknown> = {},
  ) =>
    post(who, 'photo-edit/jobs', 'photo_edit_per_use', EDIT, {
      prompt,
      photoKey: key,
      ...over,
    });
  const makeVideo = (
    who: string,
    prompt: string,
    seconds = 4,
    over: Record<string, unknown> = {},
    key?: string,
  ) =>
    post(
      who,
      'video/jobs',
      'video_per_sec',
      VIDEO_SEC * seconds,
      { prompt, seconds, ...over },
      key,
    );
  /** A WAV of `seconds` as the person's own recording. */
  const voiceFile = (who: string, seconds: number, tail = '') =>
    h.inputs.add(who, wavFile(seconds, tail), 'audio/wav', 'ai/input-audio');
  const speak = (who: string, over: Record<string, unknown>, points: number) =>
    post(who, 'talking-photo/jobs', 'talking_photo_per_sec', points, over);
  /** Passes of the follower until the job leaves `working`. */
  const follow = async (who: string, id: string, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      await h.flows.pass();
      const job = await readJob(who, id);
      if (job.state !== 'working') return job;
      if (Date.now() > end) throw new Error('the job never ended');
      await sleep(60);
    }
  };
  const run = async (res: { status: number; body: unknown }) => {
    expect(res.status).toBe(202);
    await h.jobs.drain(); // the provider has been asked and the row keeps its ids
    return data<AiJobView>(res).id;
  };
  /** A finished job of the person's, with the outputs given, as a tool wrote them. */
  const seedDone = async (
    who: string,
    action: string,
    outputs: unknown,
    audioKey: string | null = null,
  ) => {
    const id = randomUUID();
    await h.prisma.aiToolJob.create({
      data: {
        id,
        wawuUserId: who,
        tool: action,
        idempotencyKey: id,
        requestHash: 'seed',
        voiceId: '',
        characters: 0,
        units: 1,
        costPoints: 1,
        state: 'done',
        audioKey,
        outputs: outputs as never,
        finishedAt: new Date(),
      },
    });
    return id;
  };

  beforeAll(async () => {
    h = await bootAiTools({ media: true });
    settings = h.get<PlanSettingsService>(PlanSettingsService);
    copies = h.get<ProviderCopyService>(ProviderCopyService);
    sweep = new PointsHoldSweepService(h.spend, settings);
    h.flows.pollMs = { image: 0, video: 0 };
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
    const s = standin();
    for (const list of [
      s.assets,
      s.deletedAssets,
      s.images,
      s.videos,
      s.genReads,
      s.genDownloads,
    ] as unknown[][])
      list.length = 0;
    s.genKeyLeaks = 0;
    h.standin.releaseStubborn();
    h.store.files.clear();
    h.media.files.clear();
    h.media.removed.length = 0;
    h.media.copies.clear();
    h.media.copyRefusal = null;
    h.media.failPut = false;
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    for (const key of [...touched]) await set(key, null);
    touched.clear();
    await switchOn();
  });

  describe('AITOOLS-08: the listing switch, the catalogue and the quote', () => {
    it('lists no new tool while its switch is off, even with the provider set, and the routes answer unavailable with nothing held', async () => {
      for (const id of ['image', 'photo-edit', 'video', 'talking-photo'])
        await set(`ai.listed.${id}`, null);
      await h.grant(PLAIN, 5000);
      const list = data<AiToolsView>(
        await h.http().get('/ai-tools').set(auth(PLAIN)),
      );
      const ids = list.tools.map((t) => t.id);
      expect(ids).toEqual(
        expect.arrayContaining(['voiceover', 'sound-effect', 'dubbing']),
      );
      for (const id of ['image', 'photo-edit', 'video', 'talking-photo'])
        expect(ids).not.toContain(id);
      const res = await makeImage(PLAIN, 'a red circle');
      expect(res.status).toBe(503);
      expect(reasonOf(res).code).toBe('ai_tool_unavailable');
      expect(await h.balance(PLAIN)).toBe(5000);
      expect(standin().images).toHaveLength(0);
      expect(
        (
          await h
            .http()
            .post('/ai-tools/talking-photo/quote')
            .set(auth(PLAIN))
            .send({ audioKey: 'x' })
        ).status,
      ).toBe(404);
    });

    it("lists a tool whole when its switch is on, and the whole list passes the live app's readAiTools", async () => {
      const list = data<AiToolsView>(
        await h.http().get('/ai-tools').set(auth(PLAIN)),
      );
      const byId = new Map(list.tools.map((t) => [t.id, t]));
      expect(readAiToolsLikeTheApp(list).map((t) => t.id)).toEqual(
        list.tools.map((t) => t.id),
      );
      expect(byId.get('image')).toMatchObject({
        name: 'Make an image',
        action: 'image_per_use',
        unit: 'use',
        costPointsPerUnit: IMAGE,
        enabled: true,
        input: {
          kind: 'image',
          maxCharacters: 1000,
          options: { shapes: ['1:1', '4:5', '9:16', '16:9'] },
        },
      });
      expect(byId.get('image')!.input.options).not.toHaveProperty('photo');
      expect(byId.get('photo-edit')!.input.options).toMatchObject({
        photo: {
          use: 'required',
          folder: 'ai/input-image',
          accepts: ['image/png', 'image/jpeg', 'image/webp'],
          maxBytes: 25 * 1024 * 1024,
        },
      });
      expect(byId.get('video')).toMatchObject({
        name: 'Make a video',
        unit: 'second',
        costPointsPerUnit: VIDEO_SEC,
        input: {
          kind: 'video',
          options: {
            shapes: ['16:9', '9:16'],
            lengths: [4, 6, 8],
            photo: { use: 'optional' },
          },
        },
      });
      expect(byId.get('talking-photo')).toMatchObject({
        unit: 'second',
        costPointsPerUnit: TALK_SEC,
        input: {
          kind: 'video',
          maxCharacters: 0,
          options: {
            shapes: [],
            photo: { use: 'required' },
            speech: {
              audioFolder: 'ai/input-audio',
              maxSeconds: 60,
              fromJob: true,
            },
          },
        },
      });
      // No provider or model name, no price claim, no long dash in any string a person reads.
      const text = JSON.stringify(
        list.tools.filter((t) =>
          ['image', 'photo-edit', 'video', 'talking-photo'].includes(t.id),
        ),
      );
      expect(text).not.toMatch(
        /gemini|veo|aurora|creatify|elevenlabs|google|openai|bytedance/i,
      );
      expect(text).not.toMatch(LONG_DASH);
      // The seven older tools are unchanged: still the same entries.
      expect(list.tools.slice(0, 7).map((t) => t.id)).toEqual([
        'voiceover',
        'quick-voice',
        'sound-effect',
        'music',
        'captions',
        'clean-audio',
        'dubbing',
      ]);
    });

    it('prices a picture flat and a video by the second, from the settings, through the ordinary quote', async () => {
      await h.grant(PLAIN, 5000);
      const image = await h.quotes.quote(PLAIN, {
        action: 'image_per_use',
        units: 1,
      });
      expect(image.costPoints).toBe(IMAGE);
      const clip = await h.quotes.quote(PLAIN, {
        action: 'video_per_sec',
        units: 8,
      });
      expect(clip.costPoints).toBe(VIDEO_SEC * 8);
      await set('points.action.video_per_sec', 300);
      expect(
        (await h.quotes.quote(PLAIN, { action: 'video_per_sec', units: 4 }))
          .costPoints,
      ).toBe(1200);
    });
  });

  describe('AITOOLS-09: Make an image', () => {
    it('holds the points at once, follows the picture, stores it streamed, serves it with its type, size, name, download link and Create format, and keeps the points', async () => {
      await h.grant(PLAIN, 1000);
      const res = await makeImage(PLAIN, 'a red circle on white', {
        shape: '4:5',
      });
      expect(res.status).toBe(202);
      const view = data<AiJobView>(res);
      expect(view).toMatchObject({
        state: 'working',
        tool: 'image',
        costPoints: IMAGE,
        units: 1,
        outputs: [],
      });
      expect(await h.balance(PLAIN)).toBe(1000 - IMAGE);
      await h.jobs.drain();
      // The provider got the model and size the settings name, the shape asked and no photo.
      expect(standin().images).toEqual([
        expect.objectContaining({
          model: 'gemini-3.1-flash-image',
          shape: '4:5',
          resolution: '1K',
          assetIds: [],
        }),
      ]);
      const done = await follow(PLAIN, view.id);
      expect(done.state).toBe('done');
      expect(done.outputs).toHaveLength(1);
      expect(done.outputs[0]).toMatchObject({
        kind: 'image',
        url: `https://media.example.test/ai/image/${PLAIN}/${view.id}.png`,
        contentType: 'image/png',
        bytes: 2048,
        name: 'Image',
        pieceFormat: 'image',
      });
      expect(done.outputs[0].downloadUrl).toMatch(
        /studio-image-\d{1,2}-[a-z]{3}-\d{4}\.png$/,
      );
      expect(done.audioUrl).toBeNull();
      expect(
        h.media.files.get(`ai/image/${PLAIN}/${view.id}.png`),
      ).toMatchObject({ bytes: 2048, contentType: 'image/png' });
      expect(await h.balance(PLAIN)).toBe(1000 - IMAGE);
      // The signed link was fetched once, with no key.
      expect(standin().genDownloads).toHaveLength(1);
      expect(standin().genKeyLeaks).toBe(0);
      // A short job tells nobody.
      expect(
        await h.prisma.notification.count({
          where: { userWawuId: PLAIN, kind: 'ai_job_ready' },
        }),
      ).toBe(0);
    });

    it("gives every point back, with the Hub's own sentence, for a failed, refused, moderated, unreachable or never-finished picture", async () => {
      await h.grant(PLAIN, 3000);
      const cases: [string, string, string][] = [
        [
          'a [[fail]]',
          'provider_failed',
          "That didn't work. No points were taken. Try again.",
        ],
        [
          'a [[moderated]]',
          'moderated',
          "That picture can't be made. No points were taken.",
        ],
        [
          'a [[invalid]]',
          'provider_failed',
          "That didn't work. No points were taken. Try again.",
        ],
        [
          'a [[reject]]',
          'provider_failed',
          "That didn't work. No points were taken. Try again.",
        ],
        [
          'a [[start-fail]]',
          'provider_unavailable',
          "That didn't work. No points were taken. Try again.",
        ],
        [
          'a [[outfail]]',
          'output_fetch_failed',
          "That didn't work. No points were taken. Try again.",
        ],
      ];
      for (const [prompt, code, message] of cases) {
        const id = await run(await makeImage(PLAIN, prompt));
        const done = await follow(PLAIN, id);
        // A file that cannot be fetched is tried on three passes before it gives up.
        expect([prompt, done.state]).toEqual([prompt, 'failed']);
        expect((await row(id)).failureCode).toBe(code);
        expect(done.message).toBe(message);
        expect(message).not.toMatch(LONG_DASH);
        expect(done.outputs).toEqual([]);
        expect(await h.balance(PLAIN)).toBe(3000);
      }
      expect(h.media.files.size).toBe(0);
    });

    it('a picture the provider never finishes is ended past its longest run: the points go back and the job says so (V8)', async () => {
      await h.grant(PLAIN, 1000);
      const id = await run(await makeImage(PLAIN, 'a [[stuck]]'));
      const began = (await row(id)).createdAt;
      await h.flows.pass(new Date(began.getTime() + 60_000));
      expect((await readJob(PLAIN, id)).state).toBe('working');
      const limit = settings.number('ai.image_max_run_seconds');
      expect(limit).toBe(300);
      await h.flows.pass(new Date(began.getTime() + (limit + 1) * 1000));
      const job = await readJob(PLAIN, id);
      expect(job.state).toBe('failed');
      expect((await row(id)).failureCode).toBe('timed_out');
      expect(await h.balance(PLAIN)).toBe(1000);
    });

    it('a picture in a type the Hub does not serve fails the job and gives every point back; nothing is stored', async () => {
      await h.grant(PLAIN, 1000);
      const id = await run(await makeImage(PLAIN, 'a [[type:image/gif]]'));
      const done = await follow(PLAIN, id);
      expect(done.state).toBe('failed');
      expect((await row(id)).failureCode).toBe('output_type');
      expect(await h.balance(PLAIN)).toBe(1000);
      expect(h.media.files.size).toBe(0);
      expect(standin().genDownloads).toHaveLength(0);
    });

    it('a store that is down gives every point back and keeps nothing', async () => {
      await h.grant(PLAIN, 1000);
      h.media.failPut = true;
      const id = await run(await makeImage(PLAIN, 'a red circle'));
      const done = await follow(PLAIN, id);
      expect(done.state).toBe('failed');
      expect((await row(id)).failureCode).toBe('store_failed');
      expect(await h.balance(PLAIN)).toBe(1000);
    });

    it('the same Idempotency-Key twice runs one job and holds once; two jobs at once never take points below zero (V8)', async () => {
      await h.grant(PLAIN, IMAGE + 50);
      const key = randomUUID();
      const first = await makeImage(PLAIN, 'a red circle', {}, key);
      const second = await makeImage(PLAIN, 'a red circle', {}, key);
      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(data<AiJobView>(second).id).toBe(data<AiJobView>(first).id);
      expect(await h.balance(PLAIN)).toBe(50);
      await h.jobs.drain();
      expect(standin().images).toHaveLength(1);
      await follow(PLAIN, data<AiJobView>(first).id);
      // The same key with other words is a different request.
      const reused = await makeImage(PLAIN, 'something else', {}, key);
      expect(reused.status).toBe(409);
      expect(reasonOf(reused).code).toBe('idempotency_key_reused');

      await h.clean();
      await h.grant(PLAIN, IMAGE + 50);
      const both = await Promise.all([
        makeImage(PLAIN, 'one'),
        makeImage(PLAIN, 'two'),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([202, 402]);
      expect(await h.balance(PLAIN)).toBe(50);
      await h.jobs.drain();
    });

    it('a restart mid-run resumes the follower: a fresh follower with no memory still ends the job (V8)', async () => {
      await h.grant(PLAIN, 1000);
      const id = await run(await makeImage(PLAIN, 'a [[slow:500]]'));
      // The row alone holds the generation's id (a Hub that restarts has nothing else).
      expect((await row(id)).providerRef).toMatch(/^genrun:image:gen-\d+$/);
      // The follower that started the job is gone; a fresh one, with no memory of it, takes over.
      const fresh = new AiFlowService(
        h.prisma,
        settings,
        h.get<AiVoiceProvider>(AI_VOICE_PROVIDER),
        h.jobs,
      );
      fresh.pollMs = { image: 0, video: 0 };
      let state = 'working';
      for (let i = 0; i < 60 && state === 'working'; i++) {
        await fresh.pass();
        state = (await readJob(PLAIN, id)).state;
        await sleep(50);
      }
      expect(state).toBe('done');
      expect(await h.balance(PLAIN)).toBe(1000 - IMAGE);
    });

    it('a late finish after the stale-hold sweep cannot commit: the points stay given back and the stored file is removed (V8)', async () => {
      await h.grant(PLAIN, 1000);
      const id = await run(await makeImage(PLAIN, 'a [[stuck]]'));
      const began = (await row(id)).createdAt;
      await sweep.run(new Date(began.getTime() + 31 * MIN));
      expect(await h.balance(PLAIN)).toBe(1000); // given back
      // The provider answers late: the finish meets a settled hold. No read has reconciled the job yet.
      await h.jobs.completeFollowed(id, {
        media: {
          kind: 'image',
          contentType: 'image/png',
          bytes: 4,
          stream: Readable.from([Buffer.from('late')]),
          close: () => undefined,
        },
      });
      expect(await h.balance(PLAIN)).toBe(1000);
      const job = await readJob(PLAIN, id);
      expect(job.state).toBe('failed');
      expect(job.outputs).toEqual([]);
      expect(h.media.removed).toEqual([`ai/image/${PLAIN}/${id}.png`]);
      expect(h.media.files.size).toBe(0);
    });

    it('stores the largest picture the Hub takes (60 MB) as a stream, with its real size (V8)', async () => {
      await h.grant(PLAIN, 1000);
      const id = await run(
        await makeImage(PLAIN, `a [[bytes:${60 * 1024 * 1024}]]`),
      );
      const done = await follow(PLAIN, id, 60_000);
      expect(done.state).toBe('done');
      expect(done.outputs[0]).toMatchObject({ bytes: 60 * 1024 * 1024 });
      // One over the Hub's bound for a picture (64 MB) is refused, and the points go back.
      const tooBig = await run(
        await makeImage(PLAIN, `a [[bytes:${65 * 1024 * 1024}]]`),
      );
      expect((await follow(PLAIN, tooBig, 60_000)).state).toBe('failed');
      expect(await h.balance(PLAIN)).toBe(1000 - IMAGE);
    });
  });

  describe('AITOOLS-09: Edit a photo', () => {
    it('sends the photo up as an asset, names it in the request, and deletes the asset and the uploaded photo when the job ends', async () => {
      await h.grant(PLAIN, 1000);
      const key = photoKey(PLAIN);
      const id = await run(
        await makeEdit(PLAIN, 'make it black and white', key, { shape: '1:1' }),
      );
      expect(standin().assets).toEqual([
        expect.objectContaining({ type: 'image/png', name: 'photo.png' }),
      ]);
      const assetId = standin().assets[0].id;
      expect(standin().images[0]).toMatchObject({
        assetIds: [assetId],
        shape: '1:1',
      });
      // While it works, the row keeps the generation and the asset it must delete.
      expect((await row(id)).providerRef).toMatch(
        new RegExp(`^genrun:image:gen-\\d+:${assetId}$`),
      );
      const done = await follow(PLAIN, id);
      expect(done.state).toBe('done');
      expect(done.outputs[0]).toMatchObject({
        kind: 'image',
        name: 'Edited photo',
        pieceFormat: 'image',
      });
      expect(standin().deletedAssets).toEqual([assetId]);
      expect(h.standin.openAssets()).toBe(0);
      expect(h.inputs.removed).toEqual([key]);
      expect((await row(id)).providerRef).toBeNull();
      expect(await h.balance(PLAIN)).toBe(1000 - EDIT);
    });

    it('the asset is deleted when the job fails too, and a delete the provider refuses is kept noted and tried again until it is gone', async () => {
      await h.grant(PLAIN, 1000);
      const key = photoKey(PLAIN, '[[asset-delete-fail]]');
      const id = await run(await makeEdit(PLAIN, 'a [[fail]]', key));
      const assetId = standin().assets[0].id;
      const done = await follow(PLAIN, id);
      expect(done.state).toBe('failed');
      expect(await h.balance(PLAIN)).toBe(1000);
      // The provider refuses the delete: the note stays on the row.
      expect(h.standin.openAssets()).toBe(1);
      expect((await row(id)).providerRef).toBe(`asset:${assetId}`);
      expect(standin().removeRefused).toBeGreaterThan(0);
      // The provider is back: the sweep clears it.
      h.standin.releaseStubborn();
      const sweptAt = new Date(Date.now() + 2 * MIN);
      expect((await copies.sweep(sweptAt)).cleared).toBe(1);
      expect(h.standin.openAssets()).toBe(0);
      expect((await row(id)).providerRef).toBeNull();
    });

    it('an upload the provider refuses ends the job at once, gives the points back and leaves nothing at the provider', async () => {
      await h.grant(PLAIN, 1000);
      const key = photoKey(PLAIN, '[[asset-fail]]');
      const id = await run(await makeEdit(PLAIN, 'make it blue', key));
      const job = await readJob(PLAIN, id);
      expect(job.state).toBe('failed');
      expect(await h.balance(PLAIN)).toBe(1000);
      expect(standin().images).toHaveLength(0);
      expect(h.standin.openAssets()).toBe(0);
      expect(h.inputs.removed).toEqual([key]);
    });

    it('a request the provider refuses after the upload still deletes the asset', async () => {
      await h.grant(PLAIN, 1000);
      const key = photoKey(PLAIN);
      const id = await run(
        await makeEdit(PLAIN, 'make it blue [[reject]]', key),
      );
      expect((await readJob(PLAIN, id)).state).toBe('failed');
      expect(h.standin.openAssets()).toBe(0);
      expect(standin().deletedAssets).toHaveLength(1);
      expect(await h.balance(PLAIN)).toBe(1000);
    });

    it("refuses with the reason and holds nothing: a file that is not a picture, a type outside the three, a photo over 25 MB, another person's photo, an empty prompt, a long prompt, an unknown shape (V2)", async () => {
      await h.grant(PLAIN, 1000);
      const refuse = async (
        res: { status: number; body: unknown },
        status: number,
        code: string,
      ) => {
        expect([res.status, reasonOf(res).code]).toEqual([status, code]);
        expect(reasonOf(res).message).toMatch(
          /No points were taken|We couldn't find|Describe what you want to see/,
        );
        expect(reasonOf(res).message).not.toMatch(LONG_DASH);
        expect(await h.balance(PLAIN)).toBe(1000);
      };
      await refuse(
        await makeEdit(
          PLAIN,
          'make it blue',
          h.inputs.add(
            PLAIN,
            Buffer.from('this is not a picture at all'),
            'image/png',
            'ai/input-image',
          ),
        ),
        422,
        'ai_photo_unreadable',
      );
      await refuse(
        await makeEdit(
          PLAIN,
          'make it blue',
          h.inputs.add(
            PLAIN,
            Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]),
            'image/gif',
            'ai/input-image',
          ),
        ),
        422,
        'ai_photo_unreadable',
      );
      await refuse(
        await makeEdit(
          PLAIN,
          'make it blue',
          h.inputs.add(
            PLAIN,
            Buffer.concat([pngFile(), Buffer.alloc(25 * 1024 * 1024)]),
            'image/png',
            'ai/input-image',
          ),
        ),
        422,
        'ai_file_too_large',
      );
      await refuse(
        await makeEdit(PLAIN, 'make it blue', photoKey(BASIC)),
        404,
        'not_found',
      );
      await refuse(
        await makeEdit(PLAIN, 'make it blue', 'ai/input-image/nobody/none.png'),
        404,
        'not_found',
      );
      // A recording is not a photo: the wrong folder.
      await refuse(
        await makeEdit(PLAIN, 'make it blue', voiceFile(PLAIN, 3)),
        404,
        'not_found',
      );
      await refuse(
        await makeEdit(PLAIN, '   ', photoKey(PLAIN)),
        400,
        'ai_prompt_empty',
      );
      await refuse(
        await makeEdit(PLAIN, 'x'.repeat(1001), photoKey(PLAIN)),
        422,
        'ai_prompt_too_long',
      );
      await refuse(
        await makeEdit(PLAIN, 'make it blue', photoKey(PLAIN), {
          shape: '7:3',
        }),
        422,
        'ai_shape_unsupported',
      );
      expect(standin().assets).toHaveLength(0);
      expect(standin().images).toHaveLength(0);
      // No photo at all is a plain 400 from the request check.
      const none = await h
        .http()
        .post('/ai-tools/photo-edit/jobs')
        .set(auth(PLAIN))
        .set('Idempotency-Key', randomUUID())
        .send({
          prompt: 'make it blue',
          quoteToken: token(PLAIN, 'photo_edit_per_use', EDIT),
        });
      expect(none.status).toBe(400);
      expect(await h.balance(PLAIN)).toBe(1000);
    });
  });

  describe('AITOOLS-10: Make a video and Talking photo', () => {
    it("holds a clip per second, polls it while pending and generating, stores it as video, and keeps the points; sound is the setting's", async () => {
      await h.grant(PLAIN, 5000);
      const res = await makeVideo(
        PLAIN,
        'a red ball rolls across a table [[slow:600]]',
        4,
        { shape: '9:16' },
      );
      expect(res.status).toBe(202);
      expect(await h.balance(PLAIN)).toBe(5000 - VIDEO_SEC * 4);
      const id = data<AiJobView>(res).id;
      await h.jobs.drain();
      expect(standin().videos).toEqual([
        expect.objectContaining({
          kind: 'clip',
          model: 'veo-3.1-fast-generate-001',
          seconds: '4',
          shape: '9:16',
          resolution: '720p',
          withSound: true,
          assetIds: [],
        }),
      ]);
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        await h.flows.pass();
        for (const r of standin().genReads)
          if (r.answered) seen.add(r.answered);
        if ((await readJob(PLAIN, id)).state !== 'working') break;
        await sleep(50);
      }
      expect(seen).toEqual(new Set(['pending', 'generating', 'completed']));
      const done = await readJob(PLAIN, id);
      expect(done.state).toBe('done');
      expect(done.units).toBe(4);
      expect(done.outputs[0]).toMatchObject({
        kind: 'video',
        contentType: 'video/mp4',
        bytes: 4096,
        name: 'Video',
        pieceFormat: 'video',
      });
      expect(done.outputs[0].url).toBe(
        `https://media.example.test/ai/video/${PLAIN}/${id}.mp4`,
      );
      expect(done.outputs[0].downloadUrl).toMatch(
        /studio-video-\d{1,2}-[a-z]{3}-\d{4}\.mp4$/,
      );
      expect(await h.balance(PLAIN)).toBe(5000 - VIDEO_SEC * 4);
      // The sound switch is an admin setting.
      await set('ai.video_with_sound', 0);
      await run(await makeVideo(PLAIN, 'a ball', 6));
      expect(standin().videos[1]).toMatchObject({
        seconds: '6',
        withSound: false,
      });
    });

    it('a clip that fails, is refused or is moderated gives every point back; moderated has its own sentence', async () => {
      await h.grant(PLAIN, 8000);
      for (const [prompt, message] of [
        ['a [[fail]]', "That didn't work. No points were taken. Try again."],
        ['a [[moderated]]', "That video can't be made. No points were taken."],
        ['a [[reject]]', "That didn't work. No points were taken. Try again."],
      ] as const) {
        const id = await run(await makeVideo(PLAIN, prompt, 8));
        const done = await follow(PLAIN, id);
        expect([prompt, done.state, done.message]).toEqual([
          prompt,
          'failed',
          message,
        ]);
        expect(await h.balance(PLAIN)).toBe(8000);
      }
      // A video that never finishes is ended at the video ceiling (longer than a picture's).
      const stuck = await run(await makeVideo(PLAIN, 'a [[stuck]]', 4));
      const began = (await row(stuck)).createdAt;
      await h.flows.pass(new Date(began.getTime() + 400_000));
      expect((await readJob(PLAIN, stuck)).state).toBe('working');
      await h.flows.pass(new Date(began.getTime() + 601_000));
      expect((await readJob(PLAIN, stuck)).state).toBe('failed');
      expect(await h.balance(PLAIN)).toBe(8000);
    });

    it("photo to video sends the person's photo as the first frame and deletes the asset and the photo when the job ends", async () => {
      await h.grant(PLAIN, 5000);
      const key = photoKey(PLAIN);
      const id = await run(
        await makeVideo(PLAIN, 'the photo comes alive', 4, { photoKey: key }),
      );
      const assetId = standin().assets[0].id;
      expect(standin().videos[0]).toMatchObject({
        kind: 'clip',
        assetIds: [assetId],
      });
      expect((await follow(PLAIN, id)).state).toBe('done');
      expect(standin().deletedAssets).toEqual([assetId]);
      expect(h.inputs.removed).toEqual([key]);
    });

    it("refuses with the reason and holds nothing: a length not on the list, no length, a long description, a photo that is not a picture, another person's photo (V2)", async () => {
      await h.grant(PLAIN, 5000);
      const holdsNothing = async () =>
        expect(await h.balance(PLAIN)).toBe(5000);
      for (const seconds of [3, 5, 9, 60]) {
        const res = await makeVideo(PLAIN, 'a ball', seconds);
        expect([seconds, res.status, reasonOf(res).code]).toEqual([
          seconds,
          422,
          'ai_length_unsupported',
        ]);
      }
      expect(
        (
          await post(PLAIN, 'video/jobs', 'video_per_sec', VIDEO_SEC * 4, {
            prompt: 'a ball',
          })
        ).status,
      ).toBe(400);
      expect(reasonOf(await makeVideo(PLAIN, 'x'.repeat(1001))).code).toBe(
        'ai_prompt_too_long',
      );
      expect(
        reasonOf(await makeVideo(PLAIN, 'a ball', 4, { shape: '1:1' })).code,
      ).toBe('ai_shape_unsupported');
      expect(
        reasonOf(
          await makeVideo(PLAIN, 'a ball', 4, {
            photoKey: h.inputs.add(
              PLAIN,
              Buffer.from('nope'),
              'image/png',
              'ai/input-image',
            ),
          }),
        ).code,
      ).toBe('ai_photo_unreadable');
      expect(
        reasonOf(
          await makeVideo(PLAIN, 'a ball', 4, { photoKey: photoKey(BASIC) }),
        ).code,
      ).toBe('not_found');
      await holdsNothing();
      expect(standin().videos).toHaveLength(0);
    });

    it('a Talking photo prices the speech the Hub read, sends photo and voice as assets, deletes both and both uploads, and keeps the points', async () => {
      await h.grant(PLAIN, 5000);
      const voice = voiceFile(PLAIN, 12);
      const photo = photoKey(PLAIN);
      const quote = await h
        .http()
        .post('/ai-tools/talking-photo/quote')
        .set(auth(PLAIN))
        .send({ audioKey: voice });
      expect(quote.status).toBe(200);
      expect(
        data<{ speech: { seconds: number }; costPoints: number }>(quote),
      ).toMatchObject({
        speech: { seconds: 12 },
        costPoints: TALK_SEC * 12,
      });
      const res = await speak(
        PLAIN,
        { photoKey: photo, audioKey: voice },
        TALK_SEC * 12,
      );
      expect(res.status).toBe(202);
      const id = data<AiJobView>(res).id;
      expect(data<AiJobView>(res)).toMatchObject({
        units: 12,
        costPoints: TALK_SEC * 12,
        tool: 'talking-photo',
      });
      expect(await h.balance(PLAIN)).toBe(5000 - TALK_SEC * 12);
      await h.jobs.drain();
      expect(standin().assets.map((a) => a.name)).toEqual([
        'photo.png',
        'speech.wav',
      ]);
      expect(standin().videos[0]).toMatchObject({
        kind: 'talking',
        model: 'creatify-aurora',
        resolution: '720p',
        assetIds: standin().assets.map((a) => a.id),
      });
      expect((await row(id)).providerRef).toMatch(
        /^genrun:video:gen-\d+:asset-\d+\+asset-\d+$/,
      );
      const done = await follow(PLAIN, id);
      expect(done.state).toBe('done');
      expect(done.outputs[0]).toMatchObject({
        kind: 'video',
        name: 'Talking photo',
        pieceFormat: 'video',
      });
      expect(h.standin.openAssets()).toBe(0);
      expect(h.inputs.removed.sort()).toEqual([photo, voice].sort());
      expect(await h.balance(PLAIN)).toBe(5000 - TALK_SEC * 12);
    });

    it("a Talking photo takes the voice of a finished voice result of the person's own and leaves that result alone", async () => {
      await h.grant(PLAIN, 5000);
      const voiceJob = await h.create(PLAIN, {
        text: 'Hello from my voice',
        voiceId: 'ada',
        quoteToken: h.quote(PLAIN, 250),
      });
      expect(voiceJob.status).toBe(202);
      const voiceId = data<AiJobView>(voiceJob).id;
      const finished = await h.finish(PLAIN, voiceId);
      expect(finished.state).toBe('done');
      const audioKey = `ai/voiceover/${PLAIN}/${voiceId}.mp3`;
      expect(h.store.files.has(audioKey)).toBe(true);
      const quote = await h
        .http()
        .post('/ai-tools/talking-photo/quote')
        .set(auth(PLAIN))
        .send({ sourceJobId: voiceId });
      expect(quote.status).toBe(200);
      const seconds = data<{ speech: { seconds: number } }>(quote).speech
        .seconds;
      expect(seconds).toBeGreaterThanOrEqual(1);
      const before = await h.balance(PLAIN);
      const id = await run(
        await speak(
          PLAIN,
          { photoKey: photoKey(PLAIN), sourceJobId: voiceId },
          TALK_SEC * seconds,
        ),
      );
      expect(standin().assets.map((a) => a.name)).toEqual([
        'photo.png',
        'speech.mp3',
      ]);
      expect((await follow(PLAIN, id)).state).toBe('done');
      expect(await h.balance(PLAIN)).toBe(before - TALK_SEC * seconds);
      // The voice result is still there, and still the person's.
      expect(h.store.files.has(audioKey)).toBe(true);
      expect(h.inputs.removed).toHaveLength(1); // only the photo upload
      expect(h.standin.openAssets()).toBe(0);
    });

    it('refuses with the reason and holds nothing: a voice over the longest, a file that is not speech, a result that is not theirs, not finished or with no audio, no voice, two voices, no photo (V2)', async () => {
      await h.grant(PLAIN, 5000);
      const photo = photoKey(PLAIN);
      const attempt = (over: Record<string, unknown>, points = TALK_SEC) =>
        speak(PLAIN, { photoKey: photo, ...over }, points);
      const long = await attempt(
        { audioKey: voiceFile(PLAIN, 61) },
        TALK_SEC * 61,
      );
      expect([long.status, reasonOf(long).code]).toEqual([
        422,
        'ai_length_too_long',
      ]);
      expect(reasonOf(long).message).toBe(
        'The longest voice is 60 seconds. No points were taken.',
      );
      const garbage = await attempt({
        audioKey: h.inputs.add(
          PLAIN,
          Buffer.from('not audio at all, just words'),
          'audio/mpeg',
          'ai/input-audio',
        ),
      });
      expect([garbage.status, reasonOf(garbage).code]).toEqual([
        422,
        'ai_file_unreadable',
      ]);
      // A video file is not speech.
      const video = await attempt({
        audioKey: h.inputs.add(
          PLAIN,
          wavFile(2),
          'video/mp4',
          'ai/input-video',
        ),
      });
      expect([video.status, reasonOf(video).code]).toEqual([
        422,
        'ai_speech_unreadable',
      ]);
      const theirs = await attempt({ audioKey: voiceFile(BASIC, 3) });
      expect([theirs.status, reasonOf(theirs).code]).toEqual([
        404,
        'not_found',
      ]);
      const strangers = await seedDone(BASIC, 'voiceover_per_min', [
        { kind: 'audio', key: `ai/voiceover/${BASIC}/x.mp3` },
      ]);
      const notMine = await attempt({ sourceJobId: strangers });
      expect([notMine.status, reasonOf(notMine).code]).toEqual([
        404,
        'not_found',
      ]);
      const words = await seedDone(PLAIN, 'captions_per_min', [
        { kind: 'text', text: 'hello' },
      ]);
      const noAudio = await attempt({ sourceJobId: words });
      expect([noAudio.status, reasonOf(noAudio).code]).toEqual([
        422,
        'ai_speech_unreadable',
      ]);
      const flac = await seedDone(PLAIN, 'dub_standard_per_min_lang', [
        { kind: 'audio', key: `ai/dubbing/${PLAIN}/x.flac` },
      ]);
      expect(reasonOf(await attempt({ sourceJobId: flac })).code).toBe(
        'ai_speech_unreadable',
      );
      const working = randomUUID();
      await h.prisma.aiToolJob.create({
        data: {
          id: working,
          wawuUserId: PLAIN,
          tool: 'voiceover_per_min',
          idempotencyKey: working,
          requestHash: 'x',
          voiceId: 'ada',
          characters: 1,
          units: 1,
          costPoints: 1,
        },
      });
      const notReady = await attempt({ sourceJobId: working });
      expect([notReady.status, reasonOf(notReady).code]).toEqual([
        409,
        'job_not_ready',
      ]);
      const none = await attempt({});
      expect([none.status, reasonOf(none).code]).toEqual([
        400,
        'ai_speech_required',
      ]);
      const both = await attempt({
        audioKey: voiceFile(PLAIN, 3),
        sourceJobId: words,
      });
      expect([both.status, reasonOf(both).code]).toEqual([
        400,
        'ai_speech_required',
      ]);
      const noPhoto = await h
        .http()
        .post('/ai-tools/talking-photo/jobs')
        .set(auth(PLAIN))
        .set('Idempotency-Key', randomUUID())
        .send({
          audioKey: voiceFile(PLAIN, 3),
          quoteToken: token(PLAIN, 'talking_photo_per_sec', TALK_SEC * 3),
        });
      expect(noPhoto.status).toBe(400);
      expect(await h.balance(PLAIN)).toBe(5000);
      expect(standin().assets).toHaveLength(0);
      expect(standin().videos).toHaveLength(0);
    });

    it('streams a 200 MB clip into storage with the Hub memory flat; a type the Hub does not serve fails and releases (V8)', async () => {
      await h.grant(PLAIN, 6000);
      const id = await run(
        await makeVideo(PLAIN, `a clip [[bytes:${200 * 1024 * 1024}]]`, 4),
      );
      const base = process.memoryUsage().rss;
      let peak = base;
      const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 5);
      const done = await follow(PLAIN, id, 90_000);
      clearInterval(timer);
      const added = Math.round((peak - base) / (1024 * 1024));
      console.log(
        `200 MB clip stored: RSS +${added} MB over ${Math.round(base / (1024 * 1024))} MB`,
      );
      expect(done.state).toBe('done');
      expect(done.outputs[0]).toMatchObject({ bytes: 200 * 1024 * 1024 });
      // A whole-file read would add the 200 MB and more; what stays is garbage not yet collected and the client's own buffers.
      expect(added).toBeLessThan(130);
      const wrong = await run(
        await makeVideo(PLAIN, 'a clip [[type:video/webm]]', 4),
      );
      expect((await follow(PLAIN, wrong)).state).toBe('failed');
      expect((await row(wrong)).failureCode).toBe('output_type');
      expect(await h.balance(PLAIN)).toBe(6000 - VIDEO_SEC * 4);
    });
  });

  describe('AITOOLS-08: the long-job notice', () => {
    it('a job that ran longer than the setting writes exactly one ai_job_ready notice; none for a short job; none twice', async () => {
      await h.grant(PLAIN, 5000);
      await set('ai.job_ready_notice_seconds', 1);
      const short = await run(await makeImage(PLAIN, 'quick'));
      await follow(PLAIN, short);
      const count = () =>
        h.prisma.notification.count({
          where: { userWawuId: PLAIN, kind: 'ai_job_ready' },
        });
      expect(await count()).toBe(0);
      const id = await run(await makeVideo(PLAIN, 'long one [[slow:1300]]', 4));
      expect((await follow(PLAIN, id)).state).toBe('done');
      expect(await count()).toBe(1);
      // A replay: more passes, more reads, a reconcile: no second notice.
      await h.flows.pass();
      await h.flows.pass();
      await readJob(PLAIN, id);
      await h.jobs.reconcile(await row(id));
      expect(await count()).toBe(1);
      const note = await h.prisma.notification.findFirstOrThrow({
        where: { userWawuId: PLAIN, kind: 'ai_job_ready' },
        include: { target: true },
      });
      expect(note.title).toBe('Your video is ready');
      expect(note.target).toMatchObject({ targetKind: 'ai_job', targetId: id });
      expect(`${note.title} ${note.body}`).not.toMatch(LONG_DASH);
      expect(`${note.title} ${note.body}`).not.toMatch(
        /gemini|veo|aurora|creatify|elevenlabs|points|₦/i,
      );
      // A long job that fails tells the person too, in its own words.
      const failed = await run(
        await makeVideo(PLAIN, 'x [[fail]] [[slow:1300]]', 4),
      );
      expect((await follow(PLAIN, failed)).state).toBe('failed');
      expect(await count()).toBe(2);
      const bad = await h.prisma.notification.findFirstOrThrow({
        where: {
          userWawuId: PLAIN,
          kind: 'ai_job_ready',
          target: { targetId: failed },
        },
      });
      expect(bad.title).toBe('Your video did not work');
      expect(bad.body).toBe('No points were taken. Open it to try again.');
    });

    // Lead ruling (30 Oct 2026): nothing new reaches live users before the
    // owner reviews Studio 2. Only a tool with a listing switch writes the
    // notice, and only while the switch is on.
    const notices = () =>
      h.prisma.notification.count({
        where: { userWawuId: PLAIN, kind: 'ai_job_ready' },
      });

    it('a long Dubbing job, a launch tool, writes no ai_job_ready notice', async () => {
      await h.grant(PLAIN, 5000);
      await set('ai.job_ready_notice_seconds', 1);
      await set('ai.dubbing_languages', ['yo Yoruba', 'en English']);
      const dubs = new AiDubService(
        h.prisma,
        settings,
        h.get<AiVoiceProvider>(AI_VOICE_PROVIDER),
        h.jobs,
      );
      const fileKey = h.inputs.add(
        PLAIN,
        wavFile(30, '[[dub-delay:1300]]'),
        'audio/wav',
        'ai/input-audio',
      );
      const res = await post(
        PLAIN,
        'dubbing/jobs',
        'dub_standard_per_min_lang',
        cost('dub_standard_per_min_lang'),
        { fileKey, targetLanguage: 'yo' },
      );
      expect(res.status).toBe(202);
      await h.jobs.drain();
      const id = data<AiJobView>(res).id;
      let state = 'working';
      for (let i = 0; i < 100 && state === 'working'; i++) {
        await dubs.pass();
        state = (await readJob(PLAIN, id)).state;
        await sleep(60);
      }
      expect(state).toBe('done');
      const ranMs =
        (await row(id)).finishedAt!.getTime() -
        (await row(id)).createdAt.getTime();
      expect(ranMs).toBeGreaterThan(1000); // it ran longer than the setting
      expect(await notices()).toBe(0);
    });

    it('a long VoiceOver job, a launch tool, writes none either', async () => {
      await h.grant(PLAIN, 5000);
      await set('ai.job_ready_notice_seconds', 1);
      const res = await h.create(PLAIN, {
        text: 'Hello [[slow:1300]]',
        voiceId: 'ada',
        quoteToken: h.quote(PLAIN, 250),
      });
      expect(res.status).toBe(202);
      const done = await h.finish(PLAIN, data<AiJobView>(res).id);
      expect(done.state).toBe('done');
      expect(await notices()).toBe(0);
    });

    it('a long image job writes one while ai.listed.image is on, and none when the switch went off before it ended', async () => {
      await h.grant(PLAIN, 5000);
      await set('ai.job_ready_notice_seconds', 1);
      const on = await run(await makeImage(PLAIN, 'a long one [[slow:1300]]'));
      expect((await follow(PLAIN, on)).state).toBe('done');
      expect(await notices()).toBe(1);
      // The owner has not released the tool: the switch is off, so a job that ends now tells nobody.
      const off = await run(await makeImage(PLAIN, 'another [[slow:1300]]'));
      await set('ai.listed.image', null);
      expect((await follow(PLAIN, off)).state).toBe('done');
      expect(await notices()).toBe(1);
    });
  });

  describe('AITOOLS-08: the result into Create', () => {
    const piece = (
      who: string,
      id: string,
      outputIndex: unknown,
      key: string | null = randomUUID(),
    ) => {
      const req = h.http().post(`/ai-tools/jobs/${id}/piece`).set(auth(who));
      if (key !== null) req.set('Idempotency-Key', key);
      return req.send({ outputIndex });
    };

    it('an mp3 or wav result becomes an audio piece with a key under content/full/<their id>/; a picture an image piece; a clip a video piece', async () => {
      await h.grant(PLAIN, 5000);
      const voiceJob = await h.create(PLAIN, {
        text: 'Hello',
        voiceId: 'ada',
        quoteToken: h.quote(PLAIN, 250),
      });
      const voiceId = data<AiJobView>(voiceJob).id;
      await h.finish(PLAIN, voiceId);
      const audio = await piece(PLAIN, voiceId, 0);
      expect(audio.status).toBe(200);
      const a = data<AiPieceView>(audio);
      expect(a.format).toBe('audio');
      expect(a.full).toMatchObject({ contentType: 'audio/mpeg' });
      expect(a.full.key).toMatch(
        new RegExp(`^content/full/${PLAIN}/[0-9a-f-]{36}\\.mp3$`),
      );
      expect(a.full.name).toMatch(
        /^studio-voiceover-\d{1,2}-[a-z]{3}-\d{4}\.mp3$/,
      );
      expect(a.suggestedTitle).toMatch(
        /^Voice over, \d{1,2} [A-Z][a-z]{2} \d{4}$/,
      );
      expect(a.full.fileUrl).toContain(a.full.key);

      const image = await run(await makeImage(PLAIN, 'a red circle'));
      await follow(PLAIN, image);
      const p = data<AiPieceView>(await piece(PLAIN, image, 0));
      expect(p.format).toBe('image');
      expect(p.full).toMatchObject({ contentType: 'image/png', bytes: 2048 });
      expect(p.full.key).toMatch(
        new RegExp(`^content/full/${PLAIN}/[0-9a-f-]{36}\\.png$`),
      );
      expect(p.suggestedTitle).toMatch(/^Image, /);
      const clip = await run(await makeVideo(PLAIN, 'a ball', 4));
      await follow(PLAIN, clip);
      const v = data<AiPieceView>(await piece(PLAIN, clip, 0));
      expect(v.format).toBe('video');
      expect(v.full.contentType).toBe('video/mp4');
      // A wav result too.
      const wav = await seedDone(PLAIN, 'sfx', [
        { kind: 'audio', key: `ai/sound-effect/${PLAIN}/w.wav` },
      ]);
      h.store.files.set(`ai/sound-effect/${PLAIN}/w.wav`, Buffer.from('RIFF'));
      expect(data<AiPieceView>(await piece(PLAIN, wav, 0)).format).toBe(
        'audio',
      );
      // Nothing was published and the pieces are the copies, not the results.
      expect(h.media.copies.size).toBe(4);
      expect(h.media.files.size).toBe(2);
    });

    it('a FLAC dub, an AAC clip and words have no Create format: 409 no_format, nothing copied, and the job says pieceFormat null', async () => {
      const flac = await seedDone(
        PLAIN,
        'dub_standard_per_min_lang',
        [
          { kind: 'audio', key: `ai/dubbing/${PLAIN}/d.flac` },
          { kind: 'subtitles', text: 'WEBVTT' },
        ],
        `ai/dubbing/${PLAIN}/d.flac`,
      );
      const aac = await seedDone(
        PLAIN,
        'clean_audio_per_min',
        [{ kind: 'audio', key: `ai/clean-audio/${PLAIN}/c.aac` }],
        `ai/clean-audio/${PLAIN}/c.aac`,
      );
      for (const [id, index] of [
        [flac, 0],
        [flac, 1],
        [aac, 0],
      ] as const) {
        const res = await piece(PLAIN, id, index);
        expect([res.status, reasonOf(res).code]).toEqual([409, 'no_format']);
        expect(reasonOf(res).message).not.toMatch(LONG_DASH);
      }
      expect(h.media.copies.size).toBe(0);
      const view = await readJob(PLAIN, flac);
      expect(view.outputs[0]).toMatchObject({
        kind: 'audio',
        contentType: 'audio/flac',
        name: 'Dubbed audio',
        pieceFormat: null,
      });
      expect(view.outputs[0].downloadUrl).toMatch(
        /studio-dubbing-\d{1,2}-[a-z]{3}-\d{4}\.flac$/,
      );
      expect(view.outputs[1]).toEqual({ kind: 'subtitles', text: 'WEBVTT' });
      expect((await readJob(PLAIN, aac)).outputs[0]).toMatchObject({
        contentType: 'audio/aac',
        pieceFormat: null,
      });
    });

    it("twice returns one key and one copy; another person's job is not found; a job not done is job_not_ready; an output that is not there is not found; the key is required", async () => {
      const id = await seedDone(PLAIN, 'music_per_track', [
        { kind: 'audio', key: `ai/music/${PLAIN}/m.mp3` },
      ]);
      h.store.files.set(`ai/music/${PLAIN}/m.mp3`, Buffer.from('ID3'));
      const first = await piece(PLAIN, id, 0);
      const again = await piece(PLAIN, id, 0);
      expect(first.status).toBe(200);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(data<AiPieceView>(again).full.key).toBe(
        data<AiPieceView>(first).full.key,
      );
      expect(h.media.copies.size).toBe(1);
      expect([
        (await piece(BASIC, id, 0)).status,
        reasonOf(await piece(PRO, id, 0)).code,
      ]).toEqual([404, 'not_found']);
      expect(reasonOf(await piece(PLAIN, randomUUID(), 0)).code).toBe(
        'not_found',
      );
      expect((await piece(PLAIN, id, 5)).status).toBe(404);
      expect((await piece(PLAIN, id, -1)).status).toBe(400);
      expect((await piece(PLAIN, id, 'zero')).status).toBe(400);
      expect(reasonOf(await piece(PLAIN, id, 0, null)).code).toBe(
        'idempotency_key_required',
      );
      const working = randomUUID();
      await h.prisma.aiToolJob.create({
        data: {
          id: working,
          wawuUserId: PLAIN,
          tool: 'music_per_track',
          idempotencyKey: working,
          requestHash: 'x',
          voiceId: '',
          characters: 1,
          units: 1,
          costPoints: 1,
        },
      });
      const notReady = await piece(PLAIN, working, 0);
      expect([notReady.status, reasonOf(notReady).code]).toEqual([
        409,
        'job_not_ready',
      ]);
      const failedId = randomUUID();
      await h.prisma.aiToolJob.create({
        data: {
          id: failedId,
          wawuUserId: PLAIN,
          tool: 'music_per_track',
          idempotencyKey: failedId,
          requestHash: 'x',
          voiceId: '',
          characters: 1,
          units: 1,
          costPoints: 1,
          state: 'failed',
          failureCode: 'provider_failed',
        },
      });
      expect(reasonOf(await piece(PLAIN, failedId, 0)).code).toBe(
        'job_not_ready',
      );
    });

    it("a person with no room gets the presign's own answer and nothing is copied; a released copy gives the space back and a new copy is made", async () => {
      const id = await seedDone(PLAIN, 'music_per_track', [
        { kind: 'audio', key: `ai/music/${PLAIN}/m.mp3` },
      ]);
      h.store.files.set(`ai/music/${PLAIN}/m.mp3`, Buffer.from('ID3'));
      h.media.copyRefusal = new PayloadTooLargeException({
        message:
          'This file needs 3 bytes, but only 0 bytes of your 1GB storage is free.',
        reason: {
          code: 'storage_limit_reached',
          neededBytes: 3,
          usedBytes: 1,
          limitBytes: 1,
          tickHeld: false,
        },
      });
      const full = await piece(PLAIN, id, 0);
      expect([full.status, reasonOf(full).code]).toEqual([
        413,
        'storage_limit_reached',
      ]);
      expect(h.media.copies.size).toBe(0);
      h.media.copyRefusal = null;
      const first = data<AiPieceView>(await piece(PLAIN, id, 0));
      // The person releases the key (POST /uploads/release): the next call is a new copy under a new key.
      h.media.copies.get(first.full.key)!.released = true;
      const second = data<AiPieceView>(await piece(PLAIN, id, 0));
      expect(second.full.key).not.toBe(first.full.key);
      expect(h.media.copies.size).toBe(2);
    });
  });

  describe('AITOOLS-09, AITOOLS-10: leaving the Hub', () => {
    it("account deletion waits for the provider to drop the person's photo and voice, then goes on", async () => {
      await h.grant(PLAIN, 1000);
      const key = photoKey(PLAIN, '[[asset-delete-fail]]');
      const id = await run(await makeEdit(PLAIN, 'a [[stuck]]', key));
      expect(h.standin.openAssets()).toBe(1);
      const purge = h.get<AiToolsPurgeService>(AiToolsPurgeService);
      // The job is still being made and the provider will not delete the photo yet: the purge waits.
      await expect(purge.beforeErase(PLAIN)).rejects.toThrow(
        /still holds a copy/,
      );
      expect((await row(id)).providerRef).toMatch(/^asset:asset-\d+$/);
      h.standin.releaseStubborn();
      await purge.beforeErase(PLAIN);
      expect(h.standin.openAssets()).toBe(0);
    });

    it('every folder the new tools write is a folder the Hub writes and the purge decides (V9)', () => {
      for (const folder of ['ai/image', 'ai/video']) {
        expect([...GENERATED_KEY_FOLDERS]).toContain(folder);
        expect(FILE_KINDS[folder]?.decision).toBe('DELETE');
      }
      expect(KEY_FOLDERS).toContain('ai/input-image');
      expect(FILE_KINDS['ai/input-image']?.decision).toBe('DELETE');
    });
  });
});
