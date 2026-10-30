// Contract tests for task AITOOLS-04: Captions and Clean audio, with the
// person's own audio or video going in, on the one AI job pipeline.
//
// Real HTTP against the caller's DATABASE_URL with real RS256 tokens from
// mock-wawu-id, the real controller, job service, input service, points
// service and settings, and the real HTTP voice adapter talking to the voice
// stand-in (scripts/dev/voice-standin.cjs) on this machine. The person's
// files are kept in memory (MemoryInputFiles). NOT RUN against the real
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
import type {
  AiFileQuoteView,
  AiJobView,
  AiToolsView,
} from '../ai-tools-view.type';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const CAPTIONS = plan.actions.find((a) => a.id === 'captions_per_min')!.points;
const CLEAN = plan.actions.find((a) => a.id === 'clean_audio_per_min')!.points;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools04@admin.test.wawu.dev',
  role: AdminRole.finance,
};

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (
    res.body as {
      reason: Record<string, unknown> & { code: string; message: string };
    }
  ).reason;

/** A WAV file of `seconds` (8 kHz, 8 bit, mono), then `tail` (a stand-in marker). */
function wav(seconds: number, tail = ''): Buffer {
  const rate = 8000;
  const size = Math.round(seconds * rate);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + size, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(size, 40);
  return Buffer.concat([head, Buffer.alloc(size, 128), Buffer.from(tail)]);
}

/** Silent MP3 frames (44.1 kHz, 128 kbps) of about `seconds`, then `tail`. */
function mp3(seconds: number, tail = ''): Buffer {
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb9004, 0);
  const frames = Math.round(seconds / (1152 / 44100));
  return Buffer.concat([
    ...Array.from({ length: frames }, () => frame),
    Buffer.from(tail),
  ]);
}

describe('AITOOLS-04: Captions and Clean audio (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const token = (action: string, who: string, cost: number, ttl = 300) =>
    h.tokens.issue(
      who,
      action,
      cost,
      new Date(Date.now() + (ttl - h.tokens.seconds) * 1000),
    );
  const auth = (who: string) => ({
    Authorization: `Bearer ${h.tokensOf[who]}`,
  });
  const upload = (
    who: string,
    bytes: Buffer,
    type = 'audio/wav',
    folder = 'ai/input-audio',
  ) => h.inputs.add(who, bytes, type, folder);
  const quoteOf = async (
    route: 'captions' | 'clean-audio',
    who: string,
    fileKey: string,
  ) =>
    h.http().post(`/ai-tools/${route}/quote`).set(auth(who)).send({ fileKey });
  const job = (
    route: 'captions' | 'clean-audio',
    who: string,
    fileKey: string,
    minutes: number,
    over: object = {},
    key?: string | null,
  ) => {
    const action =
      route === 'captions' ? 'captions_per_min' : 'clean_audio_per_min';
    const per = route === 'captions' ? CAPTIONS : CLEAN;
    const req = h.http().post(`/ai-tools/${route}/jobs`).set(auth(who));
    if (key !== null) req.set('Idempotency-Key', key ?? randomUUID());
    return req.send({
      fileKey,
      quoteToken: token(action, who, per * minutes),
      ...over,
    });
  };
  const holdsOf = (who: string) =>
    h.prisma.pointHold.findMany({ where: { wawuUserId: who } });
  const jobsOf = (who: string) =>
    h.prisma.aiToolJob.findMany({ where: { wawuUserId: who } });
  const nothingHeld = async (who: string, balance: number) => {
    expect(await holdsOf(who)).toHaveLength(0);
    expect(await jobsOf(who)).toHaveLength(0);
    expect(await h.balance(who)).toBe(balance);
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
    await h.jobs.drain();
    await h.clean();
    h.store.files.clear();
    h.store.removed.length = 0;
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    h.inputs.failRead = false;
    const s = h.standin.state;
    s.transcribe.length = 0;
    s.isolate.length = 0;
    s.deletedTranscripts.length = 0;
    s.deletedIsolations.length = 0;
  });

  it('check 1: GET /ai-tools lists Captions and Clean audio at their cost a minute, with what a file may be, before anyone runs them', async () => {
    const res = await h.http().get('/ai-tools').set(auth(PLAIN));
    const tools = data<AiToolsView>(res).tools;
    const captions = tools.find((t) => t.id === 'captions')!;
    const clean = tools.find((t) => t.id === 'clean-audio')!;
    expect(captions).toMatchObject({
      action: 'captions_per_min',
      unit: 'minute',
      costPointsPerUnit: CAPTIONS,
      enabled: true,
      voices: [],
      input: { kind: 'file', file: { languageCode: true } },
    });
    expect(clean).toMatchObject({
      action: 'clean_audio_per_min',
      unit: 'minute',
      costPointsPerUnit: CLEAN,
      enabled: true,
      input: { kind: 'file', file: { languageCode: false } },
    });
    expect(captions.input.file).toMatchObject({
      folders: { audio: 'ai/input-audio', video: 'ai/input-video' },
      accepts: {
        audio: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac'],
        video: ['video/mp4', 'video/quicktime', 'video/webm'],
      },
      maxBytes: 500 * 1024 * 1024,
      maxMinutes: plan.caps.maxAudioMinPerJob,
    });
    // An admin change shows at once.
    await set('ai.input_max_bytes', 10 * 1024 * 1024);
    const again = data<AiToolsView>(
      await h.http().get('/ai-tools').set(auth(PLAIN)),
    );
    expect(
      again.tools.find((t) => t.id === 'captions')!.input.file!.maxBytes,
    ).toBe(10 * 1024 * 1024);
  });

  it('check 2: a 90 second recording is priced at 2 minutes from the Hub reading the file, not from anything the phone sends', async () => {
    const key = upload(PLAIN, wav(90));
    const res = await quoteOf('captions', PLAIN, key);
    expect(res.status).toBe(200);
    const q = data<AiFileQuoteView>(res);
    expect(q).toMatchObject({
      action: 'captions_per_min',
      units: 2,
      perUnitPoints: CAPTIONS,
      costPoints: CAPTIONS * 2,
      file: { seconds: 90, minutes: 2 },
    });
    expect(typeof q.quoteToken).toBe('string');
    // An MP3 of 61 seconds is 2 minutes too; 60 exactly is 1.
    const mp3Key = upload(PLAIN, mp3(61), 'audio/mpeg');
    expect(
      data<AiFileQuoteView>(await quoteOf('clean-audio', PLAIN, mp3Key)),
    ).toMatchObject({
      action: 'clean_audio_per_min',
      file: { minutes: 2 },
      costPoints: CLEAN * 2,
    });
    expect(
      data<AiFileQuoteView>(
        await quoteOf('captions', PLAIN, upload(PLAIN, wav(60))),
      ).file.minutes,
    ).toBe(1);
    // The phone cannot send a length: the body takes a file key only.
    const forged = await h
      .http()
      .post('/ai-tools/captions/quote')
      .set(auth(PLAIN))
      .send({ fileKey: key, units: 1, minutes: 1 });
    expect(forged.status).toBe(400);
    // The quote holds nothing.
    await nothingHeld(PLAIN, 0);
  });

  it('check 3: a Captions job holds, runs, commits and returns the words and an SRT; the provider keeps no transcript and the uploaded file is deleted', async () => {
    await h.grant(PLAIN, CAPTIONS * 2);
    const key = upload(PLAIN, wav(90));
    const res = await job('captions', PLAIN, key, 2, { languageCode: 'en' });
    expect(res.status).toBe(202);
    const created = data<AiJobView>(res);
    expect(created).toMatchObject({
      tool: 'captions',
      state: 'working',
      units: 2,
      costPoints: CAPTIONS * 2,
      characters: 0,
      voiceId: '',
    });
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['held']);
    const end = (await h.finish(PLAIN, created.id)) as unknown as AiJobView;
    expect(end.state).toBe('done');
    expect(end.audioUrl).toBeNull();
    const text = end.outputs.find((o) => o.kind === 'text')!;
    const srt = end.outputs.find((o) => o.kind === 'subtitles')!;
    expect(text.text).toMatch(/^word1 word2 /);
    expect(text.text!.split(' ')).toHaveLength(180);
    expect(srt.text).toMatch(
      /^1\n00:00:00,000 --> 00:00:02,900\nword1 word2 word3 word4 word5 word6\.\n\n2\n00:00:03,000 --> /,
    );
    expect(srt.text!.split('\n\n')).toHaveLength(30);
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['committed']);
    expect(await h.balance(PLAIN)).toBe(0);
    // What the provider was asked: the model, word times, the language.
    expect(h.standin.state.transcribe).toEqual([
      expect.objectContaining({
        model: 'scribe_v2',
        languageCode: 'en',
        granularity: 'word',
      }),
    ]);
    // The provider keeps no copy of the words; the person's file is gone.
    expect(h.standin.state.deletedTranscripts).toHaveLength(1);
    expect(h.standin.openTranscripts()).toBe(0);
    expect(h.inputs.removed).toEqual([key]);
    // The job row keeps no words of its own beyond the outputs of a done job.
    const row = (await jobsOf(PLAIN))[0];
    expect(row.inputRef).toBe(key);
    expect(row.audioKey).toBeNull();
  });

  it('check 3: a Clean audio job returns an audio link under its own folder; the provider keeps no history item and the uploaded file is deleted', async () => {
    await h.grant(PLAIN, CLEAN);
    const key = upload(PLAIN, mp3(30, ''), 'audio/mpeg');
    const res = await job('clean-audio', PLAIN, key, 1);
    expect(res.status).toBe(202);
    const end = (await h.finish(
      PLAIN,
      data<AiJobView>(res).id,
    )) as unknown as AiJobView;
    expect(end.state).toBe('done');
    expect(end.audioUrl).toMatch(/\/ai\/clean-audio\/.+\.mp3$/);
    expect(end.outputs).toEqual([{ kind: 'audio', url: end.audioUrl }]);
    expect([...h.store.files.keys()]).toHaveLength(1);
    expect(await h.balance(PLAIN)).toBe(0);
    expect(h.standin.state.isolate).toHaveLength(1);
    expect(h.standin.state.deletedIsolations).toHaveLength(1);
    expect(h.standin.openIsolations()).toBe(0);
    expect(h.inputs.removed).toEqual([key]);
  });

  it('check 3: a video goes in the same way (a different folder, the same job)', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const key = h.inputs.add(PLAIN, wav(20), 'video/mp4', 'ai/input-video');
    const res = await job('captions', PLAIN, key, 1);
    expect(res.status).toBe(202);
    expect(
      ((await h.finish(PLAIN, data<AiJobView>(res).id)) as unknown as AiJobView)
        .state,
    ).toBe('done');
  });

  it('check 3: a failed or refused provider run releases every point, deletes the uploaded file and leaves nothing at the provider', async () => {
    await h.grant(PLAIN, CAPTIONS + CLEAN);
    const cases: [string, 'captions' | 'clean-audio', string][] = [
      ['[[fail]]', 'captions', 'provider_unavailable'],
      ['[[reject]]', 'captions', 'provider_failed'],
      ['[[html]]', 'captions', 'provider_unavailable'],
      ['[[status:402]]', 'clean-audio', 'provider_plan'],
      ['[[html]]', 'clean-audio', 'provider_unavailable'],
    ];
    for (const [marker, route, code] of cases) {
      const before = await h.balance(PLAIN);
      const key = upload(PLAIN, wav(30, marker));
      const res = await job(route, PLAIN, key, 1);
      expect(res.status).toBe(202);
      const end = (await h.finish(
        PLAIN,
        data<AiJobView>(res).id,
      )) as unknown as AiJobView;
      expect(end.state).toBe('failed');
      expect(end.message).toMatch(/No points were taken/);
      expect(end.outputs).toEqual([]);
      expect(await h.balance(PLAIN)).toBe(before);
      expect(h.inputs.removed).toContain(key);
      const row = (await jobsOf(PLAIN)).find((r) => r.inputRef === key)!;
      expect(row.failureCode).toBe(code);
      expect(row.providerRef).toBeNull();
    }
    expect((await holdsOf(PLAIN)).every((x) => x.state === 'released')).toBe(
      true,
    );
    expect(h.standin.openTranscripts()).toBe(0);
  });

  it('check 3: a cleaned recording in a type the Hub does not serve fails the job, releases the points and still deletes the provider history item', async () => {
    await h.grant(PLAIN, CLEAN);
    const key = upload(PLAIN, wav(30, '[[iso-type:audio/ogg]]'));
    const res = await job('clean-audio', PLAIN, key, 1);
    const end = (await h.finish(
      PLAIN,
      data<AiJobView>(res).id,
    )) as unknown as AiJobView;
    expect(end.state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(CLEAN);
    expect((await jobsOf(PLAIN))[0].failureCode).toBe('output_type');
    expect(h.store.files.size).toBe(0);
    expect(h.standin.state.deletedIsolations).toHaveLength(1);
    expect(h.inputs.removed).toEqual([key]);
  });

  it('check 3: a length the provider reports more than a minute above the priced one fails the job and releases the hold; within a minute it is kept', async () => {
    await h.grant(PLAIN, CAPTIONS * 2);
    // Priced at 2 minutes (120 s): 181 s is more than a minute above, 180 s is not.
    const over = upload(PLAIN, wav(90, '[[reported:181]]'));
    const bad = await job('captions', PLAIN, over, 2);
    const end = (await h.finish(
      PLAIN,
      data<AiJobView>(bad).id,
    )) as unknown as AiJobView;
    expect(end.state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(CAPTIONS * 2);
    expect((await jobsOf(PLAIN))[0].failureCode).toBe('length_differs');
    // The words were made, so the provider's copy is deleted all the same.
    expect(h.standin.state.deletedTranscripts).toHaveLength(1);
    const ok = upload(PLAIN, wav(90, '[[reported:180]]'));
    const good = await job('captions', PLAIN, ok, 2);
    expect(
      (
        (await h.finish(
          PLAIN,
          data<AiJobView>(good).id,
        )) as unknown as AiJobView
      ).state,
    ).toBe('done');
    expect(await h.balance(PLAIN)).toBe(0);
  });

  it("check 4: a file whose length cannot be read, a file of the wrong kind, a file over the byte cap, a length over the minute cap and another person's key are each refused with the reason and nothing held", async () => {
    await h.grant(PLAIN, CAPTIONS * 20);
    const owned = (bytes: Buffer, type = 'audio/wav') =>
      upload(PLAIN, bytes, type);

    // Not a recording: text declared as WAV (the wrong-format input of V2).
    const junk = owned(Buffer.from('this is not a recording at all'));
    for (const route of ['captions', 'clean-audio'] as const) {
      const q = await quoteOf(route, PLAIN, junk);
      expect(q.status).toBe(422);
      expect(reasonOf(q)).toMatchObject({ code: 'ai_file_unreadable' });
      expect(reasonOf(q).message).toBe(
        "We couldn't read that file. No points were taken.",
      );
      const res = await job(route, PLAIN, junk, 1);
      expect(res.status).toBe(422);
      expect(reasonOf(res).code).toBe('ai_file_unreadable');
    }
    // Empty and cut-off containers read as unreadable too.
    expect(
      reasonOf(await job('captions', PLAIN, owned(Buffer.alloc(0)), 1)).code,
    ).toBe('ai_file_unreadable');
    expect(
      reasonOf(await job('captions', PLAIN, owned(wav(60).subarray(0, 30)), 1))
        .code,
    ).toBe('ai_file_unreadable');

    // Over the byte cap (a setting).
    await set('ai.input_max_bytes', 1_048_576);
    const big = owned(wav(200));
    const tooBig = await job('captions', PLAIN, big, 4);
    expect(tooBig.status).toBe(422);
    expect(reasonOf(tooBig)).toMatchObject({
      code: 'ai_file_too_large',
      cap: 'file_bytes',
      capLimit: 1_048_576,
      capUnit: 'bytes',
    });
    expect(reasonOf(tooBig).message).toBe(
      'That file is too big. The most is 1 MB. No points were taken.',
    );
    await set('ai.input_max_bytes', null);

    // Over the longest job (a setting): points_cap_reached naming minutes_per_job.
    await set('points.max_audio_min_per_job', 1);
    const long = owned(wav(90));
    const capped = await job('clean-audio', PLAIN, long, 2);
    expect(capped.status).toBe(422);
    expect(reasonOf(capped)).toMatchObject({
      code: 'points_cap_reached',
      cap: 'minutes_per_job',
      capLimit: 1,
      capUnit: 'minutes',
    });
    const quote = data<AiFileQuoteView>(
      await quoteOf('clean-audio', PLAIN, long),
    );
    expect(quote.cap).toMatchObject({ cap: 'minutes_per_job', limit: 1 });
    expect(quote.canRun).toBe(false);
    await set('points.max_audio_min_per_job', null);

    // Another person's key, a key that never landed, a key in no input folder
    // and a key that is not there: all the same not found.
    const theirs = upload(BASIC, wav(30));
    h.inputs.files.set('ai/input-audio/' + PLAIN + '/pending.wav', {
      wawuUserId: PLAIN,
      folder: 'ai/input-audio',
      data: wav(30),
      contentType: 'audio/wav',
      landed: false,
    });
    for (const key of [
      theirs,
      'ai/input-audio/' + PLAIN + '/pending.wav',
      'ai/input-audio/' + PLAIN + '/nothing-here.wav',
    ]) {
      for (const route of ['captions', 'clean-audio'] as const) {
        const q = await quoteOf(route, PLAIN, key);
        expect(q.status).toBe(404);
        expect(reasonOf(q).code).toBe('not_found');
        const res = await job(route, PLAIN, key, 1);
        expect(res.status).toBe(404);
        expect(reasonOf(res).message).toBe("We couldn't find that file.");
      }
    }
    // Nothing was held, no job row was written, nothing reached the provider,
    // and the refused files are still there (nothing started).
    expect(await holdsOf(PLAIN)).toHaveLength(0);
    expect(await jobsOf(PLAIN)).toHaveLength(0);
    expect(await h.balance(PLAIN)).toBe(CAPTIONS * 20);
    expect(h.standin.state.transcribe).toHaveLength(0);
    expect(h.inputs.files.has(theirs)).toBe(true);
    expect(h.inputs.removed).toEqual([]);
  });

  it('check 4: a quote for a different file, and a cost the quote did not show, are 409 quote_changed with nothing held', async () => {
    await h.grant(PLAIN, CAPTIONS * 10);
    const key = upload(PLAIN, wav(90));
    const wrong = await job('captions', PLAIN, key, 1);
    expect(wrong.status).toBe(409);
    expect(reasonOf(wrong)).toMatchObject({
      code: 'quote_changed',
      costPoints: CAPTIONS * 2,
    });
    await nothingHeld(PLAIN, CAPTIONS * 10);
    // A quote for another tool's action is not this tool's quote.
    const other = await job('captions', PLAIN, key, 2, {
      quoteToken: token('clean_audio_per_min', PLAIN, CAPTIONS * 2),
    });
    expect(other.status).toBe(409);
  });

  it('check 6 (V8): the same Idempotency-Key twice runs one job and holds once; the same key with another file is 409; a replay after the file is gone still answers the job', async () => {
    await h.grant(PLAIN, CAPTIONS * 4);
    const key = upload(PLAIN, wav(30));
    const idem = randomUUID();
    const first = await job('captions', PLAIN, key, 1, {}, idem);
    expect(first.status).toBe(202);
    const second = await job('captions', PLAIN, key, 1, {}, idem);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(data<AiJobView>(second).id).toBe(data<AiJobView>(first).id);
    await h.finish(PLAIN, data<AiJobView>(first).id);
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    expect(await jobsOf(PLAIN)).toHaveLength(1);
    expect(h.standin.state.transcribe).toHaveLength(1);
    expect(h.inputs.files.has(key)).toBe(false);
    // The file was deleted when the job ended; the replay needs no file.
    const third = await job('captions', PLAIN, key, 1, {}, idem);
    expect(third.status).toBe(200);
    expect(data<AiJobView>(third).state).toBe('done');
    // Another file under the same key.
    const other = upload(PLAIN, wav(30));
    const clash = await job('captions', PLAIN, other, 1, {}, idem);
    expect(clash.status).toBe(409);
    expect(reasonOf(clash).code).toBe('idempotency_key_reused');
    // Another language under the same key.
    const lang = await job(
      'captions',
      PLAIN,
      key,
      1,
      { languageCode: 'yo' },
      idem,
    );
    expect(lang.status).toBe(409);
  });

  it('check 6 (V8): two jobs at once for one balance give 202 and 402, and the balance never goes below zero', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const a = upload(PLAIN, wav(30));
    const b = upload(PLAIN, wav(30));
    const [ra, rb] = await Promise.all([
      job('captions', PLAIN, a, 1),
      job('captions', PLAIN, b, 1),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([202, 402]);
    await h.jobs.drain();
    expect(await h.balance(PLAIN)).toBe(0);
    expect(await holdsOf(PLAIN)).toHaveLength(1);
    // The refused request's file is untouched; the started one's is deleted.
    const refused = ra.status === 402 ? a : b;
    expect(h.inputs.files.has(refused)).toBe(true);
  });

  it('check 6 (V8): a job that finishes after the stale sweep gave its points back cannot commit, keeps no words, and its file is deleted', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const key = upload(PLAIN, wav(30, '[[slow:800]]'));
    const res = await job('captions', PLAIN, key, 1);
    const id = data<AiJobView>(res).id;
    const swept = await h.spend.releaseStale(
      30,
      new Date(Date.now() + 3_600_000),
    );
    expect(swept.released).toBeGreaterThanOrEqual(1);
    await h.jobs.drain();
    const end = (await h.finish(PLAIN, id)) as unknown as AiJobView;
    expect(end.state).toBe('failed');
    expect(end.outputs).toEqual([]);
    expect(await h.balance(PLAIN)).toBe(CAPTIONS);
    expect((await holdsOf(PLAIN)).map((x) => x.state)).toEqual(['released']);
    const row = (await jobsOf(PLAIN))[0];
    expect(row.outputs).toBeNull();
    expect(row.audioKey).toBeNull();
    expect(h.inputs.removed).toContain(key);
    expect(h.standin.openTranscripts()).toBe(0);
  });

  it('check 6: a job whose file cannot be read at run time fails, releases and leaves nothing at the provider', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const key = upload(PLAIN, wav(30));
    const spy = jest.spyOn(h.inputs, 'read');
    spy.mockImplementationOnce((k, max) =>
      // The first read (the Hub measuring the file) works; the run's read fails.
      h.inputs.files.has(k) && max > 0
        ? Promise.resolve({
            audio: h.inputs.files.get(k)!.data,
            contentType: 'audio/wav',
          })
        : Promise.reject(new Error('gone')),
    );
    spy.mockImplementationOnce(() => Promise.reject(new Error('gone')));
    const res = await job('captions', PLAIN, key, 1);
    const end = (await h.finish(
      PLAIN,
      data<AiJobView>(res).id,
    )) as unknown as AiJobView;
    spy.mockRestore();
    expect(end.state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(CAPTIONS);
    expect((await jobsOf(PLAIN))[0].failureCode).toBe('file_unreadable');
    expect(h.standin.state.transcribe).toHaveLength(0);
    expect(h.inputs.removed).toEqual([key]);
  });

  it('check 7: nothing a person reads names a price, a provider or a model, or holds an em-dash', async () => {
    await h.grant(PLAIN, CAPTIONS + CLEAN);
    const strings: string[] = [];
    const tools = data<AiToolsView>(
      await h.http().get('/ai-tools').set(auth(PLAIN)),
    ).tools.filter((t) => t.input.kind === 'file');
    for (const t of tools) strings.push(t.name, t.description);
    const junk = upload(PLAIN, Buffer.from('nope'));
    const fail = await job('captions', PLAIN, junk, 1);
    strings.push(reasonOf(fail).message);
    await set('ai.input_max_bytes', 1_048_576);
    strings.push(
      reasonOf(await job('captions', PLAIN, upload(PLAIN, wav(200)), 4))
        .message,
    );
    await set('ai.input_max_bytes', null);
    strings.push(
      reasonOf(await job('captions', PLAIN, 'ai/input-audio/x/y.wav', 1))
        .message,
    );
    const failed = await job(
      'captions',
      PLAIN,
      upload(PLAIN, wav(30, '[[fail]]')),
      1,
    );
    const end = (await h.finish(
      PLAIN,
      data<AiJobView>(failed).id,
    )) as unknown as AiJobView;
    strings.push(end.message ?? '');
    expect(strings.length).toBeGreaterThan(6);
    for (const text of strings) {
      expect(text).not.toMatch(/\d[\d,]*\s*(points?|credits?)\b|₦|naira/i);
      expect(text).not.toMatch(/eleven|scribe|status|http|[–—]/i);
    }
  });
});
