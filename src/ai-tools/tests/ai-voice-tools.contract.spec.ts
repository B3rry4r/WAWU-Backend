// Contract tests for AITOOLS-11 (R-109): Voice changer, Dialogue and a saved clone of your own voice. Real HTTP against
// the caller's DATABASE_URL, the real job, input, clone and points services, and the real HTTP voice adapter against the
// voice stand-in on this machine (scripts/dev/voice-standin.cjs). NOT RUN against the real provider (the owner's credits
// are not bought yet): each tool's one proof call is written in tasks/AITOOLS-11.md. No payment provider and no Fintava
// double is started.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { AiToolsPurgeService } from '../ai-tools-purge.service';
import type {
  AiJobView,
  AiPieceView,
  AiToolsView,
  SavedVoiceRemovedView,
  SavedVoiceView,
} from '../ai-tools-view.type';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';
import { mp4File, wavFile } from '../../../test/ai-tools/media-fixtures';
import { FILE_KINDS } from '../../account-purge/purge-files';
import { GENERATED_KEY_FOLDERS } from '../../storage/storage.service';
import { AI_AUDIO_FOLDERS } from '../audio/ai-audio-store';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const cost = (id: string) => plan.actions.find((a) => a.id === id)!.points;
const CHANGER = cost('voice_changer_per_min');
const DIALOGUE = cost('dialogue_per_min');
const CLONE = cost('voice_clone_once');
const QUICK = cost('quick_voice_per_min');
const VOICEOVER = cost('voiceover_per_min');
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools11@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const LONG_DASH = /[–—]/;
const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason: { code: string; message: string } }).reason;

/** Twelve voices for the Hub's list, all read by the stand-in's own two. */
const MANY_VOICES = JSON.stringify(
  Array.from({ length: 12 }, (_, i) => ({
    id: `v${i}`,
    name: `Voice ${i}`,
    description: 'a voice',
    providerVoiceId: i % 2 === 0 ? 'stand-in-ada' : 'stand-in-tunde',
  })).concat([
    {
      id: 'ada',
      name: 'Ada',
      description: 'Warm',
      providerVoiceId: 'stand-in-ada',
    },
  ]),
);

describe('AITOOLS-11: Voice changer, Dialogue and a saved clone of your own voice (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | string[] | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const switchOn = async () => {
    for (const id of ['voice-changer', 'dialogue', 'my-voice'])
      await set(`ai.listed.${id}`, 1);
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
  const voiceFile = (who: string, seconds: number, tail = '') =>
    h.inputs.add(who, wavFile(seconds, tail), 'audio/wav', 'ai/input-audio');
  const change = (
    who: string,
    fileKey: string,
    voiceId = 'ada',
    minutes = 1,
    key?: string,
  ) =>
    post(
      who,
      'voice-changer/jobs',
      'voice_changer_per_min',
      CHANGER * minutes,
      { fileKey, voiceId },
      key,
    );
  const scene = (
    who: string,
    lines: { text: string; voiceId: string }[],
    units = 1,
    key?: string,
  ) =>
    post(
      who,
      'dialogue/jobs',
      'dialogue_per_min',
      DIALOGUE * units,
      { lines },
      key,
    );
  const myVoice = async (who: string) =>
    data<SavedVoiceView>(
      await h.http().get('/ai-tools/my-voice').set(auth(who)),
    );
  const clone = async (
    who: string,
    seconds = 12,
    tail = '',
    over: Record<string, unknown> = {},
    key?: string,
  ) => {
    const state = await myVoice(who);
    return post(
      who,
      'my-voice',
      'voice_clone_once',
      CLONE,
      {
        fileKey: voiceFile(who, seconds, tail),
        name: 'My voice',
        consentLine: state.consent.line,
        ...over,
      },
      key,
    );
  };
  const run = async (res: { status: number; body: unknown }) => {
    expect(res.status).toBe(202);
    await h.jobs.drain();
    return data<AiJobView>(res).id;
  };
  const rows = (who: string) =>
    h.prisma.aiClonedVoice.findMany({ where: { wawuUserId: who } });
  const catalogue = async (who: string) =>
    data<AiToolsView>(await h.http().get('/ai-tools').set(auth(who)));
  const voicesOf = (list: AiToolsView, tool: string) =>
    list.tools.find((t) => t.id === tool)?.voices.map((v) => v.id) ?? [];

  beforeAll(async () => {
    h = await bootAiTools({ media: true, voices: MANY_VOICES });
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
    // A voice the last test left at the stand-in is removed first, so every test starts with none.
    h.standin.releaseStubborn();
    for (const who of [PLAIN, BASIC]) await h.clones.remove(who);
    await h.clean();
    const s = standin();
    for (const list of [
      s.voiceChanges,
      s.dialogues,
      s.cloneNames,
      s.clones,
      s.voices,
    ] as unknown[][])
      list.length = 0;
    h.standin.releaseStubborn();
    h.store.files.clear();
    h.store.removed.length = 0;
    h.media.copies.clear();
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    for (const key of [...touched]) await set(key, null);
    touched.clear();
    await switchOn();
  });

  describe('the listing switches and the catalogue', () => {
    it('lists none of the three while its switch is off, answers unavailable with nothing held, and lists each whole when on', async () => {
      for (const id of ['voice-changer', 'dialogue', 'my-voice'])
        await set(`ai.listed.${id}`, null);
      await h.grant(PLAIN, 5000);
      const off = await catalogue(PLAIN);
      for (const id of ['voice-changer', 'dialogue', 'my-voice'])
        expect(off.tools.map((t) => t.id)).not.toContain(id);
      const file = voiceFile(PLAIN, 20);
      for (const res of [
        await change(PLAIN, file),
        await scene(PLAIN, [{ text: 'Hi', voiceId: 'ada' }]),
        await clone(PLAIN),
      ]) {
        expect(res.status).toBe(503);
        expect(reasonOf(res).code).toBe('ai_tool_unavailable');
      }
      expect(
        (
          await h
            .http()
            .post('/ai-tools/voice-changer/quote')
            .set(auth(PLAIN))
            .send({ fileKey: file })
        ).status,
      ).toBe(503);
      expect((await myVoice(PLAIN)).available).toBe(false);
      expect(await h.balance(PLAIN)).toBe(5000);
      expect(standin().voiceChanges).toHaveLength(0);

      await switchOn();
      const on = await catalogue(PLAIN);
      const byId = new Map(on.tools.map((t) => [t.id, t]));
      expect(byId.get('voice-changer')).toMatchObject({
        action: 'voice_changer_per_min',
        unit: 'minute',
        costPointsPerUnit: CHANGER,
        enabled: true,
        input: { kind: 'file', file: { only: 'audio', voice: true } },
      });
      expect(byId.get('dialogue')).toMatchObject({
        action: 'dialogue_per_min',
        unit: 'minute',
        costPointsPerUnit: DIALOGUE,
        input: {
          kind: 'dialogue',
          maxCharacters: 2000,
          charactersPerUnit: 900,
          dialogue: { maxVoices: 10 },
        },
      });
      expect(byId.get('my-voice')).toMatchObject({
        action: 'voice_clone_once',
        unit: 'use',
        costPointsPerUnit: CLONE,
        input: { kind: 'file', file: { only: 'audio', clone: true } },
      });
      for (const t of on.tools) {
        expect(typeof t.id).toBe('string');
        expect(t.name.trim()).not.toBe('');
        expect(Number.isInteger(t.costPointsPerUnit)).toBe(true);
        expect(typeof t.enabled).toBe('boolean');
        expect(JSON.stringify(t)).not.toMatch(LONG_DASH);
      }
      expect(JSON.stringify(on)).not.toMatch(/eleven|sts_v2|eleven_v3/i);
    });

    it('keeps every new folder in the Hub-written list and gives it a purge decision', () => {
      for (const folder of [
        'ai/voice-changer',
        'ai/dialogue',
        'ai/video-music',
        'ai/stems',
      ]) {
        expect([...GENERATED_KEY_FOLDERS]).toContain(folder);
        expect([...AI_AUDIO_FOLDERS]).toContain(folder);
        expect(FILE_KINDS[folder]?.decision).toBe('DELETE');
      }
    });
  });

  describe('Voice changer', () => {
    it('reads the length itself, holds, sends the recording with the chosen voice, stores the mp3, commits, deletes the input and lets the result become a piece', async () => {
      await h.grant(PLAIN, 5000);
      const fileKey = voiceFile(PLAIN, 20, 'a recording');
      const quote = data<{
        file: { seconds: number; minutes: number };
        costPoints: number;
      }>(
        await h
          .http()
          .post('/ai-tools/voice-changer/quote')
          .set(auth(PLAIN))
          .send({ fileKey }),
      );
      expect(quote.file).toEqual({ seconds: 20, minutes: 1 });
      expect(quote.costPoints).toBe(CHANGER);
      const res = await change(PLAIN, fileKey, 'v1');
      const id = await run(res);
      const job = await readJob(PLAIN, id);
      expect(job.state).toBe('done');
      expect(job.tool).toBe('voice-changer');
      expect(job.voiceId).toBe('v1');
      expect(job.units).toBe(1);
      expect(job.costPoints).toBe(CHANGER);
      expect(await h.balance(PLAIN)).toBe(5000 - CHANGER);
      expect(standin().voiceChanges).toEqual([
        expect.objectContaining({
          voice: 'stand-in-tunde',
          model: 'eleven_english_sts_v2',
          removeNoise: 'false',
          fileType: 'audio/wav',
        }),
      ]);
      expect(job.outputs).toHaveLength(1);
      const out = job.outputs[0];
      expect(out).toMatchObject({
        kind: 'audio',
        contentType: 'audio/mpeg',
        name: 'Voice changer',
        pieceFormat: 'audio',
      });
      expect(out.downloadUrl).toMatch(
        /studio-voice-changer-\d+-[a-z]+-\d{4}\.mp3$/,
      );
      const keys = [...h.store.files.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(
        new RegExp(`^ai/voice-changer/${PLAIN}/${id}\\.mp3$`),
      );
      expect(h.inputs.removed).toContain(fileKey);
      // The result into Create.
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
      expect(view.suggestedTitle).toMatch(/^Voice changer, \d+ /);
      expect(view.suggestedTitle).not.toMatch(LONG_DASH);
    });

    it('prices a longer recording by its minutes and refuses a video, an unknown voice, a stale quote and a recording over the plan, each with nothing held', async () => {
      await h.grant(PLAIN, 5000);
      const two = voiceFile(PLAIN, 100);
      const ok = await change(PLAIN, two, 'ada', 2);
      const id = await run(ok);
      expect((await readJob(PLAIN, id)).units).toBe(2);
      expect(await h.balance(PLAIN)).toBe(5000 - 2 * CHANGER);
      const before = await h.balance(PLAIN);
      const video = h.inputs.add(
        PLAIN,
        mp4File({ milliseconds: 20_000 }),
        'video/mp4',
        'ai/input-video',
      );
      const asVideo = await change(PLAIN, video);
      expect(asVideo.status).toBe(422);
      expect(reasonOf(asVideo).code).toBe('ai_file_unreadable');
      expect(reasonOf(asVideo).message).toMatch(/audio recording/);
      expect(reasonOf(asVideo).message).toMatch(/No points were taken/);
      const unknown = await change(PLAIN, voiceFile(PLAIN, 20), 'nobody');
      expect(unknown.status).toBe(400);
      expect(reasonOf(unknown).code).toBe('ai_voice_unknown');
      const own = await change(PLAIN, voiceFile(PLAIN, 20), 'own');
      expect(own.status).toBe(400);
      expect(reasonOf(own).code).toBe('ai_voice_unknown');
      const stale = await change(PLAIN, voiceFile(PLAIN, 20), 'ada', 3);
      expect(stale.status).toBe(409);
      expect(reasonOf(stale).code).toBe('quote_changed');
      const long = await change(PLAIN, voiceFile(PLAIN, 11 * 60), 'ada', 11);
      expect(long.status).toBe(422);
      expect(reasonOf(long).code).toBe('points_cap_reached');
      const other = await change(BASIC, voiceFile(PLAIN, 20), 'ada', 1);
      expect(other.status).toBe(404);
      expect(await h.balance(PLAIN)).toBe(before);
      expect(standin().voiceChanges).toHaveLength(1);
    });

    it('gives every point back and deletes the recording when the provider fails, refuses, moderates or answers a page', async () => {
      await h.grant(PLAIN, 5000);
      for (const marker of [
        '[[fail]]',
        '[[reject]]',
        '[[moderated]]',
        '[[html]]',
      ]) {
        const fileKey = voiceFile(PLAIN, 20, marker);
        const id = await run(await change(PLAIN, fileKey));
        const job = await readJob(PLAIN, id);
        expect(job.state).toBe('failed');
        expect(job.message).toMatch(/No points were taken/);
        expect(job.message).not.toMatch(LONG_DASH);
        expect(job.outputs).toEqual([]);
        expect(await h.balance(PLAIN)).toBe(5000);
        expect(h.inputs.removed).toContain(fileKey);
      }
      expect(h.store.files.size).toBe(0);
    });

    it('runs one job for one Idempotency-Key and never takes points below zero for two at once', async () => {
      await h.grant(PLAIN, CHANGER + 10);
      const fileKey = voiceFile(PLAIN, 20);
      const key = randomUUID();
      const first = await change(PLAIN, fileKey, 'ada', 1, key);
      const second = await change(PLAIN, fileKey, 'ada', 1, key);
      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
      expect(data<AiJobView>(second).id).toBe(data<AiJobView>(first).id);
      await h.jobs.drain();
      expect(standin().voiceChanges).toHaveLength(1);
      expect(await h.balance(PLAIN)).toBe(10);
      // Two at once with room for one.
      await h.clean();
      await h.grant(PLAIN, CHANGER + 10);
      const [a, b] = await Promise.all([
        change(PLAIN, voiceFile(PLAIN, 20)),
        change(PLAIN, voiceFile(PLAIN, 20)),
      ]);
      expect([a.status, b.status].sort()).toEqual([202, 402]);
      await h.jobs.drain();
      expect(await h.balance(PLAIN)).toBe(10);
    });
  });

  describe('Dialogue', () => {
    it('makes a scene of 3 lines with 2 voices, priced on its characters, and stores one mp3', async () => {
      await h.grant(PLAIN, 5000);
      const lines = [
        { text: 'Hello, how are you?', voiceId: 'ada' },
        { text: 'Fine, and you?', voiceId: 'v1' },
        { text: 'Very well, thank you.', voiceId: 'ada' },
      ];
      const id = await run(await scene(PLAIN, lines));
      const job = await readJob(PLAIN, id);
      expect(job.state).toBe('done');
      expect(job.tool).toBe('dialogue');
      expect(job.units).toBe(1);
      expect(job.characters).toBe(lines.reduce((n, l) => n + l.text.length, 0));
      expect(job.costPoints).toBe(DIALOGUE);
      expect(job.outputs[0]).toMatchObject({
        kind: 'audio',
        name: 'Dialogue',
        pieceFormat: 'audio',
      });
      expect(standin().dialogues).toEqual([
        {
          model: 'eleven_v3',
          lines: 3,
          voices: ['stand-in-ada', 'stand-in-tunde'],
          chars: job.characters,
        },
      ]);
      expect([...h.store.files.keys()][0]).toMatch(
        new RegExp(`^ai/dialogue/${PLAIN}/${id}\\.mp3$`),
      );
      expect(await h.balance(PLAIN)).toBe(5000 - DIALOGUE);
    });

    it('prices 1,800 characters as two minutes', async () => {
      await h.grant(PLAIN, 5000);
      const text = 'a'.repeat(1000);
      const id = await run(
        await scene(
          PLAIN,
          [
            { text, voiceId: 'ada' },
            { text: 'b'.repeat(800), voiceId: 'v1' },
          ],
          2,
        ),
      );
      const job = await readJob(PLAIN, id);
      expect(job.units).toBe(2);
      expect(job.costPoints).toBe(2 * DIALOGUE);
    });

    it('refuses 11 different voices, 2,001 characters, an empty line, an empty scene and a voice not on the list, each with the reason and nothing held', async () => {
      await h.grant(PLAIN, 5000);
      const eleven = Array.from({ length: 11 }, (_, i) => ({
        text: 'Hi.',
        voiceId: `v${i}`,
      }));
      const tooMany = await scene(PLAIN, eleven);
      expect(tooMany.status).toBe(422);
      expect(reasonOf(tooMany)).toMatchObject({
        code: 'ai_voices_too_many',
        cap: 'dialogue_voices',
        capLimit: 10,
      });
      const ten = Array.from({ length: 10 }, (_, i) => ({
        text: 'Hi.',
        voiceId: `v${i}`,
      }));
      await run(await scene(PLAIN, ten));
      expect(standin().dialogues.at(-1)?.voices.length).toBe(2);
      await h.clean();
      await h.grant(PLAIN, 5000);
      const long = await scene(
        PLAIN,
        [{ text: 'a'.repeat(2001), voiceId: 'ada' }],
        3,
      );
      expect(long.status).toBe(422);
      expect(reasonOf(long)).toMatchObject({
        code: 'ai_prompt_too_long',
        cap: 'dialogue_characters',
        capLimit: 2000,
      });
      const exactly = await scene(
        PLAIN,
        [{ text: 'a'.repeat(2000), voiceId: 'ada' }],
        3,
      );
      expect(exactly.status).toBe(202);
      await h.jobs.drain();
      await h.clean();
      await h.grant(PLAIN, 5000);
      const empty = await scene(PLAIN, [
        { text: 'Hi', voiceId: 'ada' },
        { text: '   ', voiceId: 'v1' },
      ]);
      expect(empty.status).toBe(400);
      expect(reasonOf(empty).code).toBe('ai_text_empty');
      const none = await scene(PLAIN, []);
      expect(none.status).toBe(400);
      const stranger = await scene(PLAIN, [{ text: 'Hi', voiceId: 'nobody' }]);
      expect(stranger.status).toBe(400);
      expect(reasonOf(stranger).code).toBe('ai_voice_unknown');
      const own = await scene(PLAIN, [{ text: 'Hi', voiceId: 'own' }]);
      expect(own.status).toBe(400);
      expect(reasonOf(own).code).toBe('ai_voice_unknown');
      expect(await h.balance(PLAIN)).toBe(5000);
      // Only the two scenes that were allowed reached the provider.
      expect(standin().dialogues).toHaveLength(2);
    });

    it('gives every point back when the provider fails or refuses a line', async () => {
      await h.grant(PLAIN, 5000);
      for (const marker of ['[[fail]]', '[[reject]]', '[[moderated]]']) {
        const id = await run(
          await scene(PLAIN, [{ text: `Hello ${marker}`, voiceId: 'ada' }]),
        );
        const job = await readJob(PLAIN, id);
        expect(job.state).toBe('failed');
        expect(await h.balance(PLAIN)).toBe(5000);
      }
    });
  });

  describe('Clone your own voice', () => {
    it("states the consent line with the person's own name, no clone yet, and what the recording must be", async () => {
      const view = await myVoice(PLAIN);
      expect(view).toMatchObject({
        available: true,
        state: 'none',
        name: null,
        sample: {
          folder: 'ai/input-audio',
          minSeconds: 10,
          maxSeconds: 180,
        },
      });
      expect(view.consent.line).toMatch(
        /^I am .+\. I agree that Who Made This\? may keep an AI version of my voice/,
      );
      expect(view.consent.line).not.toMatch(LONG_DASH);
      expect(view.consent.line).not.toMatch(/eleven/i);
    });

    it('refuses other words, a recording too short or too long, a video and a missing name, each with nothing held', async () => {
      await h.grant(PLAIN, 5000);
      const wrong = await clone(PLAIN, 12, '', { consentLine: 'I agree.' });
      expect(wrong.status).toBe(409);
      expect(reasonOf(wrong).code).toBe('own_voice_consent_line_changed');
      const short = await clone(PLAIN, 3);
      expect(short.status).toBe(422);
      expect(reasonOf(short).code).toBe('ai_length_too_short');
      const long = await clone(PLAIN, 200);
      expect(long.status).toBe(422);
      expect(reasonOf(long).code).toBe('ai_length_too_long');
      const video = await clone(PLAIN, 12, '', {
        fileKey: h.inputs.add(
          PLAIN,
          mp4File({ milliseconds: 20_000 }),
          'video/mp4',
          'ai/input-video',
        ),
      });
      expect(video.status).toBe(422);
      expect(reasonOf(video).code).toBe('ai_file_unreadable');
      const blank = await clone(PLAIN, 12, '', { name: '   ' });
      expect(blank.status).toBe(400);
      expect(await h.balance(PLAIN)).toBe(5000);
      expect(await rows(PLAIN)).toHaveLength(0);
      expect(standin().cloneNames).toHaveLength(0);
    });

    it('clones: the row, the provider voice and "Your voice" for its owner only; every voice tool can read in it; removing it deletes both', async () => {
      await h.grant(PLAIN, 5000);
      await h.grant(BASIC, 1000);
      const id = await run(await clone(PLAIN));
      const job = await readJob(PLAIN, id);
      expect(job.state).toBe('done');
      expect(job.tool).toBe('my-voice');
      expect(job.outputs).toEqual([]);
      expect(await h.balance(PLAIN)).toBe(5000 - CLONE);
      const kept = await rows(PLAIN);
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ name: 'My voice', removedAt: null });
      expect(kept[0].providerVoiceId).toMatch(/^clone-\d+$/);
      expect(kept[0].consentLine).toMatch(/^I am /);
      expect(standin().cloneNames).toEqual(['wawu-voice']);
      expect(h.standin.openClones()).toBe(1);
      expect(h.inputs.removed).toHaveLength(1);
      expect(await myVoice(PLAIN)).toMatchObject({
        state: 'ready',
        name: 'My voice',
      });
      expect(JSON.stringify(await myVoice(PLAIN))).not.toContain(
        kept[0].providerVoiceId!,
      );

      const mine = await catalogue(PLAIN);
      for (const tool of [
        'voiceover',
        'quick-voice',
        'dialogue',
        'voice-changer',
      ])
        expect(voicesOf(mine, tool)[0]).toBe('own');
      expect(
        mine.tools.find((t) => t.id === 'voiceover')!.voices[0],
      ).toMatchObject({
        id: 'own',
        name: 'Your voice',
      });
      const theirs = await catalogue(BASIC);
      for (const tool of [
        'voiceover',
        'quick-voice',
        'dialogue',
        'voice-changer',
      ])
        expect(voicesOf(theirs, tool)).not.toContain('own');
      expect((await myVoice(BASIC)).state).toBe('none');

      // Every voice tool reads in it, with the saved clone and no new clone made.
      const clonesMade = standin().cloned;
      const text = 'Read this in my voice.';
      const vo = await h.create(PLAIN, {
        text,
        voiceId: 'own',
        quoteToken: token(PLAIN, 'voiceover_per_min', VOICEOVER),
      });
      expect(vo.status).toBe(202);
      const quick = await post(
        PLAIN,
        'quick-voice/jobs',
        'quick_voice_per_min',
        QUICK,
        {
          text,
          voiceId: 'own',
        },
      );
      expect(quick.status).toBe(202);
      expect(
        (
          await run(
            await scene(PLAIN, [
              { text, voiceId: 'own' },
              { text, voiceId: 'ada' },
            ]),
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (await run(await change(PLAIN, voiceFile(PLAIN, 20), 'own'))).length,
      ).toBeGreaterThan(0);
      await h.jobs.drain();
      expect(standin().cloned).toBe(clonesMade);
      expect(
        standin().voices.filter((v) => v === kept[0].providerVoiceId),
      ).toHaveLength(2);
      expect(standin().voiceChanges.at(-1)?.voice).toBe(
        kept[0].providerVoiceId,
      );
      expect(standin().dialogues.at(-1)?.voices).toContain(
        kept[0].providerVoiceId,
      );
      // Another person cannot name it.
      expect((await change(BASIC, voiceFile(BASIC, 20), 'own')).status).toBe(
        400,
      );

      // A second clone is refused with nothing held.
      const balance = await h.balance(PLAIN);
      const again = await clone(PLAIN);
      expect(again.status).toBe(409);
      expect(reasonOf(again).code).toBe('clone_exists');
      expect(await h.balance(PLAIN)).toBe(balance);

      // Removing it deletes the provider voice and the row, and the entries lose it.
      const gone = data<SavedVoiceRemovedView>(
        await h.http().delete('/ai-tools/my-voice').set(auth(PLAIN)),
      );
      expect(gone.atProvider).toBe('gone');
      expect(gone.myVoice.state).toBe('none');
      expect(await rows(PLAIN)).toHaveLength(0);
      expect(h.standin.openClones()).toBe(0);
      expect(voicesOf(await catalogue(PLAIN), 'voiceover')).not.toContain(
        'own',
      );
      const withdrawn = await post(
        PLAIN,
        'quick-voice/jobs',
        'quick_voice_per_min',
        QUICK,
        {
          text,
          voiceId: 'own',
        },
      );
      expect(withdrawn.status).toBe(400);
      expect(reasonOf(withdrawn).code).toBe('ai_voice_unknown');
    });

    it('makes one clone for a double tap, whichever keys the two taps carry', async () => {
      await h.grant(PLAIN, 5000);
      const state = await myVoice(PLAIN);
      const send = () =>
        post(PLAIN, 'my-voice', 'voice_clone_once', CLONE, {
          fileKey: voiceFile(PLAIN, 12),
          name: 'My voice',
          consentLine: state.consent.line,
        });
      const before = standin().cloned;
      const results = await Promise.all([send(), send(), send()]);
      await h.jobs.drain();
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 202).length).toBeGreaterThanOrEqual(
        1,
      );
      expect(standin().cloned - before).toBe(1);
      expect(await rows(PLAIN)).toHaveLength(1);
      expect(h.standin.openClones()).toBe(1);
      // Whatever got to run and lost gave its points back: only one clone is paid for.
      expect(await h.balance(PLAIN)).toBe(5000 - CLONE);
      // The same key twice is the same job.
      await h.http().delete('/ai-tools/my-voice').set(auth(PLAIN));
      const key = randomUUID();
      const sample = voiceFile(PLAIN, 12);
      const body = {
        fileKey: sample,
        name: 'My voice',
        consentLine: state.consent.line,
      };
      const one = await post(
        PLAIN,
        'my-voice',
        'voice_clone_once',
        CLONE,
        body,
        key,
      );
      const two = await post(
        PLAIN,
        'my-voice',
        'voice_clone_once',
        CLONE,
        body,
        key,
      );
      expect(one.status).toBe(202);
      expect(data<AiJobView>(two).id).toBe(data<AiJobView>(one).id);
      await h.jobs.drain();
      expect(await rows(PLAIN)).toHaveLength(1);
    });

    it('gives every point back and frees the person to try again when the provider fails, refuses or has no voice slots', async () => {
      await h.grant(PLAIN, 5000);
      for (const marker of [
        '[[sample-fail]]',
        '[[sample-reject]]',
        '[[sample-slots]]',
      ]) {
        const id = await run(await clone(PLAIN, 12, marker));
        const job = await readJob(PLAIN, id);
        expect(job.state).toBe('failed');
        expect(job.message).toMatch(/No points were taken/);
        expect(await h.balance(PLAIN)).toBe(5000);
        expect(await rows(PLAIN)).toHaveLength(0);
        expect(h.standin.openClones()).toBe(0);
      }
      const ok = await run(await clone(PLAIN));
      expect((await readJob(PLAIN, ok)).state).toBe('done');
    });

    it('stops at the Hub-wide ceiling with nothing held, and counts a voice still being removed at the provider', async () => {
      await h.grant(PLAIN, 5000);
      await set('ai.clones_total_max', 0);
      const full = await clone(PLAIN);
      expect(full.status).toBe(503);
      expect(reasonOf(full).code).toBe('ai_tool_unavailable');
      expect(await h.balance(PLAIN)).toBe(5000);
      await set('ai.clones_total_max', 1);
      await run(await clone(PLAIN));
      await h.grant(BASIC, 1000);
      const second = await clone(BASIC);
      expect(second.status).toBe(503);
      await set('ai.clones_per_person', 2);
      await set('ai.clones_total_max', 5);
      const stillOne = await clone(PLAIN);
      expect(stillOne.status).toBe(202);
      await h.jobs.drain();
      expect(await rows(PLAIN)).toHaveLength(2);
    });

    it('gives back the reservation of a job that ended failed, so a dead job never blocks the person', async () => {
      const jobId = randomUUID();
      await h.prisma.aiToolJob.create({
        data: {
          id: jobId,
          wawuUserId: PLAIN,
          tool: 'voice_clone_once',
          idempotencyKey: jobId,
          requestHash: 'seed',
          voiceId: '',
          characters: 0,
          units: 1,
          costPoints: 1,
          state: 'failed',
          failureCode: 'timed_out',
          finishedAt: new Date(),
        },
      });
      await h.prisma.aiClonedVoice.create({
        data: {
          wawuUserId: PLAIN,
          jobId,
          name: 'Old',
          consentLine: 'x',
          consentAt: new Date(),
        },
      });
      expect((await myVoice(PLAIN)).state).toBe('none');
      expect(await rows(PLAIN)).toHaveLength(0);
    });

    it('keeps a removal the provider has not finished, and the sweep finishes it', async () => {
      await h.grant(PLAIN, 5000);
      await run(await clone(PLAIN, 12, '[[remove-fail]]'));
      expect(await rows(PLAIN)).toHaveLength(1);
      const gone = data<SavedVoiceRemovedView>(
        await h.http().delete('/ai-tools/my-voice').set(auth(PLAIN)),
      );
      expect(gone.atProvider).toBe('pending');
      expect(gone.myVoice.state).toBe('none');
      expect(h.standin.openClones()).toBe(1);
      // The voice is gone from every list at once, even though the provider still holds it.
      expect(voicesOf(await catalogue(PLAIN), 'voiceover')).not.toContain(
        'own',
      );
      h.standin.releaseStubborn();
      const swept = await h.clones.sweep();
      expect(swept.left).toBe(0);
      expect(await rows(PLAIN)).toHaveLength(0);
      expect(h.standin.openClones()).toBe(0);
    });

    it('is removed with the account: the provider voice first, and the purge waits while the provider still holds it', async () => {
      await h.grant(PLAIN, 5000);
      await run(await clone(PLAIN, 12, '[[remove-fail]]'));
      const purge = h.get<AiToolsPurgeService>(AiToolsPurgeService);
      await expect(purge.beforeErase(PLAIN)).rejects.toThrow(/saved voice/);
      expect(await rows(PLAIN)).toHaveLength(1);
      h.standin.releaseStubborn();
      await purge.beforeErase(PLAIN);
      expect(await rows(PLAIN)).toHaveLength(0);
      expect(h.standin.openClones()).toBe(0);
    });
  });
});
