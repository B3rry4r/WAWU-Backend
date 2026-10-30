// Contract tests for AITOOLS-13 (R-109): the Audiobook and the Podcast maker. Real HTTP against the caller's DATABASE_URL,
// the real job, input and points services, the real followers and the real HTTP voice adapter against the voice stand-in
// on this machine (scripts/dev/voice-standin.cjs). NOT RUN against the real provider (the owner's credits are not
// bought yet): each tool's one proof call is written in tasks/AITOOLS-13.md. No payment provider and no Fintava double.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { AiJobService } from '../ai-job.service';
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
} from '../../../test/ai-tools/ai-tools-harness';
import { AI_AUDIO_STORE } from '../audio/ai-audio-store';
import { AI_MEDIA_STORE } from '../media/ai-media-store';
import { AiInputService } from '../input/ai-input-files';
import { AiAudiobookService } from '../audiobook/ai-audiobook.service';
import { chunkBook } from '../audiobook/audiobook-chunks';
import { AI_VOICE_PROVIDER } from '../voice/ai-voice-provider';
import { FILE_KINDS } from '../../account-purge/purge-files';
import { GENERATED_KEY_FOLDERS } from '../../storage/storage.service';
import { AI_AUDIO_FOLDERS } from '../audio/ai-audio-store';
import { toolForAction } from '../tools';

jest.setTimeout(180_000);

const plan = loadPlansConfig();
const cost = (id: string) => plan.actions.find((a) => a.id === id)!.points;
const PER_MIN = cost('audiobook_per_min');
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools13@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const LONG_DASH = /[–—]/;
const FRAME = 417;
const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason: { code: string; message: string } }).reason;

/** A book of `sections` sections of about `each` characters, each under a heading (so each is a chapter). */
const book = (
  sections: number,
  each: number,
  marks: Record<number, string> = {},
) =>
  Array.from({ length: sections }, (_, i) => {
    const body =
      `${'The river ran past the old town. '.repeat(Math.ceil(each / 33))}`.slice(
        0,
        each,
      );
    return `# Chapter ${i + 1}\n\n${body}${marks[i] ?? ''}`;
  }).join('\n\n');

describe('AITOOLS-13: the Audiobook and the Podcast maker (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | string[] | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const switchOn = async () => {
    await set('ai.listed.audiobook', 1);
    await set('ai.listed.podcast', 1);
    await set('ai.podcast_studio_api_ok', 1);
    // The day's cap is the owner's to size for long-form; a spec of a 40,000 character book lifts it.
    await set('points.daily_cap', 100_000);
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
  const minutes = (text: string) =>
    Math.max(1, Math.ceil(Array.from(text).length / 900));
  const readBook = (
    who: string,
    text: string,
    extra: Record<string, unknown> = {},
    key?: string,
  ) =>
    post(
      who,
      'audiobook/jobs',
      'audiobook_per_min',
      PER_MIN * minutes(text),
      { text, voiceId: 'ada', ...extra },
      key,
    );
  const PODCAST_ACTION = {
    short: 'podcast_short',
    standard: 'podcast_standard',
    long: 'podcast_long',
  } as const;
  const makeCast = (
    who: string,
    body: Record<string, unknown>,
    duration: 'short' | 'standard' | 'long' = 'standard',
    key?: string,
  ) =>
    post(
      who,
      'podcast/jobs',
      PODCAST_ACTION[duration],
      cost(PODCAST_ACTION[duration]),
      {
        mode: 'bulletin',
        voiceIds: ['ada'],
        duration,
        language: 'en',
        ...body,
      },
      key,
    );
  const partKeys = () =>
    [...h.store.files.keys()].filter((k) => k.startsWith('ai/audiobook-part/'));
  /** Passes of the followers until the job leaves `working`. */
  const finish = (who: string, id: string) => h.finish(who, id);

  beforeAll(async () => {
    h = await bootAiTools({ media: true, studio3: true });
    settings = h.get<PlanSettingsService>(PlanSettingsService);
    h.podcasts.pollMs = 0;
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
      s.speechContext,
      s.podcasts,
      s.podcastReads,
      s.deletedPodcasts,
      s.voices,
    ] as unknown[][])
      list.length = 0;
    s.calls = 0;
    h.store.files.clear();
    h.store.removed.length = 0;
    h.media.files.clear();
    h.media.removed.length = 0;
    h.media.copies.clear();
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    for (const key of [...touched]) await set(key, null);
    touched.clear();
    await switchOn();
    await h.grant(PLAIN, 60_000);
  });

  describe('the listing switches and the catalogue', () => {
    it('lists neither tool while its switch is off, answers unavailable with nothing held, and lists each whole when on', async () => {
      await set('ai.listed.audiobook', 0);
      await set('ai.listed.podcast', 0);
      const off = data<AiToolsView>(
        await h.http().get('/ai-tools').set(auth(PLAIN)),
      );
      expect(off.tools.map((t) => t.id)).not.toContain('audiobook');
      expect(off.tools.map((t) => t.id)).not.toContain('podcast');
      const before = await h.balance(PLAIN);
      const refused = await readBook(PLAIN, 'Hello there.');
      expect(refused.status).toBe(503);
      expect(reasonOf(refused).code).toBe('ai_tool_unavailable');
      expect(
        (await makeCast(PLAIN, { source: { text: 'Hello there.' } })).status,
      ).toBe(503);
      expect(await h.balance(PLAIN)).toBe(before);

      await switchOn();
      const on = data<AiToolsView>(
        await h.http().get('/ai-tools').set(auth(PLAIN)),
      );
      const bookTool = on.tools.find((t) => t.id === 'audiobook')!;
      expect(bookTool).toMatchObject({
        action: 'audiobook_per_min',
        unit: 'minute',
        costPointsPerUnit: PER_MIN,
        enabled: true,
        input: { kind: 'text', maxCharacters: 100_000, charactersPerUnit: 900 },
      });
      expect(bookTool.voices.length).toBeGreaterThan(0);
      const cast = on.tools.find((t) => t.id === 'podcast')!;
      expect(cast.input.kind).toBe('podcast');
      expect(cast.input.podcast).toMatchObject({
        modes: ['conversation', 'bulletin'],
        maxVoices: 2,
        maxLinkCharacters: 2000,
        durations: [
          {
            id: 'short',
            action: 'podcast_short',
            costPoints: cost('podcast_short'),
          },
          {
            id: 'standard',
            action: 'podcast_standard',
            costPoints: cost('podcast_standard'),
          },
          {
            id: 'long',
            action: 'podcast_long',
            costPoints: cost('podcast_long'),
          },
        ],
      });
      expect(cast.input.podcast!.languages.map((l) => l.code)).toEqual([
        'en',
        'fr',
        'es',
        'pt',
      ]);
      // Every entry is whole: the live app refuses the whole list for one malformed entry.
      for (const t of on.tools) {
        expect(typeof t.id).toBe('string');
        expect(typeof t.name).toBe('string');
        expect(typeof t.costPointsPerUnit).toBe('number');
        expect(typeof t.enabled).toBe('boolean');
        expect(`${t.name} ${t.description}`).not.toMatch(LONG_DASH);
      }
    });

    it('keeps the Podcast maker unlisted until the Studio switch is on, even with its own switch on', async () => {
      await set('ai.podcast_studio_api_ok', 0);
      const res = data<AiToolsView>(
        await h.http().get('/ai-tools').set(auth(PLAIN)),
      );
      expect(res.tools.map((t) => t.id)).not.toContain('podcast');
      expect(res.tools.map((t) => t.id)).toContain('audiobook');
      const before = await h.balance(PLAIN);
      expect(
        (await makeCast(PLAIN, { source: { text: 'Hello there.' } })).status,
      ).toBe(503);
      expect(await h.balance(PLAIN)).toBe(before);
    });

    it('has a folder, a purge decision and a stored key for everything the two tools keep', () => {
      for (const folder of [
        'ai/audiobook',
        'ai/audiobook-part',
        'ai/podcast',
      ] as const) {
        expect(AI_AUDIO_FOLDERS).toContain(folder);
        expect([...GENERATED_KEY_FOLDERS]).toContain(folder);
        expect(FILE_KINDS[folder]?.decision).toBe('DELETE');
      }
      expect(FILE_KINDS['ai/input-doc']?.decision).toBe('DELETE');
      expect(toolForAction('podcast_short')?.id).toBe('podcast');
      expect(toolForAction('podcast_long')?.id).toBe('podcast');
      expect(toolForAction('audiobook_per_min')?.id).toBe('audiobook');
    });
  });

  describe('Audiobook', () => {
    it('runs a book of 40,000 characters: holds for all of it up front, speaks the chapters in turn, joins them into one mp3, stores it, keeps the points and clears its working files', async () => {
      const text = book(20, 1900);
      expect(Array.from(text).length).toBeGreaterThan(38_000);
      const chapters = chunkBook(text, 9000);
      expect(chapters.length).toBeGreaterThan(3);
      const price = PER_MIN * minutes(text);
      const before = await h.balance(PLAIN);
      const res = await readBook(PLAIN, text);
      expect(res.status).toBe(202);
      const started = data<AiJobView>(res);
      expect(started.state).toBe('working');
      expect(started.costPoints).toBe(price);
      // Held for the whole text before a chapter is spoken.
      expect(await h.balance(PLAIN)).toBe(before - price);
      expect(standin().speechContext).toHaveLength(0);

      const done = await finish(PLAIN, started.id);
      expect(done.state).toBe('done');
      expect(await h.balance(PLAIN)).toBe(before - price);
      // One chapter, one speech call: the voice carries over each join with the words before and after.
      const ctx = standin().speechContext;
      expect(ctx).toHaveLength(chapters.length);
      expect(ctx[0].previous).toBeNull();
      expect(ctx[0].next).toBeGreaterThan(0);
      expect(ctx[ctx.length - 1].next).toBeNull();
      for (const c of ctx.slice(1, -1)) {
        expect(c.previous).toBeGreaterThan(0);
        expect(c.next).toBeGreaterThan(0);
      }
      // ONE file, the sum of the chapters, in the audiobook folder; the chapter files and the words are gone.
      const key = `ai/audiobook/${PLAIN}/${started.id}.mp3`;
      const stored = h.media.files.get(key);
      expect(stored).toBeDefined();
      expect(stored!.contentType).toBe('audio/mpeg');
      const expectedBytes = chapters.reduce(
        (n, c) => n + Math.max(4, Math.ceil(c.length / 20)) * FRAME,
        0,
      );
      expect(stored!.bytes).toBe(expectedBytes);
      expect(partKeys()).toEqual([]);
      expect(
        [...h.inputs.files.keys()].filter((k) => k.startsWith('ai/input-doc/')),
      ).toEqual([]);
      const view = done as unknown as AiJobView;
      expect(view.outputs).toHaveLength(1);
      expect(view.outputs[0]).toMatchObject({
        kind: 'audio',
        contentType: 'audio/mpeg',
        pieceFormat: 'audio',
        bytes: expectedBytes,
      });
      expect(view.audioUrl).toContain(key);
      expect(view.outputs[0].name).toBe('Audiobook');
      // The result into Create: one audio piece.
      const piece = await h
        .http()
        .post(`/ai-tools/jobs/${started.id}/piece`)
        .set(auth(PLAIN))
        .set('Idempotency-Key', randomUUID())
        .send({ outputIndex: 0 });
      expect(piece.status).toBe(200);
      expect(data<AiPieceView>(piece).format).toBe('audio');
      expect(data<AiPieceView>(piece).suggestedTitle).toMatch(
        /^Audiobook, \d+ /,
      );
      expect(data<AiPieceView>(piece).suggestedTitle).not.toMatch(LONG_DASH);
    });

    it('gives every point back and removes the partial files when a chapter fails, both a refusal and a provider that stays down', async () => {
      for (const mark of ['[[reject]]', '[[fail]]']) {
        h.store.files.clear();
        standin().speechContext.length = 0;
        const text = book(5, 2000, { 2: ` ${mark}` });
        const before = await h.balance(PLAIN);
        const started = data<AiJobView>(await readBook(PLAIN, text));
        expect(await h.balance(PLAIN)).toBe(before - PER_MIN * minutes(text));
        const ended = (await finish(PLAIN, started.id)) as unknown as AiJobView;
        expect(ended.state).toBe('failed');
        expect(ended.message).toMatch(/No points were taken/);
        expect(ended.message).not.toMatch(LONG_DASH);
        expect(ended.outputs).toEqual([]);
        expect(await h.balance(PLAIN)).toBe(before);
        expect(partKeys()).toEqual([]);
        expect(h.media.files.size).toBe(0);
        expect(
          [...h.inputs.files.keys()].filter((k) =>
            k.startsWith('ai/input-doc/'),
          ),
        ).toEqual([]);
        // Chapters 1 and 2 were spoken; the third is where it stopped.
        expect(standin().speechContext.length).toBeGreaterThanOrEqual(3);
      }
    });

    it('resumes after a restart on chapter 2: never speaks a finished chapter again, holds once and charges once', async () => {
      const text = book(6, 2000);
      const chapters = chunkBook(text, 9000);
      expect(chapters).toHaveLength(6);
      const price = PER_MIN * minutes(text);
      const before = await h.balance(PLAIN);
      const key = randomUUID();
      const started = data<AiJobView>(await readBook(PLAIN, text, {}, key));
      // Two chapters are made; then the Hub "restarts": a follower with no memory of the first one carries on.
      while (partKeys().length < 2) await h.audiobooks.pass();
      expect(standin().speechContext).toHaveLength(2);
      const fresh = new AiAudiobookService(
        h.prisma,
        settings,
        h.get(AI_VOICE_PROVIDER),
        h.get(AI_AUDIO_STORE),
        h.get(AI_MEDIA_STORE),
        h.get(AiInputService),
        h.get(AiJobService),
      );
      for (let i = 0; i < 40; i++) {
        const row = await h.prisma.aiToolJob.findUnique({
          where: { id: started.id },
        });
        if (row!.state !== 'working') break;
        await fresh.pass();
      }
      expect((await readJob(PLAIN, started.id)).state).toBe('done');
      expect(standin().speechContext).toHaveLength(6);
      expect(await h.balance(PLAIN)).toBe(before - price);
      // The same Idempotency-Key again holds nothing more and starts nothing.
      const again = await readBook(PLAIN, text, {}, key);
      expect(again.status).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(data<AiJobView>(again).id).toBe(started.id);
      expect(await h.balance(PLAIN)).toBe(before - price);
      expect(
        await h.prisma.pointHold.count({
          where: { wawuUserId: PLAIN, purpose: 'ai_job' },
        }),
      ).toBe(1);
    });

    it("takes a plain text file in place of typed words, and refuses another person's file, a PDF and a file over the limit", async () => {
      const words = book(3, 2000);
      const fileKey = h.inputs.add(
        PLAIN,
        Buffer.from(words, 'utf8'),
        'text/plain',
        'ai/input-doc',
      );
      const res = await post(
        PLAIN,
        'audiobook/jobs',
        'audiobook_per_min',
        PER_MIN * minutes(words),
        { fileKey, voiceId: 'ada' },
      );
      expect(res.status).toBe(202);
      const done = (await finish(
        PLAIN,
        data<AiJobView>(res).id,
      )) as unknown as AiJobView;
      expect(done.state).toBe('done');
      expect(h.inputs.removed).toContain(fileKey);

      const before = await h.balance(PLAIN);
      const theirs = h.inputs.add(
        BASIC,
        Buffer.from(words),
        'text/plain',
        'ai/input-doc',
      );
      const stolen = await post(
        PLAIN,
        'audiobook/jobs',
        'audiobook_per_min',
        PER_MIN,
        { fileKey: theirs, voiceId: 'ada' },
      );
      expect(stolen.status).toBe(404);
      const pdf = h.inputs.add(
        PLAIN,
        Buffer.from('%PDF-1.4 x'),
        'application/pdf',
        'ai/input-doc',
      );
      const wrong = await post(
        PLAIN,
        'audiobook/jobs',
        'audiobook_per_min',
        PER_MIN,
        { fileKey: pdf, voiceId: 'ada' },
      );
      expect(wrong.status).toBe(422);
      expect(reasonOf(wrong).code).toBe('ai_file_type_unsupported');
      const audioFile = h.inputs.add(
        PLAIN,
        Buffer.from('x'),
        'text/plain',
        'ai/input-audio',
      );
      expect(
        (
          await post(PLAIN, 'audiobook/jobs', 'audiobook_per_min', PER_MIN, {
            fileKey: audioFile,
            voiceId: 'ada',
          })
        ).status,
      ).toBe(404);
      expect(await h.balance(PLAIN)).toBe(before);
    });

    it('refuses an empty text, a text over the limit, an unknown voice and a stale quote, each with the reason and nothing held', async () => {
      const before = await h.balance(PLAIN);
      const empty = await readBook(PLAIN, '   ');
      expect(empty.status).toBe(400);
      expect(reasonOf(empty).code).toBe('ai_text_empty');
      await set('ai.audiobook_max_chars', 5000);
      const text = 'Word '.repeat(1300);
      const over = await readBook(PLAIN, text);
      expect(over.status).toBe(422);
      expect(reasonOf(over)).toMatchObject({ code: 'ai_prompt_too_long' });
      expect(reasonOf(over).message).toMatch(/5000 characters/);
      expect(reasonOf(over).message).toMatch(/No points were taken/);
      expect(
        (await readBook(PLAIN, 'Hello there.', { voiceId: 'nobody' })).status,
      ).toBe(400);
      const stale = await post(
        PLAIN,
        'audiobook/jobs',
        'audiobook_per_min',
        PER_MIN * 9,
        { text: 'Hello there.', voiceId: 'ada' },
      );
      expect(stale.status).toBe(409);
      expect(reasonOf(stale).code).toBe('quote_changed');
      expect(await h.balance(PLAIN)).toBe(before);
      expect(standin().speechContext).toHaveLength(0);
    });

    it("is stopped by the day's cap with the reset time, and nothing is held", async () => {
      await set('points.daily_cap', 5000);
      const text = 'Word '.repeat(6000); // 30,000 characters: 34 minutes, over the day's 5,000 points
      const before = await h.balance(PLAIN);
      const res = await readBook(PLAIN, text);
      expect(res.status).toBe(422);
      const reason = reasonOf(res) as unknown as {
        code: string;
        message: string;
        cap: string;
        resetsAt: string;
      };
      expect(reason.code).toBe('points_cap_reached');
      expect(reason.cap).toBe('daily');
      expect(reason.resetsAt).toMatch(/^\d{4}-/);
      expect(reason.message).not.toMatch(LONG_DASH);
      expect(await h.balance(PLAIN)).toBe(before);
    });

    it('never takes points below zero when two books are asked at once, and runs one job for one Idempotency-Key', async () => {
      const text = book(8, 2000);
      const price = PER_MIN * minutes(text);
      await h.points.grant({
        wawuUserId: BASIC,
        source: 'pack',
        sourceRef: randomUUID(),
        points: price + 10,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const both = await Promise.all([
        readBook(BASIC, text),
        readBook(BASIC, text),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([202, 402]);
      expect(await h.balance(BASIC)).toBe(10);
      const winner = both.find((r) => r.status === 202)!;
      await finish(BASIC, data<AiJobView>(winner).id);
      expect(await h.balance(BASIC)).toBe(10);
      const key = randomUUID();
      const small = 'Hello there, this is a short book.';
      const [a, b] = await Promise.all([
        readBook(PLAIN, small, {}, key),
        readBook(PLAIN, small, {}, key),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 202]);
      expect(data<AiJobView>(a).id).toBe(data<AiJobView>(b).id);
      await finish(PLAIN, data<AiJobView>(a).id);
      expect(
        await h.prisma.pointHold.count({
          where: { wawuUserId: PLAIN, purpose: 'ai_job' },
        }),
      ).toBe(1);
    });

    it('ends a book that runs past its longest time as a timed out failure that gives every point back', async () => {
      const text = book(4, 2000, { 1: ' [[slow:200]]' });
      const before = await h.balance(PLAIN);
      const started = data<AiJobView>(await readBook(PLAIN, text));
      await h.audiobooks.pass();
      const late = new Date(Date.now() + 121 * 60_000);
      const out = await h.audiobooks.pass(late);
      expect(out.failed).toBe(1);
      const ended = await readJob(PLAIN, started.id);
      expect(ended.state).toBe('failed');
      expect(await h.balance(PLAIN)).toBe(before);
      expect(partKeys()).toEqual([]);
    });
  });

  describe('Podcast maker', () => {
    it('makes a podcast from a text and from a link in each mode: the project is made, followed, its audio stored and the project deleted', async () => {
      const runs: {
        body: Record<string, unknown>;
        duration: 'short' | 'standard' | 'long';
        want: Record<string, unknown>;
      }[] = [
        {
          body: {
            source: {
              text: 'The market opens early on Friday and the women who sell fish arrive before dawn.',
            },
          },
          duration: 'short',
          want: {
            mode: 'bulletin',
            source: 'text',
            duration: 'short',
            language: 'en',
          },
        },
        {
          body: {
            source: { url: 'https://example.com/story' },
            mode: 'conversation',
            voiceIds: ['ada', 'tunde'],
            language: 'fr',
          },
          duration: 'standard',
          want: {
            mode: 'conversation',
            source: 'url',
            duration: 'default',
            language: 'fr',
          },
        },
        {
          body: {
            source: { text: 'Hello there, this is a long one.' },
            mode: 'conversation',
            voiceIds: ['tunde', 'ada'],
          },
          duration: 'long',
          want: { mode: 'conversation', source: 'text', duration: 'long' },
        },
        {
          body: { source: { url: 'https://example.com/other' } },
          duration: 'standard',
          want: { mode: 'bulletin', source: 'url', duration: 'default' },
        },
      ];
      for (const [i, run] of runs.entries()) {
        const before = await h.balance(PLAIN);
        const price = cost(PODCAST_ACTION[run.duration]);
        const res = await makeCast(PLAIN, run.body, run.duration);
        expect(res.status).toBe(202);
        const started = data<AiJobView>(res);
        expect(started.state).toBe('working');
        expect(started.costPoints).toBe(price);
        expect(await h.balance(PLAIN)).toBe(before - price);
        const done = (await finish(PLAIN, started.id)) as unknown as AiJobView;
        expect(done.state).toBe('done');
        expect(await h.balance(PLAIN)).toBe(before - price);
        const asked = standin().podcasts[i];
        expect(asked).toMatchObject({
          ...run.want,
          quality: 'standard',
          model: 'eleven_multilingual_v2',
        });
        if (run.body.mode === 'conversation') {
          expect(asked.host).not.toBe(asked.guest);
          expect(asked.guest).not.toBeNull();
        } else expect(asked.guest).toBeNull();
        expect(done.outputs).toHaveLength(1);
        expect(done.outputs[0]).toMatchObject({
          kind: 'audio',
          pieceFormat: 'audio',
          name: 'Podcast',
        });
        expect([...h.store.files.keys()]).toContain(
          `ai/podcast/${PLAIN}/${started.id}.mp3`,
        );
        // The provider kept nothing: the project was deleted.
        expect(standin().deletedPodcasts).toContain(asked.id);
        expect(h.standin.openPodcasts()).toBe(0);
      }
      const piece = await h
        .http()
        .post(
          `/ai-tools/jobs/${(await h.prisma.aiToolJob.findFirst({ where: { wawuUserId: PLAIN, tool: 'podcast_standard' }, orderBy: { createdAt: 'desc' } }))!.id}/piece`,
        )
        .set(auth(PLAIN))
        .set('Idempotency-Key', randomUUID())
        .send({ outputIndex: 0 });
      expect(piece.status).toBe(200);
      expect(data<AiPieceView>(piece).format).toBe('audio');
    });

    it('refuses a link that is not https, one over 2,000 characters, two voices that are the same, an unknown language, a voice off the list and a source that is both or neither, each with nothing held', async () => {
      const before = await h.balance(PLAIN);
      const link = async (url: string) => makeCast(PLAIN, { source: { url } });
      for (const bad of [
        'http://example.com/story',
        'ftp://example.com/x',
        'https://127.0.0.1/x',
        'https://localhost/x',
        'https://user:pass@example.com/x',
        'not a link',
        `https://example.com/${'a'.repeat(2000)}`,
      ]) {
        const res = await link(bad);
        expect(res.status).toBe(422);
        expect(reasonOf(res).code).toBe('ai_link_invalid');
      }
      const same = await makeCast(PLAIN, {
        source: { text: 'Hello there.' },
        mode: 'conversation',
        voiceIds: ['ada', 'ada'],
      });
      expect(same.status).toBe(422);
      expect(reasonOf(same).code).toBe('ai_voices_same');
      const lonely = await makeCast(PLAIN, {
        source: { text: 'Hello there.' },
        mode: 'conversation',
        voiceIds: ['ada'],
      });
      expect(reasonOf(lonely).code).toBe('ai_voices_same');
      const lang = await makeCast(PLAIN, {
        source: { text: 'Hello there.' },
        language: 'zz',
      });
      expect(lang.status).toBe(422);
      expect(reasonOf(lang).code).toBe('ai_language_unsupported');
      expect(
        (
          await makeCast(PLAIN, {
            source: { text: 'Hello there.' },
            voiceIds: ['nobody'],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await makeCast(PLAIN, {
            source: { text: 'Hello', url: 'https://example.com/x' },
          })
        ).status,
      ).toBe(400);
      expect((await makeCast(PLAIN, { source: {} })).status).toBe(400);
      await set('ai.podcast_max_chars', 100);
      const long = await makeCast(PLAIN, {
        source: { text: 'Word '.repeat(60) },
      });
      expect(reasonOf(long).code).toBe('ai_prompt_too_long');
      expect(await h.balance(PLAIN)).toBe(before);
      expect(standin().podcasts).toHaveLength(0);
    });

    it('answers an allowlist refusal with "This isn\'t available right now. No points were taken.", gives every point back and creates nothing', async () => {
      const logged: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((m: unknown) => void logged.push(String(m)));
      const before = await h.balance(PLAIN);
      const started = data<AiJobView>(
        await makeCast(PLAIN, {
          source: { text: 'Hello there [[allowlist]]' },
        }),
      );
      const ended = (await finish(PLAIN, started.id)) as unknown as AiJobView;
      spy.mockRestore();
      // The owner reads the log: our account is not allowlisted for the provider's Studio API.
      expect(
        logged.some(
          (l) => l.startsWith('OWNER ITEM') && l.includes('Studio API'),
        ),
      ).toBe(true);
      expect(ended.state).toBe('failed');
      expect(ended.message).toBe(
        "This isn't available right now. No points were taken.",
      );
      expect(ended.message).not.toMatch(LONG_DASH);
      expect(await h.balance(PLAIN)).toBe(before);
      expect(standin().podcasts).toHaveLength(0);
      expect(h.standin.openPodcasts()).toBe(0);
    });

    it('gives every point back and deletes the project when the provider fails, never makes the file, or the run is too long', async () => {
      const before = await h.balance(PLAIN);
      for (const mark of ['[[fail]]', '[[reject]]']) {
        const started = data<AiJobView>(
          await makeCast(PLAIN, { source: { text: `Hello there ${mark}` } }),
        );
        const ended = await finish(PLAIN, started.id);
        expect(ended.state).toBe('failed');
        expect(await h.balance(PLAIN)).toBe(before);
      }
      // A project that never becomes ready: the longest run ends it and the project is deleted.
      const slow = data<AiJobView>(
        await makeCast(PLAIN, { source: { text: 'Hello there [[never]]' } }),
      );
      await h.podcasts.pass();
      const out = await h.podcasts.pass(new Date(Date.now() + 901 * 1000));
      expect(out.failed).toBe(1);
      expect((await readJob(PLAIN, slow.id)).state).toBe('failed');
      expect(h.standin.openPodcasts()).toBe(0);
      expect(standin().deletedPodcasts).toHaveLength(1);
      // The file cannot be fetched (a page where audio should be): three tries, then the points go back and the project goes.
      const page = data<AiJobView>(
        await makeCast(PLAIN, { source: { text: 'Hello there [[notaudio]]' } }),
      );
      const ended = await finish(PLAIN, page.id);
      expect(ended.state).toBe('failed');
      expect(h.standin.openPodcasts()).toBe(0);
      expect(await h.balance(PLAIN)).toBe(before);
    });
  });
});
