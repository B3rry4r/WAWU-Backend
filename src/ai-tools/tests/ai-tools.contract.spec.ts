// Contract tests for task AITOOLS-01: the AI tools catalogue and VoiceOver.
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
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { audioKeyFor } from '../audio/ai-audio-store';
import { jobIdFor } from '../ai-job.service';
import { AI_VOICE_PROVIDER } from '../voice/ai-voice-provider';
import type { AiJobView, AiToolsView } from '../ai-tools-view.type';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
  PRO,
} from '../../../test/ai-tools/ai-tools-harness';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const voiceover = plan.actions.find((a) => a.id === 'voiceover_per_min')!;
const COST_1 = voiceover.points;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools01@admin.test.wawu.dev',
  role: AdminRole.finance,
};

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (
    res.body as {
      reason: Record<string, unknown> & { code: string; message: string };
    }
  ).reason;
const SCRIPT =
  'Welcome to the Pricing Playbook. Here is how to price your first product.';

describe('AITOOLS-01: the AI tools catalogue and VoiceOver (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const body = (
    text = SCRIPT,
    over: object = {},
    cost = COST_1,
    who = PLAIN,
  ) => ({
    text,
    voiceId: 'ada',
    quoteToken: h.quote(who, cost),
    ...over,
  });
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

  it('needs a signed-in caller on every route', async () => {
    expect((await h.http().get('/ai-tools')).status).toBe(401);
    expect(
      (
        await h
          .http()
          .post('/ai-tools/voiceover/jobs')
          .set('Idempotency-Key', randomUUID())
          .send(body())
      ).status,
    ).toBe(401);
    expect((await h.http().get(`/ai-tools/jobs/${randomUUID()}`)).status).toBe(
      401,
    );
  });

  // ---------------------------------------------------------------------------
  // Check 1: the catalogue lists VoiceOver with its cost, before anyone runs anything
  // ---------------------------------------------------------------------------

  it('check 1: GET /ai-tools lists VoiceOver with its cost for 2 minutes from the settings, its limits, its voices and the caps', async () => {
    const res = await h
      .http()
      .get('/ai-tools')
      .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const view = data<AiToolsView>(res);
    expect(view.tools).toHaveLength(1);
    const tool = view.tools[0];
    expect(tool).toMatchObject({
      id: 'voiceover',
      action: 'voiceover_per_min',
      name: 'VoiceOver',
      unit: 'minute',
      costPointsPerUnit: voiceover.points,
      enabled: true,
      input: {
        maxCharacters: plan.caps.maxCharsPerJob,
        charactersPerUnit: 900,
      },
    });
    expect(tool.costPointsPerUnit * 2).toBe(voiceover.points * 2);
    expect(tool.voices.map((v) => v.id)).toEqual(['ada', 'tunde']);
    expect(view.caps).toEqual({
      dailyPoints: plan.caps.dailyPointsPerUser,
      maxCharactersPerJob: plan.caps.maxCharsPerJob,
      maxAudioMinutesPerJob: plan.caps.maxAudioMinPerJob,
    });
    // No provider name and no provider voice id reaches a person (R-68).
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/eleven|stand-in|xi-api/i);
    expect(text).not.toMatch(/—/);

    // The listing is the same figure the quote shows for 2 minutes.
    await h.grant(PLAIN, voiceover.points * 2);
    const quote = await h.quotes.quote(PLAIN, {
      action: 'voiceover_per_min',
      units: 2,
    });
    expect(quote.costPoints).toBe(tool.costPointsPerUnit * 2);
    expect(quote.quoteToken).toEqual(expect.any(String));

    // A cost an admin changes shows at once (R-65).
    await set('points.action.voiceover_per_min', voiceover.points + 50);
    const after = data<AiToolsView>(
      await h
        .http()
        .get('/ai-tools')
        .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`),
    );
    expect(after.tools[0].costPointsPerUnit).toBe(voiceover.points + 50);
    await set('points.action.voiceover_per_min', null);
  });

  // ---------------------------------------------------------------------------
  // Check 2: a job with enough points holds, runs and commits
  // ---------------------------------------------------------------------------

  it('check 2: a job with enough points holds them, makes the audio and keeps the points', async () => {
    await h.grant(PLAIN, COST_1 * 3);
    const calls = h.standin.state.calls;
    const res = await h.create(PLAIN, body());
    expect(res.status).toBe(202);
    const started = data<AiJobView>(res);
    expect(started).toMatchObject({
      tool: 'voiceover',
      state: 'working',
      voiceId: 'ada',
      units: 1,
      costPoints: COST_1,
      audioUrl: null,
      message: null,
    });
    expect(started.characters).toBe(SCRIPT.length);
    // The points were held before the provider answered.
    expect((await holdsOf(PLAIN)).length).toBe(1);

    const done = (await h.finish(PLAIN, started.id)) as unknown as AiJobView;
    expect(done.state).toBe('done');
    expect(done.audioUrl).toContain(`/${PLAIN}/${started.id}.mp3`);
    expect(done.message).toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(h.standin.state.calls).toBe(calls + 1);
    expect(
      h.store.files.get(audioKeyFor(PLAIN, started.id))!.length,
    ).toBeGreaterThan(0);

    // Kept: the hold is committed and the balance stays down by the cost.
    const [hold] = await holdsOf(PLAIN);
    expect(hold).toMatchObject({
      purpose: 'ai_job',
      state: 'committed',
      quantity: COST_1,
      title: 'VoiceOver',
    });
    expect(await h.balance(PLAIN)).toBe(COST_1 * 2);

    // The text a person typed is not kept anywhere in the job.
    const [row] = await jobsOf(PLAIN);
    expect(JSON.stringify(row)).not.toContain('Pricing Playbook');
    expect(row.requestHash).toMatch(/^[0-9a-f]{64}$/);

    // Another person cannot read it.
    for (const other of [BASIC, PRO]) {
      const peek = await h
        .http()
        .get(`/ai-tools/jobs/${started.id}`)
        .set('Authorization', `Bearer ${h.tokensOf[other]}`);
      expect(peek.status).toBe(404);
      expect(reasonOf(peek).code).toBe('not_found');
    }
  });

  it('prices a longer script by its minutes: a script of two minutes costs two minutes of points', async () => {
    await h.grant(PLAIN, COST_1 * 4);
    const text = 'a'.repeat(901);
    const res = await h.create(PLAIN, body(text, {}, COST_1 * 2));
    expect(res.status).toBe(202);
    expect(data<AiJobView>(res)).toMatchObject({
      units: 2,
      costPoints: COST_1 * 2,
    });
    await h.finish(PLAIN, data<AiJobView>(res).id);
    expect(await h.balance(PLAIN)).toBe(COST_1 * 2);
  });

  // ---------------------------------------------------------------------------
  // Check 3: the provider fails a job: everything is released
  // ---------------------------------------------------------------------------

  it.each([
    ['is down', '[[fail]]', 'provider_unavailable'],
    ['refuses the text', '[[reject]]', 'provider_failed'],
    [
      'answers with something that is not audio',
      '[[html]]',
      'provider_unavailable',
    ],
  ])(
    'check 3: when the provider %s every held point goes back and the job says so',
    async (_what, marker, code) => {
      await h.grant(PLAIN, COST_1 * 2);
      const res = await h.create(PLAIN, body(`${SCRIPT} ${marker}`));
      expect(res.status).toBe(202);
      const failed = (await h.finish(
        PLAIN,
        data<AiJobView>(res).id,
      )) as unknown as AiJobView;
      expect(failed.state).toBe('failed');
      expect(failed.audioUrl).toBeNull();
      expect(failed.message).toContain('No points were taken');
      expect(failed.message).not.toMatch(/—/);
      const [hold] = await holdsOf(PLAIN);
      expect(hold.state).toBe('released');
      expect(await h.balance(PLAIN)).toBe(COST_1 * 2);
      const [row] = await jobsOf(PLAIN);
      expect(row.failureCode).toBe(code);
      expect(h.store.files.size).toBe(0);
    },
  );

  it('check 3: when the audio cannot be stored the points go back too', async () => {
    await h.grant(PLAIN, COST_1);
    h.store.failPut = true;
    const res = await h.create(PLAIN, body());
    const failed = (await h.finish(
      PLAIN,
      data<AiJobView>(res).id,
    )) as unknown as AiJobView;
    expect(failed.state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(COST_1);
    expect((await jobsOf(PLAIN))[0].failureCode).toBe('store_failed');
  });

  // ---------------------------------------------------------------------------
  // Check 4: two jobs at once never take points below zero
  // ---------------------------------------------------------------------------

  it('check 4: two jobs at once with points for one run one and refuse the other, and the balance never goes below zero', async () => {
    await h.grant(PLAIN, COST_1);
    const slow = `${SCRIPT} [[slow:700]]`;
    const [a, b] = await Promise.all([
      h.create(PLAIN, body(slow)),
      h.create(PLAIN, body(slow)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 402]);
    const refused = a.status === 402 ? a : b;
    const ran = a.status === 202 ? a : b;
    expect(reasonOf(refused).code).toBe('insufficient_points');
    // The refused one holds nothing and leaves no job.
    expect((await holdsOf(PLAIN)).length).toBe(1);
    expect((await jobsOf(PLAIN)).length).toBe(1);
    expect(await h.balance(PLAIN)).toBe(0);
    const done = await h.finish(PLAIN, data<AiJobView>(ran).id);
    expect(done.state).toBe('done');
    expect(await h.balance(PLAIN)).toBe(0);
    expect(h.standin.state.maxActive).toBeGreaterThanOrEqual(1);
  });

  it('check 4: five jobs at once with points for three run exactly three', async () => {
    await h.grant(PLAIN, COST_1 * 3);
    const all = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        h.create(PLAIN, body(`${SCRIPT} [[slow:300]]`)),
      ),
    );
    expect(all.filter((r) => r.status === 202)).toHaveLength(3);
    expect(all.filter((r) => r.status === 402)).toHaveLength(2);
    for (const r of all.filter((x) => x.status === 202))
      await h.finish(PLAIN, data<AiJobView>(r).id);
    expect(await h.balance(PLAIN)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Check 5: each cap refuses with the cap named and nothing held
  // ---------------------------------------------------------------------------

  const nothingHeld = async (balance: number) => {
    expect(await holdsOf(PLAIN)).toHaveLength(0);
    expect(await jobsOf(PLAIN)).toHaveLength(0);
    expect(await h.balance(PLAIN)).toBe(balance);
  };

  it('check 5: a script over the character limit is refused naming the characters cap', async () => {
    await h.grant(PLAIN, COST_1 * 20);
    const limit = plan.caps.maxCharsPerJob;
    const text = 'a'.repeat(limit + 1);
    const units = Math.ceil((limit + 1) / 900);
    const res = await h.create(PLAIN, body(text, {}, COST_1 * units));
    expect(res.status).toBe(422);
    expect(reasonOf(res)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'characters_per_job',
      capLimit: limit,
      capUnit: 'characters',
    });
    expect(reasonOf(res).message).toContain(String(limit));
    await nothingHeld(COST_1 * 20);
    // The key is free again once the cause is fixed.
    const key = randomUUID();
    expect(
      (await h.create(PLAIN, body(text, {}, COST_1 * units), key)).status,
    ).toBe(422);
    expect((await h.create(PLAIN, body(SCRIPT), key)).status).toBe(202);
  });

  it('check 5: a script over the minutes limit is refused naming the minutes cap', async () => {
    await h.grant(PLAIN, COST_1 * 20);
    await set('points.max_audio_min_per_job', 1);
    const text = 'a'.repeat(901); // two minutes
    const res = await h.create(PLAIN, body(text, {}, COST_1 * 2));
    expect(res.status).toBe(422);
    expect(reasonOf(res)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'minutes_per_job',
      capLimit: 1,
      capUnit: 'minutes',
    });
    await nothingHeld(COST_1 * 20);
    await set('points.max_audio_min_per_job', null);
  });

  it("check 5: a job past the day's points is refused naming the daily cap, with when it starts again", async () => {
    await h.grant(PLAIN, COST_1 * 20);
    await set('points.daily_cap', COST_1 + 10);
    const first = await h.create(PLAIN, body());
    expect(first.status).toBe(202);
    await h.finish(PLAIN, data<AiJobView>(first).id);
    const res = await h.create(PLAIN, body());
    expect(res.status).toBe(422);
    expect(reasonOf(res)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'daily',
      capLimit: COST_1 + 10,
      capUnit: 'points',
      usedPoints: COST_1,
      remainingPoints: 10,
    });
    expect(reasonOf(res).resetsAt).toEqual(expect.any(String));
    // Only the first job holds anything.
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    expect(await h.balance(PLAIN)).toBe(COST_1 * 19);
    await set('points.daily_cap', null);
  });

  // ---------------------------------------------------------------------------
  // Check 6: a lost answer, then a retry, runs one job
  // ---------------------------------------------------------------------------

  it('check 6: a retry with the same Idempotency-Key after a lost answer runs one job and holds once', async () => {
    await h.grant(PLAIN, COST_1 * 5);
    const key = randomUUID();
    const calls = h.standin.state.calls;
    const first = await h.create(PLAIN, body(), key);
    expect(first.status).toBe(202);
    // The answer is "lost": the app sends the same request again, with a
    // fresh quote (the token is not part of what makes it the same request).
    const retry = await h.create(PLAIN, body(), key);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(data<AiJobView>(retry).id).toBe(data<AiJobView>(first).id);
    expect(data<AiJobView>(retry).id).toBe(jobIdFor(PLAIN, key));
    await h.finish(PLAIN, data<AiJobView>(first).id);
    // Once more, after it is done: the same finished job.
    const late = await h.create(PLAIN, body(), key);
    expect(late.status).toBe(200);
    expect(data<AiJobView>(late)).toMatchObject({ state: 'done' });
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await h.balance(PLAIN)).toBe(COST_1 * 4);
    expect(h.standin.state.calls).toBe(calls + 1);
  });

  it('check 6: the same key sent at the same moment twice runs one job', async () => {
    await h.grant(PLAIN, COST_1 * 5);
    const key = randomUUID();
    const calls = h.standin.state.calls;
    const [a, b] = await Promise.all([
      h.create(PLAIN, body(), key),
      h.create(PLAIN, body(), key),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(data<AiJobView>(a).id).toBe(data<AiJobView>(b).id);
    await h.finish(PLAIN, data<AiJobView>(a).id);
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await h.balance(PLAIN)).toBe(COST_1 * 4);
    expect(h.standin.state.calls).toBe(calls + 1);
  });

  it('the same key with other words is refused and changes nothing; no key is refused', async () => {
    await h.grant(PLAIN, COST_1 * 5);
    const key = randomUUID();
    expect((await h.create(PLAIN, body(), key)).status).toBe(202);
    const other = await h.create(
      PLAIN,
      body('A different script entirely.'),
      key,
    );
    expect(other.status).toBe(409);
    expect(reasonOf(other).code).toBe('idempotency_key_reused');
    const sameWordsOtherVoice = await h.create(
      PLAIN,
      body(SCRIPT, { voiceId: 'tunde' }),
      key,
    );
    expect(sameWordsOtherVoice.status).toBe(409);
    const none = await h.create(PLAIN, body(), null);
    expect(none.status).toBe(400);
    expect(reasonOf(none).code).toBe('idempotency_key_required');
    expect((await h.create(PLAIN, body(), 'short')).status).toBe(400);
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    await h.jobs.drain();
  });

  it('a failed job stays failed under its key; a new key is a new job', async () => {
    await h.grant(PLAIN, COST_1 * 3);
    const key = randomUUID();
    const first = await h.create(PLAIN, body(`${SCRIPT} [[fail]]`), key);
    await h.finish(PLAIN, data<AiJobView>(first).id);
    const again = await h.create(PLAIN, body(`${SCRIPT} [[fail]]`), key);
    expect(again.status).toBe(200);
    expect(data<AiJobView>(again).state).toBe('failed');
    const fresh = await h.create(PLAIN, body());
    expect(fresh.status).toBe(202);
    expect(data<AiJobView>(fresh).id).not.toBe(data<AiJobView>(first).id);
    expect((await h.finish(PLAIN, data<AiJobView>(fresh).id)).state).toBe(
      'done',
    );
    expect(await h.balance(PLAIN)).toBe(COST_1 * 2);
  });

  // ---------------------------------------------------------------------------
  // The quote the person saw, the voice, the provider switched off
  // ---------------------------------------------------------------------------

  it('refuses a job whose cost is not what the quote showed, or whose quote is old or not theirs, with nothing held', async () => {
    await h.grant(PLAIN, COST_1 * 5);
    await h.grant(BASIC, COST_1 * 5);
    const wrongCost = await h.create(PLAIN, body(SCRIPT, {}, COST_1 + 1));
    expect(wrongCost.status).toBe(409);
    expect(reasonOf(wrongCost)).toMatchObject({
      code: 'quote_changed',
      costPoints: COST_1,
    });
    const old = await h.create(PLAIN, {
      ...body(),
      quoteToken: h.quote(PLAIN, COST_1, -60),
    });
    expect(old.status).toBe(409);
    const notTheirs = await h.create(PLAIN, {
      ...body(),
      quoteToken: h.quote(BASIC, COST_1),
    });
    expect(notTheirs.status).toBe(409);
    const garbage = await h.create(PLAIN, { ...body(), quoteToken: 'abc.def' });
    expect(garbage.status).toBe(409);
    const otherTool = await h.create(PLAIN, {
      ...body(),
      quoteToken: h.tokens.issue(PLAIN, 'sfx', COST_1),
    });
    expect(otherTool.status).toBe(409);
    await nothingHeld(COST_1 * 5);

    // A cost an admin changes after the quote is a changed quote.
    await set('points.action.voiceover_per_min', voiceover.points + 50);
    const changed = await h.create(PLAIN, body());
    expect(changed.status).toBe(409);
    expect(reasonOf(changed).costPoints).toBe(voiceover.points + 50);
    await set('points.action.voiceover_per_min', null);
    await nothingHeld(COST_1 * 5);
  });

  it('refuses an unknown voice, empty words and a missing field with nothing held', async () => {
    await h.grant(PLAIN, COST_1);
    const voice = await h.create(
      PLAIN,
      body(SCRIPT, { voiceId: 'stand-in-ada' }),
    );
    expect(voice.status).toBe(400);
    expect(reasonOf(voice).code).toBe('ai_voice_unknown');
    const empty = await h.create(PLAIN, body('   '));
    expect(empty.status).toBe(400);
    expect(reasonOf(empty).code).toBe('ai_text_empty');
    expect((await h.create(PLAIN, { voiceId: 'ada' })).status).toBe(400);
    expect((await h.create(PLAIN, { ...body(), extra: 1 })).status).toBe(400);
    await nothingHeld(COST_1);
  });

  it('with no voice provider set up the tool is listed off and a job is refused with nothing held', async () => {
    await h.grant(PLAIN, COST_1);
    const provider = h.get<{ configured: boolean }>(AI_VOICE_PROVIDER);
    const spy = jest
      .spyOn(provider, 'configured', 'get')
      .mockReturnValue(false);
    try {
      const list = data<AiToolsView>(
        await h
          .http()
          .get('/ai-tools')
          .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`),
      );
      expect(list.tools[0].enabled).toBe(false);
      const res = await h.create(PLAIN, body());
      expect(res.status).toBe(503);
      expect(reasonOf(res).code).toBe('ai_tool_unavailable');
      expect(reasonOf(res).message).toContain('No points were taken');
    } finally {
      spy.mockRestore();
    }
    await nothingHeld(COST_1);
  });

  // ---------------------------------------------------------------------------
  // A late finish and the stale-hold sweep cannot both win
  // ---------------------------------------------------------------------------

  it('a job that finishes after the sweep gave its points back does not keep them, and its audio is dropped', async () => {
    await h.grant(PLAIN, COST_1 * 2);
    const res = await h.create(PLAIN, body(`${SCRIPT} [[slow:800]]`));
    const id = data<AiJobView>(res).id;
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['held']);
    // Meanwhile the sweep runs long after the job should have ended. It looks
    // at every stale AI hold in the database, so it may also give back one
    // another spec left (FIX-91): the count is not this job's. What this proves
    // is read off this job's own hold: held before, given back by the sweep.
    const swept = await h.spend.releaseStale(
      30,
      new Date(Date.now() + 3_600_000),
    );
    expect(swept.released).toBeGreaterThanOrEqual(1);
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['released']);
    const read = data<AiJobView>(
      await h
        .http()
        .get(`/ai-tools/jobs/${id}`)
        .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`),
    );
    expect(read.state).toBe('failed');
    await h.jobs.drain();
    const end = (await h.finish(PLAIN, id)) as unknown as AiJobView;
    expect(end.state).toBe('failed');
    expect(end.audioUrl).toBeNull();
    expect((await holdsOf(PLAIN))[0].state).toBe('released');
    expect(await h.balance(PLAIN)).toBe(COST_1 * 2);
    expect(h.store.removed).toContain(audioKeyFor(PLAIN, id));
    expect(h.store.files.size).toBe(0);
  });

  it('a sweep that comes after the job committed leaves it alone', async () => {
    await h.grant(PLAIN, COST_1 * 2);
    const res = await h.create(PLAIN, body());
    const id = data<AiJobView>(res).id;
    expect((await h.finish(PLAIN, id)).state).toBe('done');
    // The sweep is global (FIX-91): a hold another spec left may be given back
    // here, so the count says nothing about this job. Its own hold is what
    // must be left alone.
    await h.spend.releaseStale(30, new Date(Date.now() + 3_600_000));
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['committed']);
    expect(await h.balance(PLAIN)).toBe(COST_1);
  });

  it('a job whose server died is failed by the sweep and its points come back', async () => {
    await h.grant(PLAIN, COST_1);
    // A hold with a job row that no run is working on (the server died after
    // it answered): the sweep gives the points back and a read says failed.
    const key = randomUUID();
    const id = jobIdFor(PLAIN, key);
    const held = await h.spend.hold({
      wawuUserId: PLAIN,
      action: 'voiceover_per_min',
      units: 1,
      reference: `${id}:1`,
    });
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
        costPoints: COST_1,
        holdId: held.holdId,
      },
    });
    expect(await h.balance(PLAIN)).toBe(0);
    await h.spend.releaseStale(30, new Date(Date.now() + 3_600_000));
    const read = data<AiJobView>(
      await h
        .http()
        .get(`/ai-tools/jobs/${id}`)
        .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`),
    );
    expect(read.state).toBe('failed');
    expect(read.message).toContain('No points were taken');
    expect(await h.balance(PLAIN)).toBe(COST_1);
  });

  it('GET /ai-tools/jobs/{id} answers 404 for an id nobody holds and 400 for a bad id', async () => {
    const missing = await h
      .http()
      .get(`/ai-tools/jobs/${randomUUID()}`)
      .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`);
    expect(missing.status).toBe(404);
    const bad = await h
      .http()
      .get('/ai-tools/jobs/not-an-id')
      .set('Authorization', `Bearer ${h.tokensOf[PLAIN]}`);
    expect(bad.status).toBe(400);
  });
});
