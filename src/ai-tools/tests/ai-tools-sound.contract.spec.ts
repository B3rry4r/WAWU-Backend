// Contract tests for task AITOOLS-03: Sound effect and Music track on the one
// AI job pipeline.
//
// Real HTTP against the caller's DATABASE_URL with real RS256 tokens from
// mock-wawu-id, the real controller, job service, points service and settings,
// and the real HTTP voice adapter talking to the voice stand-in
// (scripts/dev/voice-standin.cjs) on this machine. NOT RUN against the real
// provider: its key is not on any build machine. No payment provider and no
// Fintava double is started.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { audioKeyFor } from '../audio/ai-audio-store';
import { jobIdFor } from '../ai-job.service';
import type { AiJobView, AiToolsView } from '../ai-tools-view.type';
import { AI_VOICE_PROVIDER } from '../voice/ai-voice-provider';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const sfxAction = plan.actions.find((a) => a.id === 'sfx')!;
const musicAction = plan.actions.find((a) => a.id === 'music_per_track')!;
const SFX = sfxAction.points;
const MUSIC = musicAction.points;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools03@admin.test.wawu.dev',
  role: AdminRole.finance,
};

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (
    res.body as {
      reason: Record<string, unknown> & { code: string; message: string };
    }
  ).reason;
const SOUND = 'Rain on a tin roof with distant thunder.';
const TRACK = 'A calm acoustic guitar tune for a morning video.';

describe('AITOOLS-03: Sound effect and Music track (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const quote = (action: string, who: string, cost: number, ttl = 300) =>
    h.tokens.issue(
      who,
      action,
      cost,
      new Date(Date.now() + (ttl - h.tokens.seconds) * 1000),
    );
  const sfxBody = (prompt = SOUND, over: object = {}, who = PLAIN) => ({
    prompt,
    quoteToken: quote('sfx', who, SFX),
    ...over,
  });
  const musicBody = (prompt = TRACK, over: object = {}, who = PLAIN) => ({
    prompt,
    quoteToken: quote('music_per_track', who, MUSIC),
    ...over,
  });
  const post = (
    route: 'sound-effect' | 'music',
    who: string,
    payload: object,
    key?: string | null,
  ) => {
    const req = h
      .http()
      .post(`/ai-tools/${route}/jobs`)
      .set('Authorization', `Bearer ${h.tokensOf[who]}`);
    if (key !== null) req.set('Idempotency-Key', key ?? randomUUID());
    return req.send(payload);
  };
  const createSfx = (who: string, payload: object, key?: string | null) =>
    post('sound-effect', who, payload, key);
  const createMusic = (who: string, payload: object, key?: string | null) =>
    post('music', who, payload, key);
  const catalogue = async (who = PLAIN) =>
    data<AiToolsView>(
      await h
        .http()
        .get('/ai-tools')
        .set('Authorization', `Bearer ${h.tokensOf[who]}`),
    );
  const holdsOf = (who: string) =>
    h.prisma.pointHold.findMany({ where: { wawuUserId: who } });
  const jobsOf = (who: string) =>
    h.prisma.aiToolJob.findMany({ where: { wawuUserId: who } });
  /**
   * The AITOOLS-02 rollback's own check (the `DO` block of its rollback.sql,
   * run as written): it refuses while a row holds a provider id, an upload or
   * an output that is not the job's audio. Run here on the given failed jobs
   * only (every other row of the table is removed inside a transaction that
   * is always rolled back), it must pass for them; with a provider id on one
   * of them it must refuse, so the check is live.
   */
  const expectRollbackNotBlockedBy = async (ids: string[]) => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261101100000_ai_tool_job_outputs/rollback.sql',
      ),
      'utf8',
    );
    const guard = sql.slice(
      sql.indexOf('DO $$'),
      sql.indexOf('END $$;') + 'END $$;'.length,
    );
    expect(guard.startsWith('DO $$')).toBe(true);
    class Done extends Error {}
    let outcome: { passed: boolean; refusedWithProviderId: boolean } | null =
      null;
    try {
      await h.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `DELETE FROM "AiToolJob" WHERE NOT ("id" = ANY($1::text[]))`,
          ids,
        );
        let passed = true;
        await tx.$executeRawUnsafe('SAVEPOINT guard');
        try {
          await tx.$executeRawUnsafe(guard);
        } catch {
          passed = false;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT guard');
        }
        await tx.$executeRawUnsafe(
          `UPDATE "AiToolJob" SET "providerRef" = 'p-1' WHERE "id" = $1`,
          ids[0],
        );
        let refusedWithProviderId = false;
        try {
          await tx.$executeRawUnsafe(guard);
        } catch (e) {
          refusedWithProviderId = /AITOOLS-02 rollback/.test(
            (e as Error).message,
          );
        }
        outcome = { passed, refusedWithProviderId };
        throw new Done();
      });
    } catch (e) {
      if (!(e instanceof Done)) throw e;
    }
    expect(outcome).toEqual({ passed: true, refusedWithProviderId: true });
  };
  const nothingHeld = async (balance: number) => {
    expect(await holdsOf(PLAIN)).toHaveLength(0);
    expect(await jobsOf(PLAIN)).toHaveLength(0);
    expect(await h.balance(PLAIN)).toBe(balance);
  };

  beforeAll(async () => {
    h = await bootAiTools();
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
    await h.clean();
    h.store.files.clear();
    h.store.removed.length = 0;
    h.store.failPut = false;
    h.standin.state.sfx.length = 0;
    h.standin.state.music.length = 0;
  });

  it('needs a signed-in caller on both routes', async () => {
    for (const route of ['sound-effect', 'music']) {
      const res = await h
        .http()
        .post(`/ai-tools/${route}/jobs`)
        .set('Idempotency-Key', randomUUID())
        .send({ prompt: SOUND, quoteToken: 'x' });
      expect(res.status).toBe(401);
    }
  });

  // ---------------------------------------------------------------------------
  // Check 1: the catalogue lists both before anyone runs them
  // ---------------------------------------------------------------------------

  it('check 1: GET /ai-tools lists Sound effect at its flat price a use and Music track at its flat price a track, with the description limit and the optional length, before anyone runs them', async () => {
    const view = await catalogue();
    const sfx = view.tools.find((t) => t.id === 'sound-effect')!;
    const music = view.tools.find((t) => t.id === 'music')!;
    expect(sfx).toMatchObject({
      action: 'sfx',
      name: 'Sound effect',
      unit: 'use',
      costPointsPerUnit: SFX,
      enabled: true,
      voices: [],
      input: {
        kind: 'prompt',
        maxCharacters: plan.caps.maxCharsPerJob,
        charactersPerUnit: plan.caps.maxCharsPerJob,
        length: { field: 'durationSeconds', min: 0.5, max: 30, whole: false },
      },
    });
    expect(sfx.input.instrumental).toBeUndefined();
    expect(music).toMatchObject({
      action: 'music_per_track',
      name: 'Music track',
      unit: 'track',
      costPointsPerUnit: MUSIC,
      enabled: true,
      voices: [],
      input: {
        kind: 'prompt',
        maxCharacters: plan.caps.maxCharsPerJob,
        length: { field: 'lengthSeconds', min: 3, max: 300, whole: true },
        instrumental: true,
      },
    });
    // The board's figures (PT1), as launch settings.
    expect([SFX, MUSIC]).toEqual([75, 500]);

    // The quote for each action shows the same flat figure.
    await h.grant(PLAIN, MUSIC * 2);
    expect(
      (await h.quotes.quote(PLAIN, { action: 'sfx', units: 1 })).costPoints,
    ).toBe(SFX);
    expect(
      (await h.quotes.quote(PLAIN, { action: 'music_per_track', units: 1 }))
        .costPoints,
    ).toBe(MUSIC);

    // No provider name, no provider id, no model name and no em-dash (R-68, R-5).
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/eleven|stand-in|xi-api|music_v|text_to_sound/i);
    expect(text).not.toMatch(/—/);
  });

  it('check 1: a figure or a limit an admin changes shows at once (R-65), and the words carry no price claim', async () => {
    await set('points.action.sfx', 120);
    await set('points.action.music_per_track', 900);
    await set('ai.sfx_max_seconds', 12);
    await set('ai.music_max_seconds', 90);
    await set('ai.sfx_max_prompt_chars', 200);
    await set('ai.music_max_prompt_chars', 300);
    try {
      const view = await catalogue();
      const sfx = view.tools.find((t) => t.id === 'sound-effect')!;
      const music = view.tools.find((t) => t.id === 'music')!;
      expect(sfx.costPointsPerUnit).toBe(120);
      expect(music.costPointsPerUnit).toBe(900);
      expect(sfx.input).toMatchObject({
        maxCharacters: 200,
        length: { max: 12 },
      });
      expect(music.input).toMatchObject({
        maxCharacters: 300,
        length: { max: 90 },
      });
      // The lead's AITOOLS-02 ruling: no price word and no digit in any name or description.
      for (const t of view.tools)
        for (const words of [t.name, t.description])
          expect(words).not.toMatch(
            /half|double|twice|cheap|discount|save|less|more|percent|%|\bpoints?\b|\bcost|\bprice|\d/i,
          );
    } finally {
      for (const key of [
        'points.action.sfx',
        'points.action.music_per_track',
        'ai.sfx_max_seconds',
        'ai.music_max_seconds',
        'ai.sfx_max_prompt_chars',
        'ai.music_max_prompt_chars',
      ])
        await set(key, null);
    }
  });

  it('check 1: with no voice provider set up neither tool is listed, and a job is refused with nothing held', async () => {
    await h.grant(PLAIN, MUSIC + SFX);
    const provider = h.get<{
      configured: boolean;
      promptToolsConfigured: boolean;
    }>(AI_VOICE_PROVIDER);
    // Round 2: these two tools need a host and a key (promptToolsConfigured),
    // not a voice; with no voices set they are still listed and run.
    const noVoices = jest
      .spyOn(provider, 'configured', 'get')
      .mockReturnValue(false);
    try {
      const ids = (await catalogue()).tools.map((t) => t.id);
      expect(ids).toContain('sound-effect');
      expect(ids).toContain('music');
    } finally {
      noVoices.mockRestore();
    }
    const spy = jest
      .spyOn(provider, 'promptToolsConfigured', 'get')
      .mockReturnValue(false);
    try {
      const ids = (await catalogue()).tools.map((t) => t.id);
      expect(ids).not.toContain('sound-effect');
      expect(ids).not.toContain('music');
      for (const res of [
        await createSfx(PLAIN, sfxBody()),
        await createMusic(PLAIN, musicBody()),
      ]) {
        expect(res.status).toBe(503);
        expect(reasonOf(res).code).toBe('ai_tool_unavailable');
        expect(reasonOf(res).message).toContain('No points were taken');
      }
    } finally {
      spy.mockRestore();
    }
    await nothingHeld(MUSIC + SFX);
  });

  // ---------------------------------------------------------------------------
  // Check 2: a job holds, runs, commits and returns an audio link
  // ---------------------------------------------------------------------------

  it('check 2: a Sound effect job holds, runs with the asked length, commits and returns an audio link in its own folder', async () => {
    await h.grant(PLAIN, SFX * 2);
    const res = await createSfx(
      PLAIN,
      sfxBody(SOUND, { durationSeconds: 4.5 }),
    );
    expect(res.status).toBe(202);
    const job = data<AiJobView>(res);
    expect(job).toMatchObject({
      tool: 'sound-effect',
      state: 'working',
      costPoints: SFX,
      units: 1,
      voiceId: '',
      audioUrl: null,
      outputs: [],
    });
    expect(job.characters).toBe(Array.from(SOUND).length);
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['held']);
    expect(await h.balance(PLAIN)).toBe(SFX);

    const done = (await h.finish(PLAIN, job.id)) as unknown as AiJobView;
    expect(done.state).toBe('done');
    expect(done.audioUrl).toContain(`ai/sound-effect/${PLAIN}/${job.id}.mp3`);
    expect(done.outputs).toEqual([{ kind: 'audio', url: done.audioUrl }]);
    expect(done.message).toBeNull();
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['committed']);
    expect(await h.balance(PLAIN)).toBe(SFX);
    const key = audioKeyFor(PLAIN, job.id, 'ai/sound-effect');
    // About 4.5 seconds of audio: the stand-in made frames of the asked length.
    const bytes = h.store.files.get(key)!.length;
    expect(bytes / 417).toBeGreaterThan(4.4 / 0.026122);
    expect(bytes / 417).toBeLessThan(4.6 / 0.026122);
    expect(h.standin.state.sfx).toEqual([4.5]);
    // The description is never stored: the job row holds only its length.
    const [row] = await jobsOf(PLAIN);
    expect(JSON.stringify(row)).not.toContain('tin roof');
    expect(row.audioKey).toBe(key);
  });

  it('check 2: a Sound effect job with no length lets the tool choose, and costs the same', async () => {
    await h.grant(PLAIN, SFX);
    const res = await createSfx(PLAIN, sfxBody());
    expect(res.status).toBe(202);
    expect((await h.finish(PLAIN, data<AiJobView>(res).id)).state).toBe('done');
    expect(h.standin.state.sfx).toEqual([null]);
    expect(await h.balance(PLAIN)).toBe(0);
  });

  it('check 2: a Music track job holds, runs with the asked length and switch, commits and returns an audio link in its own folder', async () => {
    await h.grant(PLAIN, MUSIC * 2);
    const res = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 20, instrumental: true }),
    );
    expect(res.status).toBe(202);
    const job = data<AiJobView>(res);
    expect(job).toMatchObject({
      tool: 'music',
      state: 'working',
      costPoints: MUSIC,
      units: 1,
      voiceId: '',
    });
    expect(await h.balance(PLAIN)).toBe(MUSIC);
    const done = (await h.finish(PLAIN, job.id)) as unknown as AiJobView;
    expect(done.state).toBe('done');
    expect(done.audioUrl).toContain(`ai/music/${PLAIN}/${job.id}.mp3`);
    expect(done.outputs).toEqual([{ kind: 'audio', url: done.audioUrl }]);
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['committed']);
    expect(await h.balance(PLAIN)).toBe(MUSIC);
    const bytes = h.store.files.get(
      audioKeyFor(PLAIN, job.id, 'ai/music'),
    )!.length;
    expect(bytes / 417).toBeGreaterThan(19.5 / 0.026122);
    expect(bytes / 417).toBeLessThan(20.5 / 0.026122);
    expect(h.standin.state.music).toEqual([
      { lengthMs: 20000, instrumental: true },
    ]);
  });

  it('check 2: a Music track job with no length or switch sends neither, and the price is the same whatever length is asked', async () => {
    await h.grant(PLAIN, MUSIC * 3);
    const a = await createMusic(PLAIN, musicBody());
    const b = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 280 }),
    );
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(data<AiJobView>(a).costPoints).toBe(MUSIC);
    expect(data<AiJobView>(b).costPoints).toBe(MUSIC);
    await h.finish(PLAIN, data<AiJobView>(a).id);
    await h.finish(PLAIN, data<AiJobView>(b).id);
    expect(h.standin.state.music).toContainEqual({
      lengthMs: null,
      instrumental: false,
    });
    expect(await h.balance(PLAIN)).toBe(MUSIC);
  });

  it('check 2: a job the provider cannot make releases everything and says no points were taken (down, refused, or not audio), for both tools', async () => {
    await h.grant(PLAIN, (SFX + MUSIC) * 3);
    for (const marker of ['[[fail]]', '[[reject]]', '[[html]]']) {
      const sfx = await createSfx(PLAIN, sfxBody(`${SOUND} ${marker}`));
      const music = await createMusic(PLAIN, musicBody(`${TRACK} ${marker}`));
      expect(sfx.status).toBe(202);
      expect(music.status).toBe(202);
      for (const r of [sfx, music]) {
        const end = (await h.finish(
          PLAIN,
          data<AiJobView>(r).id,
        )) as unknown as AiJobView;
        expect(end.state).toBe('failed');
        expect(end.audioUrl).toBeNull();
        expect(end.outputs).toEqual([]);
        expect(end.message).toContain('No points were taken');
      }
    }
    const holds = await holdsOf(PLAIN);
    expect(holds).toHaveLength(6);
    expect(holds.every((x) => x.state === 'released')).toBe(true);
    expect(await h.balance(PLAIN)).toBe((SFX + MUSIC) * 3);
    expect(h.store.files.size).toBe(0);
    const codes = (await jobsOf(PLAIN)).map((j) => j.failureCode).sort();
    expect(codes).toEqual([
      'provider_failed',
      'provider_failed',
      'provider_unavailable',
      'provider_unavailable',
      'provider_unavailable',
      'provider_unavailable',
    ]);
  });

  it('check 2: a job whose audio cannot be stored gives the points back', async () => {
    await h.grant(PLAIN, SFX);
    h.store.failPut = true;
    const res = await createSfx(PLAIN, sfxBody());
    const end = (await h.finish(
      PLAIN,
      data<AiJobView>(res).id,
    )) as unknown as AiJobView;
    expect(end.state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(SFX);
  });

  // ---------------------------------------------------------------------------
  // Check 3: a length or a description over the setting is refused, naming it
  // ---------------------------------------------------------------------------

  it('check 3: a length over the setting is refused naming the longest, with nothing held (both tools)', async () => {
    await h.grant(PLAIN, SFX + MUSIC);
    const sfx = await createSfx(PLAIN, sfxBody(SOUND, { durationSeconds: 31 }));
    expect(sfx.status).toBe(422);
    expect(reasonOf(sfx)).toMatchObject({
      code: 'ai_length_too_long',
      cap: 'length_seconds',
      capLimit: 30,
      capUnit: 'seconds',
    });
    expect(reasonOf(sfx).message).toContain('30');
    expect(reasonOf(sfx).message).toContain('No points were taken');
    const music = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 301 }),
    );
    expect(music.status).toBe(422);
    expect(reasonOf(music)).toMatchObject({
      code: 'ai_length_too_long',
      cap: 'length_seconds',
      capLimit: 300,
      capUnit: 'seconds',
    });
    await nothingHeld(SFX + MUSIC);

    // An admin lowers the longest sound: the new figure is the one named.
    await set('ai.sfx_max_seconds', 10);
    const lowered = await createSfx(
      PLAIN,
      sfxBody(SOUND, { durationSeconds: 11 }),
    );
    expect(lowered.status).toBe(422);
    expect(reasonOf(lowered)).toMatchObject({ capLimit: 10 });
    const ok = await createSfx(PLAIN, sfxBody(SOUND, { durationSeconds: 10 }));
    expect(ok.status).toBe(202);
    await h.finish(PLAIN, data<AiJobView>(ok).id);
    await set('ai.sfx_max_seconds', null);
  });

  it("check 3: a track longer than the plan's longest audio job is refused naming that cap (points.max_audio_min_per_job)", async () => {
    await h.grant(PLAIN, MUSIC);
    await set('points.max_audio_min_per_job', 2);
    const res = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 150 }),
    );
    expect(res.status).toBe(422);
    expect(reasonOf(res)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'minutes_per_job',
      capLimit: 2,
      capUnit: 'minutes',
    });
    await nothingHeld(MUSIC);
    const ok = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 120 }),
    );
    expect(ok.status).toBe(202);
    await h.finish(PLAIN, data<AiJobView>(ok).id);
    // AITOOLS-03 round 2: a cap of one minute reads "1 minute", not "1 minutes".
    await set('points.max_audio_min_per_job', 1);
    const one = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 100 }),
    );
    expect(one.status).toBe(422);
    expect(reasonOf(one).message).toContain('up to 1 minute.');
    expect(reasonOf(one).message).not.toContain('1 minutes');
    await set('points.max_audio_min_per_job', null);
  });

  it('check 3: a length below what the tool makes, a length that is not a number, and an empty description are refused with nothing held', async () => {
    await h.grant(PLAIN, SFX + MUSIC);
    const tooShort = await createSfx(
      PLAIN,
      sfxBody(SOUND, { durationSeconds: 0.2 }),
    );
    expect(tooShort.status).toBe(400);
    const notNumber = await createSfx(
      PLAIN,
      sfxBody(SOUND, { durationSeconds: 'long' }),
    );
    expect(notNumber.status).toBe(400);
    const musicShort = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 2 }),
    );
    expect(musicShort.status).toBe(400);
    const fraction = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 20.5 }),
    );
    expect(fraction.status).toBe(400);
    const blank = await createSfx(PLAIN, sfxBody('   '));
    expect(blank.status).toBe(400);
    expect(reasonOf(blank).code).toBe('ai_prompt_empty');
    const none = await createMusic(PLAIN, { quoteToken: 'x' });
    expect(none.status).toBe(400);
    const stray = await createMusic(
      PLAIN,
      musicBody(TRACK, { voiceId: 'ada' }),
    );
    expect(stray.status).toBe(400);
    await nothingHeld(SFX + MUSIC);
  });

  it('check 3: a description over the character setting is refused naming it, with nothing held; over the plan cap it is the plan cap that is named', async () => {
    await h.grant(PLAIN, SFX + MUSIC);
    await set('ai.sfx_max_prompt_chars', 50);
    const sfx = await createSfx(PLAIN, sfxBody('a'.repeat(51)));
    expect(sfx.status).toBe(422);
    expect(reasonOf(sfx)).toMatchObject({
      code: 'ai_prompt_too_long',
      cap: 'prompt_characters',
      capLimit: 50,
      capUnit: 'characters',
    });
    expect(reasonOf(sfx).message).toContain('50');
    expect(reasonOf(sfx).message).toContain('No points were taken');
    const fits = await createSfx(PLAIN, sfxBody('a'.repeat(50)));
    expect(fits.status).toBe(202);
    await h.finish(PLAIN, data<AiJobView>(fits).id);
    await set('ai.sfx_max_prompt_chars', null);
    await h.grant(PLAIN, SFX);

    const limit = plan.caps.maxCharsPerJob;
    const music = await createMusic(PLAIN, musicBody('a'.repeat(limit + 1)));
    expect(music.status).toBe(422);
    expect(reasonOf(music)).toMatchObject({
      code: 'ai_prompt_too_long',
      capLimit: limit,
    });
    // A setting above the plan's per-job cap: the hold's characters cap stops it.
    await set('ai.music_max_prompt_chars', limit + 1000);
    const viaPlan = await createMusic(PLAIN, musicBody('a'.repeat(limit + 1)));
    expect(viaPlan.status).toBe(422);
    expect(reasonOf(viaPlan)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'characters_per_job',
      capLimit: limit,
    });
    await set('ai.music_max_prompt_chars', null);
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await h.balance(PLAIN)).toBe(MUSIC + SFX);
  });

  // ---------------------------------------------------------------------------
  // Check 4: idempotency, concurrency, the late finish (V8)
  // ---------------------------------------------------------------------------

  it('check 4: the same Idempotency-Key twice runs one job and holds once (both tools)', async () => {
    await h.grant(PLAIN, (SFX + MUSIC) * 2);
    const calls = h.standin.state.calls;
    const keyA = randomUUID();
    const keyB = randomUUID();
    const a1 = await createSfx(PLAIN, sfxBody(), keyA);
    const a2 = await createSfx(PLAIN, sfxBody(), keyA);
    const b1 = await createMusic(PLAIN, musicBody(), keyB);
    const b2 = await createMusic(PLAIN, musicBody(), keyB);
    expect([a1.status, a2.status, b1.status, b2.status]).toEqual([
      202, 200, 202, 200,
    ]);
    expect(a2.headers['idempotent-replayed']).toBe('true');
    expect(data<AiJobView>(a2).id).toBe(data<AiJobView>(a1).id);
    expect(data<AiJobView>(a1).id).toBe(jobIdFor(PLAIN, keyA));
    expect(data<AiJobView>(b2).id).toBe(data<AiJobView>(b1).id);
    await h.finish(PLAIN, data<AiJobView>(a1).id);
    await h.finish(PLAIN, data<AiJobView>(b1).id);
    expect(await jobsOf(PLAIN)).toHaveLength(2);
    expect(await holdsOf(PLAIN)).toHaveLength(2);
    expect(await h.balance(PLAIN)).toBe(SFX + MUSIC);
    expect(h.standin.state.calls).toBe(calls + 2);
  });

  it('check 4: the same key with another description, length or switch is refused and changes nothing', async () => {
    await h.grant(PLAIN, (SFX + MUSIC) * 2);
    const keyA = randomUUID();
    const keyB = randomUUID();
    expect(
      (await createSfx(PLAIN, sfxBody(SOUND, { durationSeconds: 5 }), keyA))
        .status,
    ).toBe(202);
    expect(
      (await createSfx(PLAIN, sfxBody(SOUND, { durationSeconds: 6 }), keyA))
        .status,
    ).toBe(409);
    expect(
      (await createSfx(PLAIN, sfxBody('Another sound'), keyA)).status,
    ).toBe(409);
    expect(
      (await createMusic(PLAIN, musicBody(TRACK, { lengthSeconds: 30 }), keyB))
        .status,
    ).toBe(202);
    const other = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 30, instrumental: true }),
      keyB,
    );
    expect(other.status).toBe(409);
    expect(reasonOf(other).code).toBe('idempotency_key_reused');
    const none = await createMusic(PLAIN, musicBody(), null);
    expect(none.status).toBe(400);
    expect(reasonOf(none).code).toBe('idempotency_key_required');
    expect(await jobsOf(PLAIN)).toHaveLength(2);
    expect(await holdsOf(PLAIN)).toHaveLength(2);
    await h.jobs.drain();
  });

  it('check 4: a Sound effect key and a Music key of the same value are different requests', async () => {
    await h.grant(PLAIN, SFX + MUSIC);
    const key = randomUUID();
    expect((await createSfx(PLAIN, sfxBody(), key)).status).toBe(202);
    // The same person and key name one job, whatever the tool: a second tool under it is a reused key.
    const music = await createMusic(PLAIN, musicBody(), key);
    expect(music.status).toBe(409);
    expect(reasonOf(music).code).toBe('idempotency_key_reused');
    await h.jobs.drain();
  });

  it('check 4: two jobs at once with points for one run one and refuse the other, and the balance never goes below zero (both tools)', async () => {
    await h.grant(PLAIN, SFX);
    const slow = `${SOUND} [[slow:700]]`;
    const [a, b] = await Promise.all([
      createSfx(PLAIN, sfxBody(slow)),
      createSfx(PLAIN, sfxBody(slow)),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 402]);
    const ran = a.status === 202 ? a : b;
    expect(reasonOf(a.status === 402 ? a : b).code).toBe('insufficient_points');
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    expect((await h.finish(PLAIN, data<AiJobView>(ran).id)).state).toBe('done');
    expect(await h.balance(PLAIN)).toBe(0);

    await h.grant(PLAIN, MUSIC * 2);
    const all = await Promise.all(
      [1, 2, 3, 4].map(() =>
        createMusic(PLAIN, musicBody(`${TRACK} [[slow:300]]`)),
      ),
    );
    expect(all.filter((r) => r.status === 202)).toHaveLength(2);
    expect(all.filter((r) => r.status === 402)).toHaveLength(2);
    for (const r of all.filter((x) => x.status === 202))
      await h.finish(PLAIN, data<AiJobView>(r).id);
    expect(await h.balance(PLAIN)).toBe(0);
  });

  it('check 4 (V8): a job that finishes after the sweep gave its points back does not keep them, and its audio is dropped (both tools)', async () => {
    await h.grant(PLAIN, (SFX + MUSIC) * 2);
    const sfx = await createSfx(PLAIN, sfxBody(`${SOUND} [[slow:800]]`));
    const music = await createMusic(PLAIN, musicBody(`${TRACK} [[slow:800]]`));
    const ids = [data<AiJobView>(sfx).id, data<AiJobView>(music).id];
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual([
      'held',
      'held',
    ]);
    const swept = await h.spend.releaseStale(
      30,
      new Date(Date.now() + 3_600_000),
    );
    expect(swept.released).toBeGreaterThanOrEqual(2);
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual([
      'released',
      'released',
    ]);
    await h.jobs.drain();
    for (const id of ids) {
      const end = (await h.finish(PLAIN, id)) as unknown as AiJobView;
      expect(end.state).toBe('failed');
      expect(end.audioUrl).toBeNull();
    }
    expect((await holdsOf(PLAIN)).every((x) => x.state === 'released')).toBe(
      true,
    );
    expect(await h.balance(PLAIN)).toBe((SFX + MUSIC) * 2);
    expect(h.store.removed).toEqual(
      expect.arrayContaining([
        audioKeyFor(PLAIN, ids[0], 'ai/sound-effect'),
        audioKeyFor(PLAIN, ids[1], 'ai/music'),
      ]),
    );
    expect(h.store.files.size).toBe(0);
  });

  it('check 4: a sweep that comes after a job committed leaves it alone, and a job whose server died is failed by the sweep (a track)', async () => {
    await h.grant(PLAIN, MUSIC * 2);
    const res = await createMusic(PLAIN, musicBody());
    const id = data<AiJobView>(res).id;
    expect((await h.finish(PLAIN, id)).state).toBe('done');
    await h.spend.releaseStale(30, new Date(Date.now() + 3_600_000));
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['committed']);

    // The hold of a job whose run died after it answered: the sweep gives the
    // points back and a read says failed; one that died after the commit reads done.
    const key = randomUUID();
    const dead = jobIdFor(PLAIN, key);
    const held = await h.spend.hold({
      wawuUserId: PLAIN,
      action: 'music_per_track',
      units: 1,
      reference: `${dead}:1`,
    });
    await h.prisma.aiToolJob.create({
      data: {
        id: dead,
        wawuUserId: PLAIN,
        tool: 'music_per_track',
        idempotencyKey: key,
        requestHash: 'x'.repeat(64),
        voiceId: '',
        characters: 10,
        units: 1,
        costPoints: MUSIC,
        holdId: held.holdId,
      },
    });
    await h.spend.releaseStale(30, new Date(Date.now() + 3_600_000));
    const read = data<AiJobView>(
      await h
        .http()
        .get(`/ai-tools/jobs/${dead}`)
        .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`),
    );
    expect(read).toMatchObject({ state: 'failed', tool: 'music' });
    expect(await h.balance(PLAIN)).toBe(MUSIC);
  });

  it('check 4: a track whose server died after the commit reads done, with its audio under the music folder', async () => {
    await h.grant(PLAIN, MUSIC);
    const key = randomUUID();
    const id = jobIdFor(PLAIN, key);
    const held = await h.spend.hold({
      wawuUserId: PLAIN,
      action: 'music_per_track',
      units: 1,
      reference: `${id}:1`,
    });
    await h.spend.commit(held.holdId);
    await h.prisma.aiToolJob.create({
      data: {
        id,
        wawuUserId: PLAIN,
        tool: 'music_per_track',
        idempotencyKey: key,
        requestHash: 'y'.repeat(64),
        voiceId: '',
        characters: 10,
        units: 1,
        costPoints: MUSIC,
        holdId: held.holdId,
      },
    });
    const read = data<AiJobView>(
      await h
        .http()
        .get(`/ai-tools/jobs/${id}`)
        .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`),
    );
    expect(read).toMatchObject({ state: 'done', tool: 'music' });
    expect(read.audioUrl).toContain(`ai/music/${PLAIN}/${id}.mp3`);
  });

  // ---------------------------------------------------------------------------
  // Check 5: the caps and the quote
  // ---------------------------------------------------------------------------

  it("check 5: a job past the day's points is refused naming the daily cap, with nothing held", async () => {
    await h.grant(PLAIN, MUSIC * 2);
    await set('points.daily_cap', MUSIC + 10);
    const first = await createMusic(PLAIN, musicBody());
    expect(first.status).toBe(202);
    await h.finish(PLAIN, data<AiJobView>(first).id);
    const res = await createSfx(PLAIN, sfxBody());
    expect(res.status).toBe(422);
    expect(reasonOf(res)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'daily',
      capLimit: MUSIC + 10,
      capUnit: 'points',
      usedPoints: MUSIC,
      remainingPoints: 10,
    });
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    expect(await h.balance(PLAIN)).toBe(MUSIC);
    await set('points.daily_cap', null);
  });

  it("check 5: a job the person cannot pay for is refused with the points short, and a quote that is wrong, old, another person's or another tool's holds nothing", async () => {
    await h.grant(PLAIN, SFX);
    const short = await createMusic(PLAIN, musicBody());
    expect(short.status).toBe(402);
    expect(reasonOf(short).code).toBe('insufficient_points');
    await h.grant(BASIC, MUSIC);
    const wrongCost = await createSfx(PLAIN, {
      prompt: SOUND,
      quoteToken: quote('sfx', PLAIN, SFX + 1),
    });
    expect(wrongCost.status).toBe(409);
    expect(reasonOf(wrongCost)).toMatchObject({
      code: 'quote_changed',
      costPoints: SFX,
    });
    const otherTool = await createSfx(PLAIN, {
      prompt: SOUND,
      quoteToken: quote('music_per_track', PLAIN, SFX),
    });
    expect(otherTool.status).toBe(409);
    const old = await createSfx(PLAIN, {
      prompt: SOUND,
      quoteToken: quote('sfx', PLAIN, SFX, -60),
    });
    expect(old.status).toBe(409);
    const theirs = await createSfx(PLAIN, {
      prompt: SOUND,
      quoteToken: quote('sfx', BASIC, SFX),
    });
    expect(theirs.status).toBe(409);
    expect(await holdsOf(PLAIN)).toHaveLength(0);
    expect(await jobsOf(PLAIN)).toHaveLength(0);
    expect(await h.balance(PLAIN)).toBe(SFX);
  });

  // ---------------------------------------------------------------------------
  // The job list and the read know the new tools
  // ---------------------------------------------------------------------------

  it("the job list shows a sound effect and a track as the person's own, newest first, and another person cannot read them", async () => {
    await h.grant(PLAIN, SFX + MUSIC);
    const sfx = await createSfx(PLAIN, sfxBody());
    await h.finish(PLAIN, data<AiJobView>(sfx).id);
    const music = await createMusic(PLAIN, musicBody());
    await h.finish(PLAIN, data<AiJobView>(music).id);
    const list = data<{ items: AiJobView[]; nextCursor: string | null }>(
      await h
        .http()
        .get('/ai-tools/jobs')
        .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`),
    );
    expect(list.items.map((j) => j.tool)).toEqual(['music', 'sound-effect']);
    expect(
      list.items.every((j) => j.state === 'done' && j.outputs.length === 1),
    ).toBe(true);
    const theirs = await h
      .http()
      .get(`/ai-tools/jobs/${data<AiJobView>(music).id}`)
      .set('Authorization', `Bearer ${h.tokensOf[BASIC]}`);
    expect(theirs.status).toBe(404);
    const basicList = data<{ items: AiJobView[] }>(
      await h
        .http()
        .get('/ai-tools/jobs')
        .set('Authorization', `Bearer ${h.tokensOf[BASIC]}`),
    );
    expect(basicList.items).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Round 2: each refusal names what is actually wrong
  // ---------------------------------------------------------------------------

  const bodyMessage = (res: { body: unknown }): string => {
    const m = (res.body as { message?: unknown }).message;
    return typeof m === 'string' ? m : '';
  };

  it('round 2: a length that is not a number says so, and a description that is too long says that (both tools)', async () => {
    await h.grant(PLAIN, SFX + MUSIC);
    const bad = await createSfx(
      PLAIN,
      sfxBody(SOUND, { durationSeconds: 'abc' }),
    );
    expect(bad.status).toBe(400);
    expect(bodyMessage(bad)).toBe(
      'durationSeconds must be a number of seconds.',
    );
    const badTrack = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 'abc' }),
    );
    expect(badTrack.status).toBe(400);
    expect(bodyMessage(badTrack)).toBe(
      'lengthSeconds must be a whole number of seconds.',
    );
    const huge = await createSfx(
      PLAIN,
      sfxBody(SOUND, { durationSeconds: 3601 }),
    );
    expect(huge.status).toBe(400);
    expect(bodyMessage(huge)).toBe('That length is too long.');
    const tooLongText = 'a'.repeat(20_001);
    for (const res of [
      await createSfx(PLAIN, sfxBody(tooLongText)),
      await createMusic(PLAIN, musicBody(tooLongText)),
    ]) {
      expect(res.status).toBe(400);
      expect(bodyMessage(res)).toBe('That description is too long.');
    }
    const notText = await createSfx(PLAIN, sfxBody(SOUND, { prompt: 42 }));
    expect(notText.status).toBe(400);
    expect(bodyMessage(notText)).toBe('prompt must be text.');
    const empty = await createMusic(PLAIN, musicBody(''));
    expect(empty.status).toBe(400);
    expect(bodyMessage(empty)).toBe('Describe what you want to hear.');
    await nothingHeld(SFX + MUSIC);
  });

  // ---------------------------------------------------------------------------
  // Round 2: the provider's HTTP status stays on the failed job (never shown)
  // ---------------------------------------------------------------------------

  it("round 3: a provider refusal's HTTP status (a key or plan refusal reads 401 or 402) is in the log only: the failed job keeps its providerRef as it was, the rollback is not blocked, and the person still reads that no points were taken", async () => {
    await h.grant(PLAIN, (SFX + MUSIC) * 2);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      const made: { id: string; status: number }[] = [];
      for (const status of [402, 401]) {
        const sfx = await createSfx(
          PLAIN,
          sfxBody(`${SOUND} [[status:${status}]]`),
        );
        const music = await createMusic(
          PLAIN,
          musicBody(`${TRACK} [[status:${status}]]`),
        );
        made.push({ id: data<AiJobView>(sfx).id, status });
        made.push({ id: data<AiJobView>(music).id, status });
      }
      // Let every run end before reading (a read between the give-back and the mark would call it timed out).
      await h.jobs.drain();
      for (const m of made) {
        const end = (await h.finish(PLAIN, m.id)) as unknown as AiJobView;
        expect(end.state).toBe('failed');
        expect(end.message).toContain('No points were taken');
        expect(end.message).not.toContain(String(m.status));
        expect(Object.keys(end)).not.toContain('providerRef');
        expect(JSON.stringify(end)).not.toContain('http_');
      }
      const jobs = await jobsOf(PLAIN);
      // Round 3: the status is not written to the job. Nothing set providerRef
      // before these jobs failed, so it is still null on every one.
      expect(jobs).toHaveLength(4);
      expect(jobs.map((j) => j.providerRef)).toEqual([null, null, null, null]);
      expect(JSON.stringify(jobs)).not.toContain('http_');
      await expectRollbackNotBlockedBy(jobs.map((j) => j.id));
      // 402 and 401 are refusals this key or plan will make again: not retryable.
      expect(jobs.every((j) => j.failureCode === 'provider_failed')).toBe(true);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(
        lines.filter((l) => /ai job .* answered 402/.test(l)),
      ).toHaveLength(2);
      expect(
        lines.filter((l) => /ai job .* answered 401/.test(l)),
      ).toHaveLength(2);
      for (const l of lines) expect(l).not.toContain(SOUND);
    } finally {
      warn.mockRestore();
    }
    expect((await holdsOf(PLAIN)).every((x) => x.state === 'released')).toBe(
      true,
    );
    expect(await h.balance(PLAIN)).toBe((SFX + MUSIC) * 2);
  });

  it('round 3: a provider id set on a working job before it fails is still there afterwards (a failure never writes providerRef), whichever answer ends it', async () => {
    await h.grant(PLAIN, (SFX + MUSIC) * 2);
    const made: { id: string; mark: string }[] = [];
    for (const mark of ['[[status:402]]', '[[fail]]']) {
      const sfx = await createSfx(
        PLAIN,
        sfxBody(`${SOUND} [[slow:600]] ${mark}`),
      );
      const music = await createMusic(
        PLAIN,
        musicBody(`${TRACK} [[slow:600]] ${mark}`),
      );
      for (const r of [sfx, music]) {
        expect(r.status).toBe(202);
        const id = data<AiJobView>(r).id;
        // Set while the provider call is still waiting: what AITOOLS-05 keeps there.
        await h.prisma.aiToolJob.update({
          where: { id },
          data: { providerRef: `prov-${id}` },
        });
        made.push({ id, mark });
      }
    }
    await h.jobs.drain();
    for (const m of made) {
      const end = (await h.finish(PLAIN, m.id)) as unknown as AiJobView;
      expect(end.state).toBe('failed');
      const row = await h.prisma.aiToolJob.findUniqueOrThrow({
        where: { id: m.id },
      });
      expect(row.state).toBe('failed');
      expect(row.failureCode).toBe(
        m.mark === '[[fail]]' ? 'provider_unavailable' : 'provider_failed',
      );
      expect(row.providerRef).toBe(`prov-${m.id}`);
    }
    expect((await holdsOf(PLAIN)).every((x) => x.state === 'released')).toBe(
      true,
    );
  });

  it('round 2: a failure with no answer from the provider (it is down) leaves no status on the job', async () => {
    await h.grant(PLAIN, SFX);
    const res = await createSfx(PLAIN, sfxBody(`${SOUND} [[html]]`));
    await h.jobs.drain();
    await h.finish(PLAIN, data<AiJobView>(res).id);
    const [job] = await jobsOf(PLAIN);
    expect(job.failureCode).toBe('provider_unavailable');
    expect(job.providerRef).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Round 2: the Music call waits as long as its own setting says
  // ---------------------------------------------------------------------------

  it('round 2: a Music job the configured timeout is too short for fails provider_unavailable and every point goes back', async () => {
    await h.grant(PLAIN, MUSIC);
    const provider = h.get<{ musicTimeoutMs: number }>(AI_VOICE_PROVIDER);
    const was = provider.musicTimeoutMs;
    provider.musicTimeoutMs = 1000;
    try {
      const res = await createMusic(PLAIN, musicBody(`${TRACK} [[slow:2500]]`));
      expect(res.status).toBe(202);
      await h.jobs.drain();
      const end = (await h.finish(
        PLAIN,
        data<AiJobView>(res).id,
      )) as unknown as AiJobView;
      expect(end.state).toBe('failed');
      expect(end.message).toContain('No points were taken');
    } finally {
      provider.musicTimeoutMs = was;
    }
    const [job] = await jobsOf(PLAIN);
    expect(job.failureCode).toBe('provider_unavailable');
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['released']);
    expect(await h.balance(PLAIN)).toBe(MUSIC);
  });

  it('no response string names the provider, a provider id or carries an em-dash', async () => {
    await h.grant(PLAIN, SFX + MUSIC);
    const texts: string[] = [];
    const sfx = await createSfx(
      PLAIN,
      sfxBody(`${SOUND} [[fail]]`, { durationSeconds: 3 }),
    );
    texts.push(JSON.stringify(sfx.body));
    texts.push(JSON.stringify(await h.finish(PLAIN, data<AiJobView>(sfx).id)));
    const music = await createMusic(
      PLAIN,
      musicBody(TRACK, { lengthSeconds: 301 }),
    );
    texts.push(JSON.stringify(music.body));
    for (const t of texts) {
      expect(t).not.toMatch(
        /eleven|stand-in|xi-api|music_v|sound-generation|\/v1\//i,
      );
      expect(t).not.toMatch(/—/);
    }
  });
});
