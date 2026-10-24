// Contract tests for task AITOOLS-02: the one job pipeline, the catalogue
// shape, Quick voice and the job list.
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
import { ConfigService } from '@nestjs/config';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { audioKeyFor } from '../audio/ai-audio-store';
import { jobIdFor } from '../ai-job.service';
import type { AiJobPage, AiJobView, AiToolsView } from '../ai-tools-view.type';
import { AI_TOOLS, toolForAction } from '../tools';
import { QUICK_VOICE_TOOL } from '../tools/quick-voice.tool';
import { VOICEOVER_TOOL } from '../tools/voiceover.tool';
import { AI_VOICE_PROVIDER } from '../voice/ai-voice-provider';
import {
  DEFAULT_QUICK_MODEL,
  HttpVoiceProvider,
} from '../voice/http-voice-provider';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
  STANDIN_KEY,
  VOICES,
} from '../../../test/ai-tools/ai-tools-harness';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const quick = plan.actions.find((a) => a.id === 'quick_voice_per_min')!;
const voiceover = plan.actions.find((a) => a.id === 'voiceover_per_min')!;
const QUICK_1 = quick.points;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools02@admin.test.wawu.dev',
  role: AdminRole.finance,
};

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (
    res.body as {
      reason: Record<string, unknown> & { code: string; message: string };
    }
  ).reason;
const SCRIPT = 'Hello from the quick read. This is a short note for a fan.';

describe('AITOOLS-02: the job pipeline, the catalogue, Quick voice and the job list (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const quickQuote = (who: string, cost: number, ttlSeconds = 300) =>
    h.tokens.issue(
      who,
      'quick_voice_per_min',
      cost,
      new Date(Date.now() + (ttlSeconds - h.tokens.seconds) * 1000),
    );
  const body = (
    text = SCRIPT,
    over: object = {},
    cost = QUICK_1,
    who = PLAIN,
  ) => ({
    text,
    voiceId: 'ada',
    quoteToken: quickQuote(who, cost),
    ...over,
  });
  const createQuick = (who: string, payload: object, key?: string | null) => {
    const req = h
      .http()
      .post('/ai-tools/quick-voice/jobs')
      .set('Authorization', `Bearer ${h.tokensOf[who]}`);
    if (key !== null) req.set('Idempotency-Key', key ?? randomUUID());
    return req.send(payload);
  };
  const listJobs = (who: string, query: Record<string, string> = {}) =>
    h
      .http()
      .get('/ai-tools/jobs')
      .query(query)
      .set('Authorization', `Bearer ${h.tokensOf[who]}`);
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
  });

  // ---------------------------------------------------------------------------
  // The registry and the catalogue shape
  // ---------------------------------------------------------------------------

  it('the registry lists VoiceOver first and Quick voice second, each priced by a plan action, and every tool answers for its action', () => {
    // AITOOLS-03 adds Sound effect and Music track after them.
    expect(AI_TOOLS.map((t) => t.id)).toEqual([
      'voiceover',
      'quick-voice',
      'sound-effect',
      'music',
    ]);
    for (const t of AI_TOOLS) {
      expect(plan.actions.some((a) => a.id === t.action)).toBe(true);
      expect(toolForAction(t.action)).toBe(t);
    }
    expect(toolForAction('captions_per_min')).toBeNull();
    expect(VOICEOVER_TOOL.listedWhenOff).toBe(true);
    expect(QUICK_VOICE_TOOL.listedWhenOff).toBe(false);
  });

  it('check 2: GET /ai-tools lists Quick voice with 125 points a minute before anyone runs it, with its input kind, limits and the same voices; a tool whose code is not built is not listed', async () => {
    const view = await catalogue();
    expect(view.tools.map((t) => t.id)).toEqual([
      'voiceover',
      'quick-voice',
      'sound-effect',
      'music',
    ]);
    const tool = view.tools[1];
    expect(tool).toMatchObject({
      id: 'quick-voice',
      action: 'quick_voice_per_min',
      name: 'Quick voice',
      unit: 'minute',
      costPointsPerUnit: quick.points,
      enabled: true,
      input: {
        kind: 'text',
        maxCharacters: plan.caps.maxCharsPerJob,
        charactersPerUnit: 900,
      },
    });
    expect(quick.points).toBe(125);
    expect(tool.voices.map((v) => v.id)).toEqual(['ada', 'tunde']);
    // VoiceOver's entry is as AITOOLS-01 served it, plus the input kind.
    expect(view.tools[0]).toMatchObject({
      id: 'voiceover',
      costPointsPerUnit: voiceover.points,
      input: { kind: 'text', charactersPerUnit: 900 },
    });
    // Nothing a person could not act on: no unbuilt tool (Captions and the rest).
    expect(view.tools.some((t) => /caption|dub|clean/i.test(t.id))).toBe(false);
    // No provider name, no provider id, no model name and no em-dash (R-68, R-5).
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/eleven|stand-in|xi-api|flash/i);
    expect(text).not.toMatch(/—/);

    // The quote for the action shows the same figure.
    await h.grant(PLAIN, quick.points * 2);
    const quote = await h.quotes.quote(PLAIN, {
      action: 'quick_voice_per_min',
      units: 2,
    });
    expect(quote.costPoints).toBe(tool.costPointsPerUnit * 2);

    // A cost or a minute an admin changes shows at once (R-65).
    await set('points.action.quick_voice_per_min', quick.points + 25);
    await set('ai.quick_voice_chars_per_minute', 450);
    const after = (await catalogue()).tools[1];
    expect(after.costPointsPerUnit).toBe(quick.points + 25);
    expect(after.input.charactersPerUnit).toBe(450);
    await set('points.action.quick_voice_per_min', null);
    await set('ai.quick_voice_chars_per_minute', null);
  });

  it('AITOOLS-02 M1 (R-65): the catalogue text carries no price claim, because the price is an admin setting: with Quick voice set to 240 the words still say nothing about points, halves or cheaper', async () => {
    await set('points.action.quick_voice_per_min', 240);
    try {
      const view = await catalogue();
      const quickTool = view.tools.find((t) => t.id === 'quick-voice')!;
      expect(quickTool.costPointsPerUnit).toBe(240);
      for (const t of view.tools) {
        for (const words of [t.name, t.description]) {
          expect(words).not.toMatch(
            /half|double|twice|cheap|discount|save|less|more|percent|%|\bpoints?\b|\bcost|\bprice|\d/i,
          );
        }
      }
    } finally {
      await set('points.action.quick_voice_per_min', null);
    }
  });

  it('check 2: with no voice provider set up Quick voice is not listed at all, VoiceOver stays listed off, and a Quick voice job is refused with nothing held', async () => {
    await h.grant(PLAIN, QUICK_1);
    const provider = h.get<{ configured: boolean }>(AI_VOICE_PROVIDER);
    const spy = jest
      .spyOn(provider, 'configured', 'get')
      .mockReturnValue(false);
    try {
      const view = await catalogue();
      expect(view.tools.map((t) => t.id)).toEqual(['voiceover']);
      expect(view.tools[0].enabled).toBe(false);
      const res = await createQuick(PLAIN, body());
      expect(res.status).toBe(503);
      expect(reasonOf(res).code).toBe('ai_tool_unavailable');
      expect(reasonOf(res).message).toContain('No points were taken');
    } finally {
      spy.mockRestore();
    }
    expect(await holdsOf(PLAIN)).toHaveLength(0);
    expect(await jobsOf(PLAIN)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Check 3: a Quick voice job holds, runs on the faster model, commits and returns audio
  // ---------------------------------------------------------------------------

  it('check 3: a Quick voice job holds its points, runs on the faster model, keeps the points and returns the audio as audioUrl and as an audio output', async () => {
    await h.grant(PLAIN, QUICK_1 * 3);
    const calls = h.standin.state.calls;
    const res = await createQuick(PLAIN, body());
    expect(res.status).toBe(202);
    expect(res.headers['cache-control']).toContain('no-store');
    const started = data<AiJobView>(res);
    expect(started).toMatchObject({
      tool: 'quick-voice',
      state: 'working',
      voiceId: 'ada',
      units: 1,
      costPoints: QUICK_1,
      audioUrl: null,
      outputs: [],
      message: null,
    });
    expect(started.characters).toBe(SCRIPT.length);
    expect((await holdsOf(PLAIN)).length).toBe(1);

    const done = (await h.finish(PLAIN, started.id)) as unknown as AiJobView;
    expect(done.state).toBe('done');
    expect(done.audioUrl).toContain(`/${PLAIN}/${started.id}.mp3`);
    expect(done.outputs).toEqual([{ kind: 'audio', url: done.audioUrl }]);
    expect(done.finishedAt).not.toBeNull();
    // The stand-in saw one more call, on the faster model.
    expect(h.standin.state.calls).toBe(calls + 1);
    expect(h.standin.state.lastModel).toBe(DEFAULT_QUICK_MODEL);
    expect(
      h.store.files.get(audioKeyFor(PLAIN, started.id))!.length,
    ).toBeGreaterThan(0);

    const [hold] = await holdsOf(PLAIN);
    expect(hold).toMatchObject({
      purpose: 'ai_job',
      state: 'committed',
      quantity: QUICK_1,
      title: 'Quick voice',
    });
    expect(await h.balance(PLAIN)).toBe(QUICK_1 * 2);
    const [row] = await jobsOf(PLAIN);
    expect(row.tool).toBe('quick_voice_per_min');
    expect(row.outputs).toEqual([
      { kind: 'audio', key: audioKeyFor(PLAIN, started.id) },
    ]);
    expect(row.providerRef).toBeNull();
    expect(row.inputRef).toBeNull();
    expect(JSON.stringify(row)).not.toContain('quick read');
    // No provider name, no model and no em-dash in what a person reads.
    expect(JSON.stringify(done)).not.toMatch(/eleven|flash|stand-in|—/i);

    // Another person cannot read it.
    const peek = await h
      .http()
      .get(`/ai-tools/jobs/${started.id}`)
      .set('Authorization', `Bearer ${h.tokensOf[BASIC]}`);
    expect(peek.status).toBe(404);
  });

  it('the model an admin sets in AI_VOICE_QUICK_MODEL is the one Quick voice runs on, and VoiceOver keeps its own', async () => {
    const p = new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${h.standin.port}`,
        AI_VOICE_API_KEY: STANDIN_KEY,
        AI_VOICE_VOICES: VOICES,
        AI_VOICE_MODEL: 'standard-model',
        AI_VOICE_QUICK_MODEL: 'faster-model',
      }),
    );
    await p.speakQuick({ voiceId: 'ada', text: 'quick' });
    expect(h.standin.state.lastModel).toBe('faster-model');
    await p.speak({ voiceId: 'ada', text: 'standard' });
    expect(h.standin.state.lastModel).toBe('standard-model');
    const bare = new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${h.standin.port}`,
        AI_VOICE_API_KEY: STANDIN_KEY,
        AI_VOICE_VOICES: VOICES,
      }),
    );
    await bare.speak({ voiceId: 'ada', text: 'no model' });
    expect(h.standin.state.lastModel).toBeNull();
    await expect(
      bare.speakQuick({ voiceId: 'tunde', text: 'x' }),
    ).resolves.toMatchObject({ contentType: 'audio/mpeg' });
    await expect(
      bare.speakQuick({ voiceId: 'stand-in-ada', text: 'x' }),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('check 3: prices a longer text by its own minutes setting: 901 characters at 450 a minute is three minutes', async () => {
    await h.grant(PLAIN, QUICK_1 * 5);
    await set('ai.quick_voice_chars_per_minute', 450);
    const text = 'b'.repeat(901);
    const res = await createQuick(PLAIN, body(text, {}, QUICK_1 * 3));
    expect(res.status).toBe(202);
    expect(data<AiJobView>(res)).toMatchObject({
      units: 3,
      costPoints: QUICK_1 * 3,
    });
    await h.finish(PLAIN, data<AiJobView>(res).id);
    expect(await h.balance(PLAIN)).toBe(QUICK_1 * 2);
    await set('ai.quick_voice_chars_per_minute', null);
  });

  it.each([
    ['is down', '[[fail]]', 'provider_unavailable'],
    ['refuses the text', '[[reject]]', 'provider_failed'],
    ['answers with a page, not audio', '[[html]]', 'provider_unavailable'],
  ])(
    'check 3: when the provider %s a Quick voice job releases every held point and says so',
    async (_what, marker, code) => {
      await h.grant(PLAIN, QUICK_1 * 2);
      const res = await createQuick(PLAIN, body(`${SCRIPT} ${marker}`));
      expect(res.status).toBe(202);
      const failed = (await h.finish(
        PLAIN,
        data<AiJobView>(res).id,
      )) as unknown as AiJobView;
      expect(failed.state).toBe('failed');
      expect(failed.audioUrl).toBeNull();
      expect(failed.outputs).toEqual([]);
      expect(failed.message).toContain('No points were taken');
      expect(failed.message).not.toMatch(/—/);
      const [hold] = await holdsOf(PLAIN);
      expect(hold.state).toBe('released');
      expect(await h.balance(PLAIN)).toBe(QUICK_1 * 2);
      expect((await jobsOf(PLAIN))[0].failureCode).toBe(code);
      expect(h.store.files.size).toBe(0);
    },
  );

  it('check 3: when the audio cannot be stored the points go back too', async () => {
    await h.grant(PLAIN, QUICK_1);
    h.store.failPut = true;
    const res = await createQuick(PLAIN, body());
    const failed = (await h.finish(
      PLAIN,
      data<AiJobView>(res).id,
    )) as unknown as AiJobView;
    expect(failed.state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(QUICK_1);
    expect((await jobsOf(PLAIN))[0].failureCode).toBe('store_failed');
  });

  it('check 3: the same Idempotency-Key twice runs one Quick voice job and holds once; the same key with other words or for VoiceOver is refused', async () => {
    await h.grant(PLAIN, QUICK_1 * 5);
    const key = randomUUID();
    const calls = h.standin.state.calls;
    const first = await createQuick(PLAIN, body(), key);
    expect(first.status).toBe(202);
    const retry = await createQuick(PLAIN, body(), key);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(data<AiJobView>(retry).id).toBe(jobIdFor(PLAIN, key));
    const [a, b] = await Promise.all([
      createQuick(PLAIN, body(), key),
      createQuick(PLAIN, body(), key),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await h.finish(PLAIN, data<AiJobView>(first).id);
    // The same key for the same words on the OTHER tool is another job: refused.
    const asVoiceover = await h.create(
      PLAIN,
      {
        text: SCRIPT,
        voiceId: 'ada',
        quoteToken: h.quote(PLAIN, voiceover.points),
      },
      key,
    );
    expect(asVoiceover.status).toBe(409);
    expect(reasonOf(asVoiceover).code).toBe('idempotency_key_reused');
    const other = await createQuick(PLAIN, body('Other words.'), key);
    expect(other.status).toBe(409);
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await h.balance(PLAIN)).toBe(QUICK_1 * 4);
    expect(h.standin.state.calls).toBe(calls + 1);
  });

  it('check 3 (V8): two Quick voice jobs at once with points for one run one and refuse the other; the balance never goes below zero', async () => {
    await h.grant(PLAIN, QUICK_1);
    const slow = `${SCRIPT} [[slow:600]]`;
    const [a, b] = await Promise.all([
      createQuick(PLAIN, body(slow)),
      createQuick(PLAIN, body(slow)),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 402]);
    const refused = a.status === 402 ? a : b;
    const ran = a.status === 202 ? a : b;
    expect(reasonOf(refused).code).toBe('insufficient_points');
    expect((await holdsOf(PLAIN)).length).toBe(1);
    expect((await jobsOf(PLAIN)).length).toBe(1);
    expect(await h.balance(PLAIN)).toBe(0);
    expect((await h.finish(PLAIN, data<AiJobView>(ran).id)).state).toBe('done');
    expect(await h.balance(PLAIN)).toBe(0);
  });

  it('a VoiceOver quote does not pay for a Quick voice job: the cost is checked against the action quoted', async () => {
    await h.grant(PLAIN, voiceover.points * 2);
    const res = await createQuick(PLAIN, {
      ...body(),
      quoteToken: h.quote(PLAIN, voiceover.points),
    });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toMatchObject({
      code: 'quote_changed',
      costPoints: QUICK_1,
    });
    expect(await holdsOf(PLAIN)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Check 4: over a cap the answer names the cap and nothing is held
  // ---------------------------------------------------------------------------

  const nothingHeld = async (balance: number) => {
    expect(await holdsOf(PLAIN)).toHaveLength(0);
    expect(await jobsOf(PLAIN)).toHaveLength(0);
    expect(await h.balance(PLAIN)).toBe(balance);
  };

  it('check 4: over the characters cap the answer names it and nothing is held', async () => {
    await h.grant(PLAIN, QUICK_1 * 20);
    const limit = plan.caps.maxCharsPerJob;
    const text = 'a'.repeat(limit + 1);
    const units = Math.ceil((limit + 1) / 900);
    const res = await createQuick(PLAIN, body(text, {}, QUICK_1 * units));
    expect(res.status).toBe(422);
    expect(reasonOf(res)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'characters_per_job',
      capLimit: limit,
      capUnit: 'characters',
    });
    await nothingHeld(QUICK_1 * 20);
  });

  it('check 4: over the minutes cap the answer names it and nothing is held', async () => {
    await h.grant(PLAIN, QUICK_1 * 20);
    await set('points.max_audio_min_per_job', 1);
    const res = await createQuick(
      PLAIN,
      body('a'.repeat(901), {}, QUICK_1 * 2),
    );
    expect(res.status).toBe(422);
    expect(reasonOf(res)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'minutes_per_job',
      capLimit: 1,
      capUnit: 'minutes',
    });
    await nothingHeld(QUICK_1 * 20);
    await set('points.max_audio_min_per_job', null);
  });

  it("check 4: past the day's points the answer names the daily cap; a VoiceOver job counts toward the same day", async () => {
    await h.grant(PLAIN, voiceover.points * 20);
    await set('points.daily_cap', voiceover.points + QUICK_1 - 1);
    const first = await h.create(PLAIN, {
      text: SCRIPT,
      voiceId: 'ada',
      quoteToken: h.quote(PLAIN, voiceover.points),
    });
    expect(first.status).toBe(202);
    await h.finish(PLAIN, data<AiJobView>(first).id);
    const res = await createQuick(PLAIN, body());
    expect(res.status).toBe(422);
    expect(reasonOf(res)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'daily',
      capUnit: 'points',
      usedPoints: voiceover.points,
    });
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    await set('points.daily_cap', null);
  });

  // ---------------------------------------------------------------------------
  // Check 5: the job list
  // ---------------------------------------------------------------------------

  it("check 5: GET /ai-tools/jobs lists only the caller's jobs of every tool, newest first, in cursor pages, each with its outputs", async () => {
    await h.grant(PLAIN, voiceover.points * 10);
    await h.grant(BASIC, QUICK_1 * 2);
    // Five jobs for PLAIN (two VoiceOver, three Quick voice, one of them failed) and one for BASIC.
    const ids: string[] = [];
    const push = async (res: Promise<{ status: number; body: unknown }>) => {
      const r = await res;
      expect(r.status).toBe(202);
      ids.push(data<AiJobView>(r).id);
      await h.finish(PLAIN, ids[ids.length - 1]);
    };
    await push(
      h.create(PLAIN, {
        text: SCRIPT,
        voiceId: 'ada',
        quoteToken: h.quote(PLAIN, voiceover.points),
      }),
    );
    await push(createQuick(PLAIN, body()));
    await push(createQuick(PLAIN, body(`${SCRIPT} [[fail]]`)));
    await push(
      h.create(PLAIN, {
        text: SCRIPT,
        voiceId: 'tunde',
        quoteToken: h.quote(PLAIN, voiceover.points),
      }),
    );
    await push(createQuick(PLAIN, body()));
    const theirs = await createQuick(BASIC, body(SCRIPT, {}, QUICK_1, BASIC));
    expect(theirs.status).toBe(202);
    await h.finish(BASIC, data<AiJobView>(theirs).id);

    const all = await listJobs(PLAIN);
    expect(all.status).toBe(200);
    expect(all.headers['cache-control']).toContain('no-store');
    const page = data<AiJobPage>(all);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((j) => j.id)).toEqual([...ids].reverse());
    expect(page.items.map((j) => j.tool)).toEqual([
      'quick-voice',
      'voiceover',
      'quick-voice',
      'quick-voice',
      'voiceover',
    ]);
    expect(page.items.map((j) => j.state)).toEqual([
      'done',
      'done',
      'failed',
      'done',
      'done',
    ]);
    for (const j of page.items) {
      expect(j.costPoints).toBeGreaterThan(0);
      expect(j.createdAt).toEqual(expect.any(String));
      if (j.state === 'done') {
        expect(j.outputs).toEqual([{ kind: 'audio', url: j.audioUrl }]);
        expect(j.audioUrl).toContain(`/${PLAIN}/${j.id}.mp3`);
      } else {
        expect(j.outputs).toEqual([]);
        expect(j.message).toContain('No points were taken');
      }
    }
    expect(JSON.stringify(page)).not.toMatch(/eleven|stand-in|flash|—/i);
    expect(page.items.some((j) => j.id === data<AiJobView>(theirs).id)).toBe(
      false,
    );

    // Pages of two: three pages, no row twice, none missing, the last page's cursor null.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await listJobs(
        PLAIN,
        cursor ? { limit: '2', cursor } : { limit: '2' },
      );
      expect(res.status).toBe(200);
      const p = data<AiJobPage>(res);
      expect(p.items.length).toBeLessThanOrEqual(2);
      seen.push(...p.items.map((j) => j.id));
      cursor = p.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());

    // The other person's list holds only their own job, and PLAIN's job id answers not found for them.
    const basic = data<AiJobPage>(await listJobs(BASIC));
    expect(basic.items.map((j) => j.id)).toEqual([data<AiJobView>(theirs).id]);
    const peek = await h
      .http()
      .get(`/ai-tools/jobs/${ids[0]}`)
      .set('Authorization', `Bearer ${h.tokensOf[BASIC]}`);
    expect(peek.status).toBe(404);
    expect(reasonOf(peek).code).toBe('not_found');
  });

  it('check 5: an empty list, a bad cursor, a bad limit and no token', async () => {
    const empty = data<AiJobPage>(await listJobs(PLAIN));
    expect(empty).toEqual({ items: [], nextCursor: null });
    for (const cursor of [
      'abc',
      'j1.!!!',
      'c2.AAAA',
      `j1.${Buffer.from('x.y').toString('base64url')}`,
    ])
      expect((await listJobs(PLAIN, { cursor })).status).toBe(400);
    expect((await listJobs(PLAIN, { limit: '0' })).status).toBe(400);
    expect((await listJobs(PLAIN, { limit: '101' })).status).toBe(400);
    expect((await h.http().get('/ai-tools/jobs')).status).toBe(401);
    expect(
      (
        await h
          .http()
          .post('/ai-tools/quick-voice/jobs')
          .set('Idempotency-Key', randomUUID())
          .send(body())
      ).status,
    ).toBe(401);
  });

  it('check 5: a working job on the list follows its hold like a read does (the sweep gave the points back: failed)', async () => {
    await h.grant(PLAIN, QUICK_1 * 2);
    const res = await createQuick(PLAIN, body(`${SCRIPT} [[slow:800]]`));
    const id = data<AiJobView>(res).id;
    await h.spend.releaseStale(30, new Date(Date.now() + 3_600_000));
    const page = data<AiJobPage>(await listJobs(PLAIN));
    expect(page.items.map((j) => [j.id, j.state])).toEqual([[id, 'failed']]);
    await h.jobs.drain();
    expect((await h.finish(PLAIN, id)).state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(QUICK_1 * 2);
    expect(h.store.files.size).toBe(0);
  });

  it('a job written before the outputs column (audioKey only) still answers its audio as an output', async () => {
    const key = randomUUID();
    const id = jobIdFor(PLAIN, key);
    await h.prisma.aiToolJob.create({
      data: {
        id,
        wawuUserId: PLAIN,
        tool: 'voiceover_per_min',
        idempotencyKey: key,
        requestHash: 'x'.repeat(64),
        voiceId: 'ada',
        characters: 10,
        units: 1,
        costPoints: voiceover.points,
        state: 'done',
        audioKey: audioKeyFor(PLAIN, id),
        finishedAt: new Date(),
      },
    });
    const read = data<AiJobView>(
      await h
        .http()
        .get(`/ai-tools/jobs/${id}`)
        .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`),
    );
    expect(read.tool).toBe('voiceover');
    expect(read.audioUrl).toContain(`/${PLAIN}/${id}.mp3`);
    expect(read.outputs).toEqual([{ kind: 'audio', url: read.audioUrl }]);
  });
});
