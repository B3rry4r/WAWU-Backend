// Contract tests for task VOICE-01: hear your name, and the Voice Intro in a
// person's own voice.
//
// Real HTTP against the caller's DATABASE_URL with real RS256 tokens from
// mock-wawu-id, the real controller, run service, points service, tier reader
// and settings, and the real HTTP voice adapter talking to the voice stand-in
// (scripts/dev/voice-standin.cjs) on this machine. NOT RUN against the real
// provider: its key is not on any build machine (unblocked by a provider key
// set on the Hub). No payment provider and no Fintava double is started.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { PointsSpendService } from '../../points/spend/points-spend.service';
import { introAudioKey } from '../voice-files';
import { runIdFor } from '../voice-intro-run.service';
import type {
  MyVoiceView,
  NamePreviewView,
  VoiceIntroView,
} from '../voice-intro-view.type';
import {
  bootVoice,
  BASIC,
  FILES_BASE,
  PLAIN,
  type VoiceHarness,
} from '../../../test/voice-intro/voice-intro-harness';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const intro = plan.actions.find((a) => a.id === 'voice_intro')!;
const COST = intro.points;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'voice01@admin.test.wawu.dev',
  role: AdminRole.finance,
};

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (
    res.body as {
      reason: Record<string, unknown> & { code: string; message: string };
    }
  ).reason;
const key = () => randomUUID();
/** The ruled line (the lead, 21 Oct 2026): the board's words with the person's own name from the Hub's record of them. */
const PLAIN_LINE =
  'I am Adaeze Okonkwo. I agree that Who Made This? may create an AI version of my voice for my intros.';
const BASIC_LINE =
  'I am Chidi Umeh. I agree that Who Made This? may create an AI version of my voice for my intros.';

describe('VOICE-01: hear your name and the Voice Intro (contract)', () => {
  let h: VoiceHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (k: string, value: number | null) => {
    touched.add(k);
    await settings.set(admin, { settings: { [k]: value } });
  };
  const generate = (who = PLAIN, k: string | null = key()) =>
    h.as(
      who,
      'post',
      '/me/voice-intro/generate',
      undefined,
      k ? { 'Idempotency-Key': k } : {},
    );
  const holdsOf = (who: string) =>
    h.prisma.pointHold.findMany({ where: { wawuUserId: who } });
  const runsOf = (who: string) =>
    h.prisma.voiceIntroRun.findMany({ where: { wawuUserId: who } });
  const includedOf = async (who: string) =>
    (await h.prisma.makerTier.findUnique({ where: { wawuUserId: who } }))
      ?.voiceIntroIncluded;

  beforeAll(async () => {
    h = await bootVoice();
    settings = h.get<PlanSettingsService>(PlanSettingsService);
  });
  afterAll(async () => {
    for (const k of touched)
      await settings.set(admin, { settings: { [k]: null } });
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.clean();
    await h.close();
  });
  beforeEach(async () => {
    for (const k of touched)
      await settings.set(admin, { settings: { [k]: null } });
    touched.clear();
    await h.runs.drain();
    await h.clean();
    h.files.reset();
  });

  it('needs a signed-in caller on every route', async () => {
    const http = h.http();
    expect((await http.get('/me/voice')).status).toBe(401);
    expect((await http.post('/me/voice/name-preview').send({})).status).toBe(
      401,
    );
    expect((await http.put('/me/voice/name').send({})).status).toBe(401);
    expect((await http.get('/me/voice-intro')).status).toBe(401);
    expect((await http.put('/me/voice-intro/text').send({})).status).toBe(401);
    expect((await http.post('/me/voice-intro/consent').send({})).status).toBe(
      401,
    );
    expect((await http.post('/me/voice-intro/sample').send({})).status).toBe(
      401,
    );
    expect((await http.post('/me/voice-intro/generate')).status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Hear your name (VF3)
  // ---------------------------------------------------------------------------

  describe('hear your name', () => {
    it('says the name in the studio voice, free, marked as an AI voice, and keeps the spelling the person saves', async () => {
      const calls = h.standin.state.calls;
      const res = await h.as(PLAIN, 'post', '/me/voice/name-preview', {
        name: 'Adéọlá',
        phonetic: 'Ah-DEH-oh-lah',
      });
      expect(res.status).toBe(200);
      const view = data<NamePreviewView>(res);
      expect(view.aiVoice).toBe(true);
      expect(view.audioUrl).toBe(
        `${FILES_BASE}ai/voiceover/${PLAIN}/name-preview.mp3`,
      );
      expect(h.standin.state.calls).toBe(calls + 1);
      expect(
        h.files.audio.get(`ai/voiceover/${PLAIN}/name-preview.mp3`)!.length,
      ).toBeGreaterThan(0);
      // Free: no points moved and no hold was made.
      expect(await holdsOf(PLAIN)).toHaveLength(0);

      const saved = data<MyVoiceView>(
        await h.as(PLAIN, 'put', '/me/voice/name', {
          phonetic: 'Ah-DEH-oh-lah',
        }),
      );
      expect(saved).toMatchObject({
        namePhonetic: 'Ah-DEH-oh-lah',
        available: true,
      });
      expect(saved.nameSavedAt).toEqual(expect.any(String));
      expect(
        data<MyVoiceView>(await h.as(PLAIN, 'get', '/me/voice')).namePhonetic,
      ).toBe('Ah-DEH-oh-lah');
      // Null puts it back to the plain name; another person's spelling is their own.
      expect(
        data<MyVoiceView>(
          await h.as(PLAIN, 'put', '/me/voice/name', { phonetic: null }),
        ).namePhonetic,
      ).toBeNull();
      expect(
        data<MyVoiceView>(await h.as(BASIC, 'get', '/me/voice')).namePhonetic,
      ).toBeNull();
    });

    it('takes only a name: letters, spaces, apostrophes and hyphens', async () => {
      for (const name of [
        '',
        '   ',
        '<script>',
        'Ada [[fail]]',
        'a'.repeat(61),
        '1234',
      ])
        expect(
          (await h.as(PLAIN, 'post', '/me/voice/name-preview', { name }))
            .status,
        ).toBe(400);
      expect(
        (
          await h.as(PLAIN, 'post', '/me/voice/name-preview', {
            name: "N'Golo Kanté-Ade",
          })
        ).status,
      ).toBe(200);
      // No id of anyone is accepted.
      expect(
        (
          await h.as(PLAIN, 'post', '/me/voice/name-preview', {
            name: 'Ada',
            wawuUserId: BASIC,
          })
        ).status,
      ).toBe(400);
    });

    it('is limited per hour by a setting, and says so in plain words', async () => {
      await set('voice.name_previews_per_hour', 2);
      for (let i = 0; i < 2; i++)
        expect(
          (await h.as(PLAIN, 'post', '/me/voice/name-preview', { name: 'Ada' }))
            .status,
        ).toBe(200);
      const third = await h.as(PLAIN, 'post', '/me/voice/name-preview', {
        name: 'Ada',
      });
      expect(third.status).toBe(429);
      expect(reasonOf(third).code).toBe('voice_preview_limit');
      expect(reasonOf(third).message).toMatch(/last hour/);
      // Another person's count is their own.
      expect(
        (await h.as(BASIC, 'post', '/me/voice/name-preview', { name: 'Ada' }))
          .status,
      ).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Check 3: the consent line, its time and the sample are stored; another person's voice is refused
  // ---------------------------------------------------------------------------

  describe('check 3: consent, sample and whose voice it is', () => {
    it('serves the consent line, takes only that line, and stores it with the time and the sample', async () => {
      const before = data<VoiceIntroView>(
        await h.as(PLAIN, 'get', '/me/voice-intro'),
      );
      expect(before).toMatchObject({
        aiVoice: true,
        text: null,
        consent: { line: PLAIN_LINE, given: false, at: null },
        sample: { recorded: false, at: null, minSeconds: 15, maxSeconds: 30 },
        audioUrl: null,
        run: null,
      });
      expect(before.textMaxChars).toBe(500);

      // The sample waits for the consent.
      const link = await h.upload(PLAIN);
      const early = await h.as(PLAIN, 'post', '/me/voice-intro/sample', {
        fileUrl: link,
      });
      expect(early.status).toBe(409);
      expect(reasonOf(early).code).toBe('voice_consent_required');

      // Other words than the ones served are refused.
      const wrong = await h.as(PLAIN, 'post', '/me/voice-intro/consent', {
        line: 'I agree.',
      });
      expect(wrong.status).toBe(409);
      expect(reasonOf(wrong).code).toBe('voice_consent_line_changed');

      const consented = data<VoiceIntroView>(
        await h.as(PLAIN, 'post', '/me/voice-intro/consent', {
          line: PLAIN_LINE,
        }),
      );
      expect(consented.consent.given).toBe(true);
      const sampled = data<VoiceIntroView>(
        await h.as(PLAIN, 'post', '/me/voice-intro/sample', { fileUrl: link }),
      );
      expect(sampled.sample.recorded).toBe(true);

      const row = await h.prisma.voiceProfile.findUniqueOrThrow({
        where: { wawuUserId: PLAIN },
      });
      expect(row.consentLine).toBe(PLAIN_LINE);
      expect(row.consentAt).not.toBeNull();
      expect(row.sampleKey).toBe(link.slice(FILES_BASE.length));
      expect(row.sampleAt).not.toBeNull();
      expect(row.sampleConsentAt!.getTime()).toBe(row.consentAt!.getTime());

      // A new recording replaces the old one, and the old file is removed.
      const second = await h.upload(PLAIN);
      await h
        .as(PLAIN, 'post', '/me/voice-intro/sample', { fileUrl: second })
        .expect(200);
      expect(h.files.removed).toContain(link.slice(FILES_BASE.length));
    });

    it("serves each person's own name in the line and takes back only that person's line", async () => {
      const mine = data<VoiceIntroView>(
        await h.as(PLAIN, 'get', '/me/voice-intro'),
      );
      const theirs = data<VoiceIntroView>(
        await h.as(BASIC, 'get', '/me/voice-intro'),
      );
      expect(mine.consent.line).toBe(PLAIN_LINE);
      expect(theirs.consent.line).toBe(BASIC_LINE);
      // The line served to someone else is not the caller's own words: refused, and nothing is stored.
      const swapped = await h.as(PLAIN, 'post', '/me/voice-intro/consent', {
        line: BASIC_LINE,
      });
      expect(swapped.status).toBe(409);
      expect(reasonOf(swapped).code).toBe('voice_consent_line_changed');
      const stored = await h.prisma.voiceProfile.findUnique({
        where: { wawuUserId: PLAIN },
        select: { consentAt: true },
      });
      expect(stored?.consentAt ?? null).toBeNull();
      await h
        .as(BASIC, 'post', '/me/voice-intro/consent', { line: BASIC_LINE })
        .expect(200);
      const row = await h.prisma.voiceProfile.findUniqueOrThrow({
        where: { wawuUserId: BASIC },
      });
      expect(row.consentLine).toBe(BASIC_LINE);
    });

    it('serves the shortest and longest recording from two settings, and holds the shortest down to the longest', async () => {
      const seconds = (v: VoiceIntroView) => [
        v.sample.minSeconds,
        v.sample.maxSeconds,
      ];
      expect(
        seconds(
          data<VoiceIntroView>(await h.as(PLAIN, 'get', '/me/voice-intro')),
        ),
      ).toEqual([15, 30]);
      await set('voice_intro.sample_min_seconds', 10);
      await set('voice_intro.sample_max_seconds', 45);
      expect(
        seconds(
          data<VoiceIntroView>(await h.as(PLAIN, 'get', '/me/voice-intro')),
        ),
      ).toEqual([10, 45]);
      await set('voice_intro.sample_min_seconds', 50);
      expect(
        seconds(
          data<VoiceIntroView>(await h.as(PLAIN, 'get', '/me/voice-intro')),
        ),
      ).toEqual([45, 45]);
    });

    it("refuses another person's recording, one that never landed, one in another folder and a link from anywhere else", async () => {
      await h
        .as(PLAIN, 'post', '/me/voice-intro/consent', { line: PLAIN_LINE })
        .expect(200);
      const others = await h.upload(BASIC);
      const pending = await h.upload(PLAIN, { status: 'pending' });
      const elsewhere = `https://elsewhere.example.test/voice/sample/${PLAIN}/${randomUUID()}.m4a`;
      const wrongFolder = `${FILES_BASE}avatars/${PLAIN}/${randomUUID()}.m4a`;
      const dirty = `${FILES_BASE}voice/sample/${PLAIN}/../${BASIC}/${randomUUID()}.m4a`;
      const unknown = `${FILES_BASE}voice/sample/${PLAIN}/${randomUUID()}.m4a`;
      for (const fileUrl of [
        others,
        pending,
        elsewhere,
        wrongFolder,
        dirty,
        unknown,
        'nonsense',
      ]) {
        const res = await h.as(PLAIN, 'post', '/me/voice-intro/sample', {
          fileUrl,
        });
        expect(res.status).toBe(400);
        expect(reasonOf(res).code).toBe('voice_sample_unusable');
      }
      const row = await h.prisma.voiceProfile.findUniqueOrThrow({
        where: { wawuUserId: PLAIN },
      });
      expect(row.sampleKey).toBeNull();
      // BASIC's own recording is still BASIC's alone: PLAIN cannot reach it by any route.
      expect(
        (
          await h.as(PLAIN, 'post', '/me/voice-intro/sample', {
            fileUrl: others,
            wawuUserId: BASIC,
          })
        ).status,
      ).toBe(400);
    });

    it("a person's try uses only their own words, consent and recording", async () => {
      await h.giveTier(PLAIN, true);
      await h.giveTier(BASIC, true);
      await h.prepare(PLAIN);
      // BASIC has said and recorded nothing: nothing of PLAIN's is theirs.
      const refused = await generate(BASIC);
      expect(refused.status).toBe(409);
      expect(reasonOf(refused).code).toBe('voice_text_required');
      expect(await runsOf(BASIC)).toHaveLength(0);
      expect(await includedOf(BASIC)).toBe(true);
    });

    it('asks for the words, then the consent, then the recording, taking nothing', async () => {
      await h.giveTier(PLAIN, true);
      await h.grant(PLAIN, COST);
      expect(reasonOf(await generate()).code).toBe('voice_text_required');
      await h
        .as(PLAIN, 'put', '/me/voice-intro/text', { text: 'Hello.' })
        .expect(200);
      expect(reasonOf(await generate()).code).toBe('voice_consent_required');
      await h
        .as(PLAIN, 'post', '/me/voice-intro/consent', { line: PLAIN_LINE })
        .expect(200);
      expect(reasonOf(await generate()).code).toBe('voice_sample_required');
      expect(await runsOf(PLAIN)).toHaveLength(0);
      expect(await holdsOf(PLAIN)).toHaveLength(0);
      expect(await includedOf(PLAIN)).toBe(true);
      expect(await h.balance(PLAIN)).toBe(COST);
    });

    it('keeps the words within the limit from the settings', async () => {
      const long = 'a'.repeat(501);
      const res = await h.as(PLAIN, 'put', '/me/voice-intro/text', {
        text: long,
      });
      expect(res.status).toBe(400);
      expect(reasonOf(res)).toMatchObject({
        code: 'voice_text_too_long',
        maxCharacters: 500,
      });
      const blank = await h.as(PLAIN, 'put', '/me/voice-intro/text', {
        text: '   ',
      });
      expect(blank.status).toBe(400);
      expect(reasonOf(blank).code).toBe('voice_text_empty');
      await set('voice.intro_max_chars', 600);
      expect(
        (await h.as(PLAIN, 'put', '/me/voice-intro/text', { text: long }))
          .status,
      ).toBe(200);
      expect(
        data<VoiceIntroView>(await h.as(PLAIN, 'get', '/me/voice-intro'))
          .textMaxChars,
      ).toBe(600);
    });
  });

  // ---------------------------------------------------------------------------
  // Check 1: the included first one takes no points, the next takes 200
  // ---------------------------------------------------------------------------

  describe('check 1: the first Voice Intro a tier includes takes no points, the next takes the plan figure', () => {
    it('makes the first for a person with a tier without taking a point, then holds and keeps the points for the next', async () => {
      await h.giveTier(PLAIN, true);
      await h.grant(PLAIN, COST * 2);
      await h.prepare(PLAIN);
      const before = data<VoiceIntroView>(
        await h.as(PLAIN, 'get', '/me/voice-intro'),
      );
      expect(before.next).toEqual({ free: true, costPoints: 0 });
      expect(before.canGenerate).toBe(true);

      const calls = h.standin.state.calls;
      const k1 = key();
      const res = await generate(PLAIN, k1);
      expect(res.status).toBe(202);
      const started = data<VoiceIntroView>(res);
      expect(started.run).toMatchObject({
        state: 'working',
        costPoints: 0,
        included: true,
        message: null,
      });
      // The included place is spent and no points were held.
      expect(await includedOf(PLAIN)).toBe(false);
      expect(await holdsOf(PLAIN)).toHaveLength(0);

      const done = await h.finish(PLAIN);
      expect(done.run).toMatchObject({
        state: 'done',
        costPoints: 0,
        included: true,
      });
      expect(done.aiVoice).toBe(true);
      expect(done.audioUrl).toBe(
        `${FILES_BASE}${introAudioKey(PLAIN, runIdFor(PLAIN, k1))}`,
      );
      expect(h.standin.state.calls).toBeGreaterThanOrEqual(calls + 1);
      expect(
        h.files.audio.get(introAudioKey(PLAIN, runIdFor(PLAIN, k1)))!.length,
      ).toBeGreaterThan(0);
      expect(await h.balance(PLAIN)).toBe(COST * 2);
      // The provider keeps no copy of the voice.
      expect(h.standin.openClones()).toBe(0);
      expect(h.standin.state.deleted).toBe(h.standin.state.cloned);
      // The words are not in the run.
      expect(JSON.stringify(await runsOf(PLAIN))).not.toContain(
        'bright things',
      );
      expect(done.next).toEqual({ free: false, costPoints: COST });

      // The next one holds the plan's points, then keeps them.
      const k2 = key();
      const second = await generate(PLAIN, k2);
      expect(second.status).toBe(202);
      expect(data<VoiceIntroView>(second).run).toMatchObject({
        costPoints: COST,
        included: false,
      });
      const [hold] = await holdsOf(PLAIN);
      expect(hold).toMatchObject({
        purpose: 'ai_job',
        quantity: COST,
        title: 'Voice Intro',
      });
      expect(['held', 'committed']).toContain(hold.state);
      const finished = await h.finish(PLAIN);
      expect(finished.run).toMatchObject({ state: 'done', costPoints: COST });
      expect((await holdsOf(PLAIN))[0].state).toBe('committed');
      expect(await h.balance(PLAIN)).toBe(COST);
      // The new audio is the person's Voice Intro; the earlier file is gone.
      expect(finished.audioUrl).toContain(runIdFor(PLAIN, k2));
      await h.runs.drain();
      expect(h.files.removed).toContain(
        introAudioKey(PLAIN, runIdFor(PLAIN, k1)),
      );
    });

    it('takes the price from the settings (R-65), and a person with no tier pays the points from the start', async () => {
      await set('points.action.voice_intro', COST + 50);
      await h.grant(PLAIN, COST + 50);
      await h.prepare(PLAIN);
      expect(
        data<VoiceIntroView>(await h.as(PLAIN, 'get', '/me/voice-intro')).next,
      ).toEqual({
        free: false,
        costPoints: COST + 50,
      });
      expect((await generate()).status).toBe(202);
      const done = await h.finish(PLAIN);
      expect(done.run).toMatchObject({
        state: 'done',
        costPoints: COST + 50,
        included: false,
      });
      expect(await h.balance(PLAIN)).toBe(0);
    });

    it('refuses a short balance with nothing taken, and an ended tier does not give the included one', async () => {
      await h.giveTier(PLAIN, true);
      await h.prisma.makerTier.update({
        where: { wawuUserId: PLAIN },
        data: { activeUntil: new Date(Date.now() - 1000) },
      });
      await h.prepare(PLAIN);
      expect(
        data<VoiceIntroView>(await h.as(PLAIN, 'get', '/me/voice-intro')).next
          .free,
      ).toBe(false);
      const res = await generate();
      expect(res.status).toBe(402);
      expect(reasonOf(res).code).toBe('insufficient_points');
      expect(await runsOf(PLAIN)).toHaveLength(0);
      expect(await holdsOf(PLAIN)).toHaveLength(0);
    });

    it('answers the first try again for the same Idempotency-Key and takes nothing more; needs a key', async () => {
      await h.grant(PLAIN, COST * 3);
      await h.prepare(PLAIN);
      expect(reasonOf(await generate(PLAIN, null)).code).toBe(
        'idempotency_key_required',
      );
      expect(reasonOf(await generate(PLAIN, 'short')).code).toBe(
        'idempotency_key_required',
      );
      const k = key();
      const first = await generate(PLAIN, k);
      expect(first.status).toBe(202);
      const again = await generate(PLAIN, k);
      expect(again.status).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(data<VoiceIntroView>(again).run!.id).toBe(
        data<VoiceIntroView>(first).run!.id,
      );
      await h.finish(PLAIN);
      const later = await generate(PLAIN, k);
      expect(later.status).toBe(200);
      expect(await runsOf(PLAIN)).toHaveLength(1);
      expect(await holdsOf(PLAIN)).toHaveLength(1);
      expect(await h.balance(PLAIN)).toBe(COST * 2);
    });

    it('lets one try run at a time: two at once spend the included one once and take no second hold', async () => {
      await h.giveTier(PLAIN, true);
      await h.grant(PLAIN, COST * 2);
      await h.prepare(PLAIN, 'Hello there. [[slow:600]]');
      const [a, b] = await Promise.all([generate(PLAIN), generate(PLAIN)]);
      const codes = [a.status, b.status].sort();
      expect(codes).toEqual([202, 409]);
      const refused = a.status === 409 ? a : b;
      expect(reasonOf(refused).code).toBe('voice_intro_busy');
      await h.finish(PLAIN);
      expect(await runsOf(PLAIN)).toHaveLength(1);
      // The refused try's hold was given back at once; nothing is kept.
      for (const hold of await holdsOf(PLAIN))
        expect(hold.state).toBe('released');
      expect(await h.balance(PLAIN)).toBe(COST * 2);
      // And while one is going, a try with another key is refused too.
      await h.as(PLAIN, 'put', '/me/voice-intro/text', {
        text: 'Hello again. [[slow:600]]',
      });
      expect((await generate()).status).toBe(202);
      const busy = await generate();
      expect(busy.status).toBe(409);
      expect(reasonOf(busy).code).toBe('voice_intro_busy');
      await h.finish(PLAIN);
      expect(
        (await holdsOf(PLAIN)).filter((x) => x.state === 'committed'),
      ).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Check 2: a failed generation releases every held point and says so
  // ---------------------------------------------------------------------------

  describe('check 2: a failed try takes no points and says so', () => {
    const words = 'The provider is down. [[fail]]';

    it('gives back every held point when the provider fails, in plain words', async () => {
      await h.grant(PLAIN, COST);
      await h.prepare(PLAIN, words);
      expect((await generate()).status).toBe(202);
      const done = await h.finish(PLAIN);
      expect(done.run!.state).toBe('failed');
      expect(done.run!.message).toBe(
        "That didn't work. No points were taken. Try again.",
      );
      expect(done.audioUrl).toBeNull();
      const [hold] = await holdsOf(PLAIN);
      expect(hold.state).toBe('released');
      expect(await h.balance(PLAIN)).toBe(COST);
      expect((await runsOf(PLAIN))[0]).toMatchObject({
        state: 'failed',
        failureCode: 'provider_unavailable',
        audioKey: null,
      });
      // The one-run voice was still taken out of the provider.
      expect(h.standin.openClones()).toBe(0);
    });

    it('puts the included first one back when the try fails, and gives nothing twice', async () => {
      await h.giveTier(PLAIN, true);
      await h.prepare(PLAIN, 'Refuse this. [[reject]]');
      expect((await generate()).status).toBe(202);
      const done = await h.finish(PLAIN);
      expect(done.run).toMatchObject({ state: 'failed', included: true });
      expect((await runsOf(PLAIN))[0].failureCode).toBe('provider_failed');
      expect(await includedOf(PLAIN)).toBe(true);
      expect(done.next).toEqual({ free: true, costPoints: 0 });
      // A new key tries again and it works.
      await h
        .as(PLAIN, 'put', '/me/voice-intro/text', { text: 'This one is fine.' })
        .expect(200);
      expect((await generate()).status).toBe(202);
      expect((await h.finish(PLAIN)).run!.state).toBe('done');
      expect(await includedOf(PLAIN)).toBe(false);
    });

    it("gives the points back when the person's recording is refused or cannot be read", async () => {
      await h.grant(PLAIN, COST * 2);
      await h.prepare(PLAIN, 'Hello.', Buffer.from('noise [[sample-reject]]'));
      expect((await generate()).status).toBe(202);
      expect((await h.finish(PLAIN)).run!.state).toBe('failed');
      expect((await runsOf(PLAIN))[0].failureCode).toBe('provider_failed');
      expect(await h.balance(PLAIN)).toBe(COST * 2);

      // Down at the provider while making the voice.
      const link = await h.upload(PLAIN, {
        bytes: Buffer.from('noise [[sample-fail]]'),
      });
      await h
        .as(PLAIN, 'post', '/me/voice-intro/sample', { fileUrl: link })
        .expect(200);
      expect((await generate()).status).toBe(202);
      expect((await h.finish(PLAIN)).run!.state).toBe('failed');
      expect(await h.balance(PLAIN)).toBe(COST * 2);

      // The stored file cannot be read.
      const lost = await h.upload(PLAIN);
      await h
        .as(PLAIN, 'post', '/me/voice-intro/sample', { fileUrl: lost })
        .expect(200);
      h.files.samples.delete(lost.slice(FILES_BASE.length));
      expect((await generate()).status).toBe(202);
      expect((await h.finish(PLAIN)).run!.state).toBe('failed');
      const codes = (await runsOf(PLAIN)).map((r) => r.failureCode).sort();
      expect(codes).toEqual([
        'provider_failed',
        'provider_unavailable',
        'sample_unreadable',
      ]);
      expect(await h.balance(PLAIN)).toBe(COST * 2);
      for (const hold of await holdsOf(PLAIN))
        expect(hold.state).toBe('released');
    });

    it('a finish that comes after the stale-hold sweep gave the points back is refused: the points stay back and the audio is dropped', async () => {
      await h.grant(PLAIN, COST);
      await h.prepare(PLAIN, 'A slow one. [[slow:900]]');
      expect((await generate()).status).toBe(202);
      // The sweep is global: it may also give back a hold another spec left
      // behind, so the proof is this person's own hold, not a count.
      const [own] = await holdsOf(PLAIN);
      expect(own.state).toBe('held');
      const spend = h.get<PointsSpendService>(PointsSpendService);
      await spend.releaseStale(0, new Date(Date.now() + 60_000));
      expect(
        await h.prisma.pointHold.findUnique({ where: { id: own.id } }),
      ).toMatchObject({ state: 'released', wawuUserId: PLAIN });
      await h.runs.drain();
      const view = data<VoiceIntroView>(
        await h.as(PLAIN, 'get', '/me/voice-intro'),
      );
      expect(view.run).toMatchObject({ state: 'failed' });
      expect((await runsOf(PLAIN))[0].failureCode).toBe('timed_out');
      expect(view.audioUrl).toBeNull();
      expect(h.files.audio.size).toBe(0);
      expect(await h.balance(PLAIN)).toBe(COST);
    });

    it('a slow included try given up on is not made the intro when it finishes late', async () => {
      await h.giveTier(PLAIN, true);
      await h.prepare(PLAIN, 'A slow one. [[slow:900]]');
      expect((await generate()).status).toBe(202);
      await h.prisma.voiceIntroRun.updateMany({
        where: { wawuUserId: PLAIN },
        data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
      });
      const during = data<VoiceIntroView>(
        await h.as(PLAIN, 'get', '/me/voice-intro'),
      );
      expect(during.run).toMatchObject({ state: 'failed' });
      expect(await includedOf(PLAIN)).toBe(true);
      await h.runs.drain();
      const after = data<VoiceIntroView>(
        await h.as(PLAIN, 'get', '/me/voice-intro'),
      );
      expect(after.audioUrl).toBeNull();
      expect(after.run!.state).toBe('failed');
      expect(h.files.audio.size).toBe(0);
      expect(await includedOf(PLAIN)).toBe(true);
    });

    it('gives the points back when the audio cannot be stored', async () => {
      await h.grant(PLAIN, COST);
      await h.prepare(PLAIN);
      h.files.failPut = true;
      expect((await generate()).status).toBe(202);
      expect((await h.finish(PLAIN)).run!.state).toBe('failed');
      expect((await runsOf(PLAIN))[0].failureCode).toBe('store_failed');
      expect(await h.balance(PLAIN)).toBe(COST);
    });

    it('gives up on an included try that never finished and puts the included one back', async () => {
      await h.giveTier(PLAIN, false);
      await h.prisma.voiceIntroRun.create({
        data: {
          id: randomUUID(),
          wawuUserId: PLAIN,
          idempotencyKey: key(),
          characters: 10,
          costPoints: 0,
          includedUsed: true,
          createdAt: new Date(Date.now() - 2 * 3_600_000),
        },
      });
      const view = data<VoiceIntroView>(
        await h.as(PLAIN, 'get', '/me/voice-intro'),
      );
      expect(view.run).toMatchObject({ state: 'failed' });
      expect(await includedOf(PLAIN)).toBe(true);
      // Read again: nothing is given twice.
      await h.as(PLAIN, 'get', '/me/voice-intro').expect(200);
      expect(await includedOf(PLAIN)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Check 4: the profile serves the intro with aiVoice true; a person without one serves null
  // ---------------------------------------------------------------------------

  describe('check 4: what anyone looking at a profile hears', () => {
    const looks = (viewer: string, id: string) =>
      h.as(viewer, 'get', `/users/${id}/voice-intro`);

    it('serves the intro with aiVoice true once it is made, and null before and for a person without one', async () => {
      // Nothing yet: the person is real, the intro is not.
      const none = await looks(BASIC, PLAIN);
      expect(none.status).toBe(200);
      expect(data<{ voiceIntro: null }>(none).voiceIntro).toBeNull();

      await h.giveTier(PLAIN, true);
      await h.prepare(PLAIN, 'Hello, I am Ada.');
      // Words, consent and a recording are the person's own, not public.
      expect(
        data<{ voiceIntro: null }>(await looks(BASIC, PLAIN)).voiceIntro,
      ).toBeNull();
      const k = key();
      expect((await generate(PLAIN, k)).status).toBe(202);
      await h.finish(PLAIN);

      const res = await looks(BASIC, PLAIN);
      const body = data<{ voiceIntro: { url: string; aiVoice: boolean } }>(res);
      expect(body.voiceIntro).toEqual({
        url: `${FILES_BASE}${introAudioKey(PLAIN, runIdFor(PLAIN, k))}`,
        aiVoice: true,
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /Hello, I am Ada|consent|sampleKey|voice\/sample/,
      );
      // The person sees their own the same way; someone else's stays null.
      expect(
        data<{ voiceIntro: object }>(await looks(PLAIN, PLAIN)).voiceIntro,
      ).not.toBeNull();
      expect(
        data<{ voiceIntro: null }>(await looks(PLAIN, BASIC)).voiceIntro,
      ).toBeNull();
    });

    it('answers 404 for someone who does not exist or has blocked the viewer, and 400 for a bad id', async () => {
      expect((await looks(PLAIN, randomUUID())).status).toBe(404);
      expect((await looks(PLAIN, 'not-an-id')).status).toBe(400);
      await h.prisma.blockedAccount.create({
        data: { userWawuId: BASIC, blockedWawuId: PLAIN },
      });
      try {
        expect((await looks(PLAIN, BASIC)).status).toBe(404);
        expect((await looks(BASIC, PLAIN)).status).toBe(404);
      } finally {
        await h.prisma.blockedAccount.deleteMany({
          where: { userWawuId: BASIC, blockedWawuId: PLAIN },
        });
      }
      expect((await h.http().get(`/users/${PLAIN}/voice-intro`)).status).toBe(
        401,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // What a person reads
  // ---------------------------------------------------------------------------

  it('never names the provider and never writes a long dash', async () => {
    await h.giveTier(PLAIN, true);
    await h.prepare(PLAIN);
    await generate();
    const done = await h.finish(PLAIN);
    const preview = await h.as(PLAIN, 'post', '/me/voice/name-preview', {
      name: 'Ada',
    });
    const refused = await generate();
    const text = JSON.stringify([done, preview.body, refused.body, PLAIN_LINE]);
    expect(text).not.toMatch(/eleven|stand-in|xi-api|clone/i);
    expect(text).not.toMatch(/[–—]/);
  });
});
