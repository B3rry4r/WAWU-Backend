// Contract tests for AITOOLS-12 (R-109): Music for a video and Split a song. Real HTTP against the caller's
// DATABASE_URL, the real job, input and points services, and the real HTTP voice adapter against the voice stand-in on
// this machine (scripts/dev/voice-standin.cjs). NOT RUN against the real provider (the owner's credits are not bought
// yet): each tool's one proof call is written in tasks/AITOOLS-12.md. No payment provider and no Fintava double.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import type {
  AiFileQuoteView,
  AiJobView,
  AiPieceView,
  AiToolsView,
} from '../ai-tools-view.type';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';
import { mp4File, wavFile } from '../../../test/ai-tools/media-fixtures';
import { VIDEO_MUSIC_TOOL } from '../tools/video-music.tool';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const cost = (id: string) => plan.actions.find((a) => a.id === id)!.points;
const VIDEO_MUSIC = cost('video_music_per_track');
const STEMS = cost('stems_per_song');
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools12@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const LONG_DASH = /[–—]/;
const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason: { code: string; message: string } }).reason;

/** A video of `seconds` with a stand-in marker in a box the length reader skips. */
function video(seconds: number, tail = ''): Buffer {
  const free = Buffer.alloc(8 + tail.length);
  free.writeUInt32BE(8 + tail.length, 0);
  free.write('free', 4, 'latin1');
  free.write(tail, 8, 'latin1');
  return Buffer.concat([mp4File({ milliseconds: seconds * 1000 }), free]);
}

describe('AITOOLS-12: Music for a video and Split a song (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | string[] | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const switchOn = async () => {
    for (const id of ['video-music', 'stems']) await set(`ai.listed.${id}`, 1);
  };
  const auth = (who: string) => ({
    Authorization: `Bearer ${h.tokensOf[who]}`,
  });
  const token = (who: string, action: string, points: number) =>
    h.tokens.issue(
      who,
      action,
      points,
      new Date(Date.now() + (300 - h.tokens.seconds) * 1000),
    );
  const standin = () => h.standin.state;
  const readJob = async (who: string, id: string) =>
    data<AiJobView>(await h.http().get(`/ai-tools/jobs/${id}`).set(auth(who)));
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
  const videoFile = (who: string, seconds: number, tail = '') =>
    h.inputs.add(who, video(seconds, tail), 'video/mp4', 'ai/input-video');
  const songFile = (who: string, seconds: number, tail = '') =>
    h.inputs.add(who, wavFile(seconds, tail), 'audio/wav', 'ai/input-audio');
  const makeMusic = (
    who: string,
    fileKey: string,
    over: Record<string, unknown> = {},
    key?: string,
  ) =>
    post(
      who,
      'video-music/jobs',
      'video_music_per_track',
      VIDEO_MUSIC,
      { fileKey, ...over },
      key,
    );
  const split = (
    who: string,
    fileKey: string,
    over: Record<string, unknown> = {},
    key?: string,
  ) =>
    post(who, 'stems/jobs', 'stems_per_song', STEMS, { fileKey, ...over }, key);
  const run = async (res: { status: number; body: unknown }) => {
    expect(res.status).toBe(202);
    await h.jobs.drain();
    return data<AiJobView>(res).id;
  };
  const row = (id: string) =>
    h.prisma.aiToolJob.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    h = await bootAiTools({ media: true });
    settings = h.get<PlanSettingsService>(PlanSettingsService);
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
    for (const list of [s.videoMusic, s.stems] as unknown[][]) list.length = 0;
    h.store.files.clear();
    h.store.removed.length = 0;
    h.media.copies.clear();
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    for (const key of [...touched]) await set(key, null);
    touched.clear();
    await switchOn();
  });

  it('lists neither tool while its switch is off and answers unavailable with nothing held; lists each whole when on', async () => {
    for (const id of ['video-music', 'stems'])
      await set(`ai.listed.${id}`, null);
    await h.grant(PLAIN, 5000);
    const off = data<AiToolsView>(
      await h.http().get('/ai-tools').set(auth(PLAIN)),
    );
    expect(off.tools.map((t) => t.id)).not.toContain('video-music');
    expect(off.tools.map((t) => t.id)).not.toContain('stems');
    const key = videoFile(PLAIN, 20);
    for (const res of [
      await makeMusic(PLAIN, key),
      await split(PLAIN, songFile(PLAIN, 20)),
    ]) {
      expect(res.status).toBe(503);
      expect(reasonOf(res).code).toBe('ai_tool_unavailable');
    }
    expect(
      (
        await h
          .http()
          .post('/ai-tools/video-music/quote')
          .set(auth(PLAIN))
          .send({ fileKey: key })
      ).status,
    ).toBe(503);
    expect(await h.balance(PLAIN)).toBe(5000);
    await switchOn();
    const on = data<AiToolsView>(
      await h.http().get('/ai-tools').set(auth(PLAIN)),
    );
    const byId = new Map(on.tools.map((t) => [t.id, t]));
    expect(byId.get('video-music')).toMatchObject({
      action: 'video_music_per_track',
      unit: 'track',
      costPointsPerUnit: VIDEO_MUSIC,
      enabled: true,
      input: {
        kind: 'file',
        file: {
          only: 'video',
          maxSeconds: 120,
          description: { maxCharacters: 1000 },
        },
      },
    });
    expect(byId.get('stems')).toMatchObject({
      action: 'stems_per_song',
      unit: 'use',
      costPointsPerUnit: STEMS,
      enabled: true,
      input: { kind: 'file', file: { only: 'audio', parts: [2, 6] } },
    });
    expect(JSON.stringify(on)).not.toMatch(LONG_DASH);
    expect(JSON.stringify(on)).not.toMatch(/eleven|music_v|stem_variation/i);
  });

  describe('Music for a video', () => {
    it('reads the length itself, holds, sends the video, stores the music as audio, commits, deletes the video and lets it become a piece', async () => {
      await h.grant(PLAIN, 5000);
      const fileKey = videoFile(PLAIN, 20);
      const quote = data<AiFileQuoteView>(
        await h
          .http()
          .post('/ai-tools/video-music/quote')
          .set(auth(PLAIN))
          .send({ fileKey }),
      );
      expect(quote.file.seconds).toBe(20);
      expect(quote.costPoints).toBe(VIDEO_MUSIC);
      const id = await run(
        await makeMusic(PLAIN, fileKey, { description: '  warm and slow  ' }),
      );
      const job = await readJob(PLAIN, id);
      expect(job.state).toBe('done');
      expect(job.tool).toBe('video-music');
      expect(job.units).toBe(1);
      expect(job.costPoints).toBe(VIDEO_MUSIC);
      expect(await h.balance(PLAIN)).toBe(5000 - VIDEO_MUSIC);
      expect(standin().videoMusic).toEqual([
        expect.objectContaining({
          fileType: 'video/mp4',
          descriptionChars: 'warm and slow'.length,
          model: null,
        }),
      ]);
      expect(job.outputs).toHaveLength(1);
      expect(job.outputs[0]).toMatchObject({
        kind: 'audio',
        contentType: 'audio/mpeg',
        name: 'Music for a video',
        pieceFormat: 'audio',
      });
      expect([...h.store.files.keys()]).toEqual([
        `ai/video-music/${PLAIN}/${id}.mp3`,
      ]);
      expect(h.inputs.removed).toContain(fileKey);
      const piece = await h
        .http()
        .post(`/ai-tools/jobs/${id}/piece`)
        .set(auth(PLAIN))
        .set('Idempotency-Key', randomUUID())
        .send({ outputIndex: 0 });
      expect(piece.status).toBe(200);
      const view = data<AiPieceView>(piece);
      expect(view.format).toBe('audio');
      expect(view.full.key).toMatch(new RegExp(`^content/full/${PLAIN}/`));
      expect(view.suggestedTitle).toMatch(/^Music for a video, /);
    });

    it('refuses a file that is not a video, a video over the length setting, over the byte cap, a mood that is too long and a stale quote, each with nothing held', async () => {
      await h.grant(PLAIN, 5000);
      const audio = await makeMusic(PLAIN, songFile(PLAIN, 20));
      expect(audio.status).toBe(422);
      expect(reasonOf(audio).code).toBe('ai_file_unreadable');
      expect(reasonOf(audio).message).toMatch(/video/);
      await set('ai.video_music_max_seconds', 10);
      const long = await makeMusic(PLAIN, videoFile(PLAIN, 20));
      expect(long.status).toBe(422);
      expect(reasonOf(long)).toMatchObject({
        code: 'ai_length_too_long',
        cap: 'length_seconds',
        capLimit: 10,
      });
      await set('ai.video_music_max_seconds', null);
      await set('ai.input_max_bytes', 1_048_576);
      const big = await makeMusic(
        PLAIN,
        videoFile(PLAIN, 20, 'x'.repeat(1_200_000)),
      );
      expect(big.status).toBe(422);
      expect(reasonOf(big)).toMatchObject({
        code: 'ai_file_too_large',
        cap: 'file_bytes',
        capLimit: 1_048_576,
      });
      await set('ai.input_max_bytes', null);
      // Whatever the setting says, a video over the provider's own 200 MB is refused.
      expect(() =>
        VIDEO_MUSIC_TOOL.checkFile!(
          {
            contentType: 'video/mp4',
            seconds: 20,
            bytes: 201 * 1024 * 1024,
            minutes: 1,
          },
          { number: () => 500 * 1024 * 1024, lines: () => [] },
        ),
      ).toThrow(/too big/);
      await set('ai.video_music_max_prompt_chars', 10);
      const chatty = await makeMusic(PLAIN, videoFile(PLAIN, 20), {
        description: 'x'.repeat(11),
      });
      expect(chatty.status).toBe(422);
      expect(reasonOf(chatty).code).toBe('ai_prompt_too_long');
      await set('ai.video_music_max_prompt_chars', null);
      const stale = await post(
        PLAIN,
        'video-music/jobs',
        'video_music_per_track',
        VIDEO_MUSIC + 1,
        {
          fileKey: videoFile(PLAIN, 20),
        },
      );
      expect(stale.status).toBe(409);
      expect(reasonOf(stale).code).toBe('quote_changed');
      expect((await makeMusic(BASIC, videoFile(PLAIN, 20))).status).toBe(404);
      expect(await h.balance(PLAIN)).toBe(5000);
      expect(standin().videoMusic).toHaveLength(0);
    });

    it('gives every point back and deletes the video when the provider fails, refuses or answers a page', async () => {
      await h.grant(PLAIN, 5000);
      for (const marker of [
        '[[fail]]',
        '[[reject]]',
        '[[html]]',
        '[[moderated]]',
      ]) {
        const fileKey = videoFile(PLAIN, 20, marker);
        const id = await run(await makeMusic(PLAIN, fileKey));
        const job = await readJob(PLAIN, id);
        expect(job.state).toBe('failed');
        expect(job.message).toMatch(/No points were taken/);
        expect(await h.balance(PLAIN)).toBe(5000);
        expect(h.inputs.removed).toContain(fileKey);
      }
      expect(h.store.files.size).toBe(0);
    });

    it('says "This isn\'t available right now" for a 403 from the provider\'s plan, gives every point back and logs an owner item', async () => {
      await h.grant(PLAIN, 5000);
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        const id = await run(
          await makeMusic(PLAIN, videoFile(PLAIN, 20, '[[plan]]')),
        );
        const job = await readJob(PLAIN, id);
        expect(job.state).toBe('failed');
        expect(job.message).toBe(
          "This isn't available right now. No points were taken.",
        );
        expect((await row(id)).failureCode).toBe('provider_plan');
        expect(await h.balance(PLAIN)).toBe(5000);
        expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
          /OWNER ITEM.*403/,
        );
      } finally {
        error.mockRestore();
      }
    });

    it('runs one job for one Idempotency-Key and never takes points below zero for two at once', async () => {
      await h.grant(PLAIN, VIDEO_MUSIC + 10);
      const fileKey = videoFile(PLAIN, 20);
      const key = randomUUID();
      const first = await makeMusic(PLAIN, fileKey, {}, key);
      const second = await makeMusic(PLAIN, fileKey, {}, key);
      expect([first.status, second.status]).toEqual([202, 200]);
      expect(data<AiJobView>(second).id).toBe(data<AiJobView>(first).id);
      await h.jobs.drain();
      expect(standin().videoMusic).toHaveLength(1);
      expect(await h.balance(PLAIN)).toBe(10);
      await h.clean();
      await h.grant(PLAIN, VIDEO_MUSIC + 10);
      const [a, b] = await Promise.all([
        makeMusic(PLAIN, videoFile(PLAIN, 20)),
        makeMusic(PLAIN, videoFile(PLAIN, 20)),
      ]);
      expect([a.status, b.status].sort()).toEqual([202, 402]);
      await h.jobs.drain();
      expect(await h.balance(PLAIN)).toBe(10);
    });
  });

  describe('Split a song', () => {
    it('turns a stand-in zip into two stored mp3 files, each listed with its plain name and a piece format', async () => {
      await h.grant(PLAIN, 5000);
      const fileKey = songFile(PLAIN, 20);
      const quote = data<AiFileQuoteView>(
        await h
          .http()
          .post('/ai-tools/stems/quote')
          .set(auth(PLAIN))
          .send({ fileKey }),
      );
      expect(quote.costPoints).toBe(STEMS);
      const id = await run(await split(PLAIN, fileKey));
      const job = await readJob(PLAIN, id);
      expect(job.state).toBe('done');
      expect(job.costPoints).toBe(STEMS);
      expect(await h.balance(PLAIN)).toBe(5000 - STEMS);
      expect(standin().stems.map((s) => s.variation)).toEqual(['two_stems_v1']);
      expect(job.outputs.map((o) => o.name)).toEqual(['Voice', 'The rest']);
      for (const out of job.outputs) {
        expect(out).toMatchObject({
          kind: 'audio',
          contentType: 'audio/mpeg',
          pieceFormat: 'audio',
        });
        expect(out.downloadUrl).toMatch(
          /studio-stems-(voice|the-rest)-\d+-[a-z]+-\d{4}\.mp3$/,
        );
      }
      expect([...h.store.files.keys()].sort()).toEqual([
        `ai/stems/${PLAIN}/${id}-the-rest-2.mp3`,
        `ai/stems/${PLAIN}/${id}-voice-1.mp3`,
      ]);
      expect(job.audioUrl).toBe(job.outputs[0].url);
      expect(h.inputs.removed).toContain(fileKey);
      // Each part has its own piece.
      for (const index of [0, 1]) {
        const piece = await h
          .http()
          .post(`/ai-tools/jobs/${id}/piece`)
          .set(auth(PLAIN))
          .set('Idempotency-Key', randomUUID())
          .send({ outputIndex: index });
        expect(piece.status).toBe(200);
        const view = data<AiPieceView>(piece);
        expect(view.format).toBe('audio');
        expect(view.suggestedTitle).toMatch(
          index === 0 ? /^Voice, / : /^The rest, /,
        );
      }
      const bad = await h
        .http()
        .post(`/ai-tools/jobs/${id}/piece`)
        .set(auth(PLAIN))
        .set('Idempotency-Key', randomUUID())
        .send({ outputIndex: 2 });
      expect(bad.status).toBe(404);
    });

    it('asks for six parts and stores six, with a name the table does not know called "Part N"', async () => {
      await h.grant(PLAIN, 5000);
      const six = await run(
        await split(PLAIN, songFile(PLAIN, 20), { parts: 6 }),
      );
      const job = await readJob(PLAIN, six);
      expect(standin().stems.at(-1)?.variation).toBe('six_stems_v1');
      expect(job.outputs.map((o) => o.name)).toEqual([
        'Voice',
        'Drums',
        'Bass',
        'Guitar',
        'Piano',
        'The rest',
      ]);
      expect(h.store.files.size).toBe(6);
      const odd = await run(
        await split(PLAIN, songFile(PLAIN, 20, '[[zip-names:vocals,mystery]]')),
      );
      expect((await readJob(PLAIN, odd)).outputs.map((o) => o.name)).toEqual([
        'Voice',
        'Part 2',
      ]);
    });

    it('refuses an archive it cannot open safely (a path outside its folder, too many entries, a zip bomb, a lying header, a bad CRC, not a zip) and gives every point back with nothing stored', async () => {
      await h.grant(PLAIN, 5000);
      const error = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        for (const marker of [
          '[[zip-escape]]',
          '[[zip-many]]',
          '[[zip-bomb]]',
          '[[zip-lie]]',
          '[[zip-corrupt]]',
          '[[zip-notzip]]',
        ]) {
          const fileKey = songFile(PLAIN, 20, marker);
          const id = await run(await split(PLAIN, fileKey));
          const job = await readJob(PLAIN, id);
          expect(job.state).toBe('failed');
          expect(job.outputs).toEqual([]);
          expect((await row(id)).failureCode).toBe('output_shape');
          expect(job.message).toMatch(/No points were taken/);
          expect(await h.balance(PLAIN)).toBe(5000);
          expect(h.inputs.removed).toContain(fileKey);
        }
        expect(h.store.files.size).toBe(0);
        expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
          /stem archive was refused \(unsafe_name\)/,
        );
      } finally {
        error.mockRestore();
      }
      const id = await run(
        await split(PLAIN, songFile(PLAIN, 20, '[[zip-nonaudio]]')),
      );
      expect((await row(id)).failureCode).toBe('output_type');
      expect(await h.balance(PLAIN)).toBe(5000);
      expect(h.store.files.size).toBe(0);
    });

    it('gives every point back for a provider fault, a refusal and a 403 (the plan does not cover the route)', async () => {
      await h.grant(PLAIN, 5000);
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        for (const [marker, code, message] of [
          ['[[fail]]', 'provider_unavailable', /No points were taken/],
          ['[[reject]]', 'provider_failed', /No points were taken/],
          [
            '[[plan]]',
            'provider_plan',
            /^This isn't available right now\. No points were taken\.$/,
          ],
        ] as const) {
          const id = await run(await split(PLAIN, songFile(PLAIN, 20, marker)));
          const job = await readJob(PLAIN, id);
          expect(job.state).toBe('failed');
          expect((await row(id)).failureCode).toBe(code);
          expect(job.message).toMatch(message);
          expect(await h.balance(PLAIN)).toBe(5000);
        }
      } finally {
        error.mockRestore();
      }
    });

    it('refuses a video, a song over the length setting and parts that are neither 2 nor 6, with nothing held; one job for one key; never below zero', async () => {
      await h.grant(PLAIN, STEMS + 10);
      const asVideo = await split(PLAIN, videoFile(PLAIN, 20));
      expect(asVideo.status).toBe(422);
      expect(reasonOf(asVideo).code).toBe('ai_file_unreadable');
      await set('ai.stems_max_seconds', 10);
      const long = await split(PLAIN, songFile(PLAIN, 20));
      expect(long.status).toBe(422);
      expect(reasonOf(long).code).toBe('ai_length_too_long');
      await set('ai.stems_max_seconds', null);
      const three = await split(PLAIN, songFile(PLAIN, 20), { parts: 3 });
      expect(three.status).toBe(400);
      expect(await h.balance(PLAIN)).toBe(STEMS + 10);
      const fileKey = songFile(PLAIN, 20);
      const key = randomUUID();
      const first = await split(PLAIN, fileKey, {}, key);
      const second = await split(PLAIN, fileKey, {}, key);
      expect([first.status, second.status]).toEqual([202, 200]);
      await h.jobs.drain();
      expect(standin().stems).toHaveLength(1);
      expect(await h.balance(PLAIN)).toBe(10);
      await h.clean();
      await h.grant(PLAIN, STEMS + 10);
      const [a, b] = await Promise.all([
        split(PLAIN, songFile(PLAIN, 20)),
        split(PLAIN, songFile(PLAIN, 20)),
      ]);
      expect([a.status, b.status].sort()).toEqual([202, 402]);
      await h.jobs.drain();
      expect(await h.balance(PLAIN)).toBe(10);
    });
  });
});
