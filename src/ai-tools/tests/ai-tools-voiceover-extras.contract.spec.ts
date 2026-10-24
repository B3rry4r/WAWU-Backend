// Contract tests for task AITOOLS-07: VoiceOver's four undrawn parts. A sample
// of each voice, "Your voice" (the person's own voice, with its own agreement
// and a delete that drops the copy at the provider), Save to the library, and
// Use in a product (an optional media field on drafts).
//
// Real HTTP against the caller's DATABASE_URL with real RS256 tokens from
// mock-wawu-id, the real controller, job service, own-voice service, points
// service and settings, and the real HTTP voice adapter talking to the voice
// stand-in (scripts/dev/voice-standin.cjs) on this machine. NOT RUN against the
// real provider for the voice-making calls: its key is out of credits (one real
// READ of the voice list was made, see docs/elevenlabs/API-FACTS.md).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import {
  CreateProductDraftDto,
  UpdateProductDraftDto,
} from '../../content-piece/dto/product-draft.dto';
import { ProductDraftService } from '../../content-piece/product-draft.service';
import type { ContentPieceService } from '../../content-piece/content-piece.service';
import type { PublishingGate } from '../../plans/publishing-gate.service';
import { loadPlansConfig } from '../../plans/plans-config';
import type {
  AiJobPage,
  AiJobView,
  AiToolsView,
  OwnVoiceRemovedView,
  OwnVoiceView,
} from '../ai-tools-view.type';
import { ProviderCopyService } from '../voice/provider-copy.service';
import { sampleLinksFrom } from '../voice/http-voice-provider';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const voiceover = plan.actions.find((a) => a.id === 'voiceover_per_min')!;
const ONE_MINUTE = voiceover.points;
const TEXT =
  'Welcome to the pricing playbook. Here is how to put a number on your work.';

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason: { code: string; message: string } }).reason;

describe('AITOOLS-07: VoiceOver samples, your own voice, Save and Use in a product (contract)', () => {
  let h: AiHarness;
  let copies: ProviderCopyService;

  const as = (who: string) => `Bearer ${h.tokensOf[who]}`;
  const get = (who: string, path: string, query: Record<string, string> = {}) =>
    h.http().get(path).query(query).set('Authorization', as(who));
  const post = (who: string, path: string, body: object = {}) =>
    h.http().post(path).set('Authorization', as(who)).send(body);
  const del = (who: string, path: string) =>
    h.http().delete(path).set('Authorization', as(who));

  /** The person's Voice Intro recording, as the Hub holds it (the bytes carry the stand-in's markers). */
  const recordVoice = async (who: string, marker = '') => {
    const key = `voice/sample/${randomUUID()}.mp3`;
    h.voiceFiles.samples.set(key, {
      audio: Buffer.from(`a thirty second take of ${who} ${marker}`),
      contentType: 'audio/mpeg',
    });
    await h.prisma.voiceProfile.upsert({
      where: { wawuUserId: who },
      create: { wawuUserId: who, sampleKey: key, sampleAt: new Date() },
      update: { sampleKey: key, sampleAt: new Date() },
    });
  };
  const ownView = async (who: string) =>
    data<OwnVoiceView>(await get(who, '/ai-tools/own-voice'));
  const agree = async (who: string) => {
    const view = await ownView(who);
    return post(who, '/ai-tools/own-voice/consent', {
      line: view.consent.line,
    });
  };
  const run = async (who: string, voiceId: string, text = TEXT) => {
    const res = await h.create(who, {
      text,
      voiceId,
      quoteToken: h.quote(who, ONE_MINUTE),
    });
    return res;
  };
  const runAndFinish = async (who: string, voiceId: string, text = TEXT) => {
    const res = await run(who, voiceId, text);
    expect(res.status).toBe(202);
    return (await h.finish(
      who,
      data<AiJobView>(res).id,
    )) as unknown as AiJobView;
  };
  /** The stand-in's counters when the test began (they run on across the file). */
  let at = { cloned: 0, deleted: 0, refused: 0, spoken: 0 };
  const since = () => ({
    cloned: h.standin.state.cloned - at.cloned,
    deleted: h.standin.state.deleted - at.deleted,
    refused: h.standin.state.removeRefused - at.refused,
  });
  const lastClone = () => h.standin.state.clones.at(-1);
  const jobRow = (id: string) =>
    h.prisma.aiToolJob.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    h = await bootAiTools();
    copies = h.get<ProviderCopyService>(ProviderCopyService);
    // No background tries in these specs: a retry is shown by calling the sweep.
    copies.delaysMs = [];
  });
  afterAll(async () => {
    await h.clean();
    await h.close();
  });
  beforeEach(async () => {
    await h.clean();
    h.store.files.clear();
    h.store.removed.length = 0;
    h.store.failPut = false;
    h.voiceFiles.samples.clear();
    h.standin.releaseStubborn();
    at = {
      cloned: h.standin.state.cloned,
      deleted: h.standin.state.deleted,
      refused: h.standin.state.removeRefused,
      spoken: h.standin.state.voices.length,
    };
    await h.grant(PLAIN, ONE_MINUTE * 10);
    await h.grant(BASIC, ONE_MINUTE * 10);
  });

  // ---------------------------------------------------------------------------
  // G-POINTS-08-1: a sample of each voice
  // ---------------------------------------------------------------------------

  it('check 1: GET /ai-tools gives each listed voice a link to a sample that plays, and nothing that names the provider', async () => {
    const view = data<AiToolsView>(await get(PLAIN, '/ai-tools'));
    const voices = view.tools[0].voices;
    expect(voices.map((v) => v.id)).toEqual(['ada', 'tunde']);
    for (const v of voices)
      expect(v.sampleUrl).toBe(`/api/hub/ai-tools/voices/${v.id}/sample`);
    // The sample plays from the Hub itself, with no token (a web player cannot send one).
    const played = await h
      .http()
      .get(voices[0].sampleUrl!.replace('/api/hub', ''));
    expect(played.status).toBe(200);
    expect(played.headers['content-type']).toBe('audio/mpeg');
    expect(played.headers['cache-control']).toBe('public, max-age=3600');
    // Helmet's default (same-origin) would block a web player on another address; the sample says any page may play it.
    expect(played.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Number(played.headers['content-length'])).toBeGreaterThan(0);
    // A voice that is not listed is a 404.
    expect((await h.http().get('/ai-tools/voices/nobody/sample')).status).toBe(
      404,
    );
    // Quick voice lists the same voices with the same samples.
    expect(view.tools[1].voices[0].sampleUrl).toBe(voices[0].sampleUrl);
    // The provider is asked once, not once per catalogue read.
    const reads = h.standin.state.voiceListReads;
    await get(PLAIN, '/ai-tools');
    await get(BASIC, '/ai-tools');
    expect(h.standin.state.voiceListReads).toBe(reads);
    expect(JSON.stringify(view)).not.toMatch(
      /eleven|stand-in|xi-api|googleapis|127\.0\.0\.1/i,
    );
  });

  it('check 1b: a voice the provider gives no https link for has no sample (the real answer shape, 24 Oct 2026)', () => {
    const catalogue = [
      { id: 'ada', providerVoiceId: 'v-ada' },
      { id: 'tunde', providerVoiceId: 'v-tunde' },
      { id: 'zed', providerVoiceId: 'v-zed' },
    ];
    const links = sampleLinksFrom(
      {
        voices: [
          {
            voice_id: 'v-ada',
            name: 'Ada',
            category: 'premade',
            preview_url: 'https://storage.googleapis.com/x/ada.mp3',
          },
          { voice_id: 'v-tunde', preview_url: 'http://insecure.test/t.mp3' },
          { voice_id: 'v-zed' },
          { voice_id: 'v-other', preview_url: 'https://x.test/o.mp3' },
        ],
      },
      catalogue,
    );
    expect([...links.entries()]).toEqual([
      ['ada', 'https://storage.googleapis.com/x/ada.mp3'],
    ]);
    expect(sampleLinksFrom({ voices: 'nope' }, catalogue).size).toBe(0);
    expect(sampleLinksFrom(null, catalogue).size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // G-AITOOLS-01-1: your own voice
  // ---------------------------------------------------------------------------

  it('check 2: "Your voice" is not offered without a Voice Intro recording, and a job naming it is refused with nothing held', async () => {
    const before = await ownView(PLAIN);
    expect(before).toMatchObject({
      available: true,
      hasRecording: false,
      ready: false,
      consent: { given: false, at: null },
    });
    expect(before.consent.line).toMatch(
      /^I am .+\. I agree that Who Made This\? may create an AI version of my voice for my VoiceOver\.$/,
    );
    expect(before.consent.line).not.toMatch(/—|eleven/i);
    const asked = await agree(PLAIN);
    expect(asked.status).toBe(409);
    expect(reasonOf(asked).code).toBe('own_voice_recording_required');

    const refused = await run(PLAIN, 'own');
    expect(refused.status).toBe(409);
    expect(reasonOf(refused).code).toBe('own_voice_recording_required');
    expect(
      await h.prisma.aiToolJob.count({ where: { wawuUserId: PLAIN } }),
    ).toBe(0);
    expect(await h.balance(PLAIN)).toBe(ONE_MINUTE * 10);
    expect(since().cloned).toBe(0);
  });

  it('check 3: with a recording but no agreement, a job in "Your voice" is refused; the agreement must be the words the Hub served', async () => {
    await recordVoice(PLAIN);
    const view = await ownView(PLAIN);
    expect(view).toMatchObject({ hasRecording: true, ready: false });

    const refused = await run(PLAIN, 'own');
    expect(refused.status).toBe(409);
    expect(reasonOf(refused).code).toBe('own_voice_consent_required');
    expect(await h.balance(PLAIN)).toBe(ONE_MINUTE * 10);

    const wrong = await post(PLAIN, '/ai-tools/own-voice/consent', {
      line: `${view.consent.line} And anything else.`,
    });
    expect(wrong.status).toBe(409);
    expect(reasonOf(wrong).code).toBe('own_voice_consent_line_changed');
    expect((await ownView(PLAIN)).consent.given).toBe(false);

    const agreed = await agree(PLAIN);
    expect(agreed.status).toBe(200);
    const after = data<OwnVoiceView>(agreed);
    expect(after).toMatchObject({ ready: true, consent: { given: true } });
    expect(after.consent.at).not.toBeNull();
    // The agreement is stored exactly, with its time, apart from the Voice Intro's own.
    const row = await h.prisma.voiceProfile.findUniqueOrThrow({
      where: { wawuUserId: PLAIN },
    });
    expect(row.ownVoiceConsentLine).toBe(view.consent.line);
    expect(row.ownVoiceConsentAt).not.toBeNull();
    expect(row.consentAt).toBeNull();
  });

  it('check 4: a VoiceOver in your own voice is made from YOUR recording, the voice is removed at the provider, and the points are kept', async () => {
    await recordVoice(PLAIN);
    await recordVoice(BASIC, '[[sample-fail]]');
    await agree(PLAIN);
    await agree(BASIC);

    const job = await runAndFinish(PLAIN, 'own');
    expect(job).toMatchObject({
      state: 'done',
      voiceId: 'own',
      costPoints: ONE_MINUTE,
      saved: false,
    });
    expect(job.audioUrl).toMatch(/^https:\/\/audio\.example\.test\//);
    expect(await h.balance(PLAIN)).toBe(ONE_MINUTE * 9);
    // One voice made from the sample, one speech call with it, and the voice dropped.
    expect(since()).toMatchObject({ cloned: 1, deleted: 1 });
    expect(h.standin.openClones()).toBe(0);
    expect(h.standin.state.voices.at(-1)).toBe(lastClone());
    expect((await jobRow(job.id)).providerRef).toBeNull();

    // Each person's job uses their own recording: BASIC's carries the stand-in's
    // "refuse this sample" marker and fails, PLAIN's did not and was not touched.
    const other = await runAndFinish(BASIC, 'own');
    expect(other.state).toBe('failed');
    expect(other.message).toMatch(/No points were taken/);
    expect(await h.balance(BASIC)).toBe(ONE_MINUTE * 10);
    expect(h.standin.openClones()).toBe(0);

    // The listed voices still work and need no agreement.
    const plain = await runAndFinish(BASIC, 'ada');
    expect(plain.state).toBe('done');
  });

  it('check 5: "own" is only for VoiceOver, and an unknown voice is still refused', async () => {
    await recordVoice(PLAIN);
    await agree(PLAIN);
    const unknown = await run(PLAIN, 'nobody');
    expect(unknown.status).toBe(400);
    expect(reasonOf(unknown).code).toBe('ai_voice_unknown');

    const quick = await h
      .http()
      .post('/ai-tools/quick-voice/jobs')
      .set('Authorization', as(PLAIN))
      .set('Idempotency-Key', randomUUID())
      .send({
        text: TEXT,
        voiceId: 'own',
        quoteToken: h.tokens.issue(
          PLAIN,
          'quick_voice_per_min',
          plan.actions.find((a) => a.id === 'quick_voice_per_min')!.points,
        ),
      });
    expect(quick.status).toBe(400);
    expect(reasonOf(quick).code).toBe('ai_voice_unknown');
    expect(since().cloned).toBe(0);
  });

  it('check 6: the delete takes the agreement back and drops a voice the provider could not drop at first; the sweep drops it too', async () => {
    await recordVoice(PLAIN, '[[remove-fail]]');
    await agree(PLAIN);

    // The provider is down when the Hub drops the voice: the job is done, the voice is still there and noted.
    const job = await runAndFinish(PLAIN, 'own');
    expect(job.state).toBe('done');
    expect(h.standin.openClones()).toBe(1);
    expect(since().refused).toBeGreaterThan(0);
    expect((await jobRow(job.id)).providerRef).toBe(`voice:${lastClone()}`);

    // Delete while the provider still refuses: the agreement is gone at once, the copy is pending.
    const first = await del(PLAIN, '/ai-tools/own-voice');
    expect(first.status).toBe(200);
    const pending = data<OwnVoiceRemovedView>(first);
    expect(pending.atProvider).toBe('pending');
    expect(pending.own).toMatchObject({
      ready: false,
      consent: { given: false },
    });
    expect(h.standin.openClones()).toBe(1);
    // Nothing new can be made from the recording any more.
    const refused = await run(PLAIN, 'own');
    expect(refused.status).toBe(409);
    expect(reasonOf(refused).code).toBe('own_voice_consent_required');
    expect(since().cloned).toBe(1);

    // The provider is back: the delete drops it and says so.
    h.standin.releaseStubborn();
    const second = data<OwnVoiceRemovedView>(
      await del(PLAIN, '/ai-tools/own-voice'),
    );
    expect(second.atProvider).toBe('gone');
    expect(h.standin.openClones()).toBe(0);
    expect((await jobRow(job.id)).providerRef).toBeNull();
    // The Voice Intro's recording stays: only the agreement for VoiceOver went.
    expect((await ownView(PLAIN)).hasRecording).toBe(true);
    // A delete with nothing to drop is fine, and says gone.
    expect(
      data<OwnVoiceRemovedView>(await del(PLAIN, '/ai-tools/own-voice'))
        .atProvider,
    ).toBe('gone');
  });

  it('check 7: without anyone calling the delete, the per-minute sweep drops a voice the provider could not drop', async () => {
    await recordVoice(PLAIN, '[[remove-fail]]');
    await agree(PLAIN);
    const job = await runAndFinish(PLAIN, 'own');
    expect(h.standin.openClones()).toBe(1);
    expect((await jobRow(job.id)).providerRef).toBe(`voice:${lastClone()}`);

    const still = await copies.sweep(new Date(Date.now() + 120_000));
    expect(still).toEqual({ cleared: 0, pending: 1 });
    expect(h.standin.openClones()).toBe(1);
    h.standin.releaseStubborn();
    const done = await copies.sweep(new Date(Date.now() + 120_000));
    expect(done).toEqual({ cleared: 1, pending: 0 });
    expect(h.standin.openClones()).toBe(0);
    expect((await jobRow(job.id)).providerRef).toBeNull();
  });

  it('check 8: a job that fails after its voice was made still removes the voice and gives every point back', async () => {
    await recordVoice(PLAIN);
    await agree(PLAIN);
    const failed = await runAndFinish(PLAIN, 'own', `${TEXT} [[fail]]`);
    expect(failed.state).toBe('failed');
    expect(await h.balance(PLAIN)).toBe(ONE_MINUTE * 10);
    expect(since().cloned).toBe(1);
    expect(h.standin.openClones()).toBe(0);
    expect((await jobRow(failed.id)).providerRef).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // G-AITOOLS-01-4: Save to the library
  // ---------------------------------------------------------------------------

  it("check 9: a finished result can be saved and taken out again; another person's result, and one not finished, cannot", async () => {
    const job = await runAndFinish(PLAIN, 'ada');
    expect(job.saved).toBe(false);

    const saved = await post(PLAIN, `/ai-tools/jobs/${job.id}/save`);
    expect(saved.status).toBe(200);
    expect(data<AiJobView>(saved)).toMatchObject({
      id: job.id,
      saved: true,
      state: 'done',
    });
    const firstAt = (await jobRow(job.id)).savedAt;
    expect(firstAt).not.toBeNull();
    // Saving twice keeps the first time.
    await post(PLAIN, `/ai-tools/jobs/${job.id}/save`);
    expect((await jobRow(job.id)).savedAt).toEqual(firstAt);

    // It reads as saved, and the saved list holds only saved results.
    const second = await runAndFinish(PLAIN, 'tunde');
    const all = data<AiJobPage>(await get(PLAIN, '/ai-tools/jobs'));
    expect(all.items.map((j) => [j.id, j.saved])).toEqual([
      [second.id, false],
      [job.id, true],
    ]);
    const onlySaved = data<AiJobPage>(
      await get(PLAIN, '/ai-tools/jobs', { saved: 'true' }),
    );
    expect(onlySaved.items.map((j) => j.id)).toEqual([job.id]);
    const bad = await get(PLAIN, '/ai-tools/jobs', { saved: 'maybe' });
    expect(bad.status).toBe(400);

    // Another person's result is not found, whether saving or taking out.
    expect((await post(BASIC, `/ai-tools/jobs/${job.id}/save`)).status).toBe(
      404,
    );
    expect((await del(BASIC, `/ai-tools/jobs/${job.id}/save`)).status).toBe(
      404,
    );
    expect((await jobRow(job.id)).savedAt).toEqual(firstAt);

    // A result that failed (or is still working) cannot be saved.
    const failed = await runAndFinish(PLAIN, 'ada', `${TEXT} [[fail]]`);
    expect(failed.state).toBe('failed');
    const refused = await post(PLAIN, `/ai-tools/jobs/${failed.id}/save`);
    expect(refused.status).toBe(409);
    expect(reasonOf(refused).code).toBe('job_not_ready');

    // Taking it out keeps the result itself.
    const out = await del(PLAIN, `/ai-tools/jobs/${job.id}/save`);
    expect(out.status).toBe(200);
    expect(data<AiJobView>(out)).toMatchObject({ saved: false, state: 'done' });
    expect(data<AiJobView>(out).audioUrl).toMatch(
      /^https:\/\/audio\.example\.test\//,
    );
    expect(
      data<AiJobPage>(await get(PLAIN, '/ai-tools/jobs', { saved: 'true' }))
        .items,
    ).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // G-POINTS-08-2: Use in a product (the optional media field on drafts)
  // ---------------------------------------------------------------------------

  describe('Use in a product', () => {
    let drafts: ProductDraftService;
    beforeAll(() => {
      drafts = new ProductDraftService(
        h.prisma,
        null as unknown as ContentPieceService,
        null as unknown as PublishingGate,
      );
    });

    it('check 10: a finished result of your own attaches to a draft and detaches again; a draft without it is as before', async () => {
      const plain = await drafts.create(PLAIN, { title: 'My course' });
      expect(plain.mediaJobId).toBeNull();

      const job = await runAndFinish(PLAIN, 'ada');
      const made = await drafts.create(PLAIN, {
        title: 'Intro',
        mediaJobId: job.id,
      });
      expect(made.mediaJobId).toBe(job.id);
      const moved = await drafts.update(PLAIN, plain.id, {
        mediaJobId: job.id,
      });
      expect(moved).toMatchObject({
        id: plain.id,
        title: 'My course',
        mediaJobId: job.id,
      });
      expect((await drafts.get(PLAIN, plain.id)).mediaJobId).toBe(job.id);
      // Changing something else leaves the media alone; null detaches.
      expect(
        (await drafts.update(PLAIN, plain.id, { title: 'My course 2' }))
          .mediaJobId,
      ).toBe(job.id);
      expect(
        (await drafts.update(PLAIN, plain.id, { mediaJobId: null })).mediaJobId,
      ).toBeNull();
      expect(
        (await drafts.list(PLAIN)).map((d) => d.mediaJobId).sort(),
      ).toEqual([job.id, null].sort());
    });

    it("check 11: another person's result, one that does not exist, and one that is not finished cannot be attached", async () => {
      const mine = await runAndFinish(PLAIN, 'ada');
      const draft = await drafts.create(BASIC, { title: 'Theirs' });
      await expect(
        drafts.update(BASIC, draft.id, { mediaJobId: mine.id }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        drafts.create(BASIC, { title: 'X', mediaJobId: randomUUID() }),
      ).rejects.toBeInstanceOf(NotFoundException);
      const failed = await runAndFinish(BASIC, 'ada', `${TEXT} [[fail]]`);
      await expect(
        drafts.update(BASIC, draft.id, { mediaJobId: failed.id }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await drafts.get(BASIC, draft.id)).mediaJobId).toBeNull();
    });

    it('check 12: the field is optional and checked as an id', async () => {
      const ok = await validate(
        plainToInstance(UpdateProductDraftDto, { mediaJobId: null }),
      );
      expect(ok).toEqual([]);
      const some = await validate(
        plainToInstance(UpdateProductDraftDto, { title: 'x' }),
      );
      expect(some).toEqual([]);
      const bad = await validate(
        plainToInstance(CreateProductDraftDto, {
          title: 'x',
          mediaJobId: 'not-an-id',
        }),
      );
      expect(bad.map((e) => e.property)).toEqual(['mediaJobId']);
    });
  });

  // ---------------------------------------------------------------------------
  // The migration
  // ---------------------------------------------------------------------------

  describe('the migration 20261105100000_ai_tools_voiceover_extras', () => {
    const folder = join(
      __dirname,
      '../../../prisma/migrations/20261105100000_ai_tools_voiceover_extras',
    );
    const script = (file: string) =>
      readFileSync(join(folder, file), 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('\\'))
        .join('\n');
    type Tx = Parameters<Parameters<AiHarness['prisma']['$transaction']>[0]>[0];
    async function inRolledBackTx<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
      class Done extends Error {}
      let out!: T;
      try {
        await h.prisma.$transaction(async (tx) => {
          out = await body(tx);
          throw new Done();
        });
      } catch (e) {
        if (!(e instanceof Done)) throw e;
      }
      return out;
    }
    const columns = async (tx: Tx) =>
      (
        await tx.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE (table_name = 'AiToolJob' AND column_name = 'savedAt')
               OR (table_name = 'VoiceProfile' AND column_name IN ('ownVoiceConsentAt','ownVoiceConsentLine'))
               OR (table_name = 'ProductDraft' AND column_name = 'mediaJobId')
            ORDER BY table_name, column_name`,
        )
      ).map((r) => `${r.table_name}.${r.column_name}`);
    const FOUR = [
      'AiToolJob.savedAt',
      'ProductDraft.mediaJobId',
      'VoiceProfile.ownVoiceConsentAt',
      'VoiceProfile.ownVoiceConsentLine',
    ];

    it('check 13: it adds four nullable columns; the rollback drops them and keeps every row, and applies again', async () => {
      const who = `ait07-mig-${randomUUID()}`;
      await inRolledBackTx(async (tx) => {
        expect(await columns(tx)).toEqual(FOUR);
        await tx.$executeRawUnsafe(
          `INSERT INTO "VoiceProfile" ("wawuUserId","updatedAt") VALUES ('${who}', now())`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "ProductDraft" ("id","wawuUserId","title","updatedAt") VALUES ('${randomUUID()}','${who}','kept', now())`,
        );
        await tx.$executeRawUnsafe(script('rollback.sql'));
        expect(await columns(tx)).toEqual([]);
        expect(
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "ProductDraft" WHERE "wawuUserId" = '${who}'`,
          ),
        ).toEqual([{ n: 1n }]);
        await tx.$executeRawUnsafe(script('migration.sql'));
        expect(await columns(tx)).toEqual(FOUR);
      });
    });

    it.each([
      [
        'a saved result',
        `UPDATE "AiToolJob" SET "savedAt" = now() WHERE "id" = $1`,
        'job',
      ],
      [
        'an own-voice agreement',
        `UPDATE "VoiceProfile" SET "ownVoiceConsentAt" = now() WHERE "wawuUserId" = $1`,
        'profile',
      ],
      [
        'a draft that uses a result',
        `UPDATE "ProductDraft" SET "mediaJobId" = 'x' WHERE "id" = $1`,
        'draft',
      ],
    ])(
      'check 14: the rollback refuses while %s exists and changes nothing',
      async (_name, update, kind) => {
        const who = `ait07-mig-${randomUUID()}`;
        const ids = { job: randomUUID(), draft: randomUUID(), profile: who };
        await inRolledBackTx(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "AiToolJob" ("id","wawuUserId","tool","idempotencyKey","requestHash","voiceId","characters","units","costPoints")
           VALUES ('${ids.job}','${who}','voiceover_per_min','k-${randomUUID()}','${'a'.repeat(64)}','ada',10,1,250)`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "VoiceProfile" ("wawuUserId","updatedAt") VALUES ('${who}', now())`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "ProductDraft" ("id","wawuUserId","title","updatedAt") VALUES ('${ids.draft}','${who}','d', now())`,
          );
          await tx.$executeRawUnsafe(
            update.replace('$1', `'${ids[kind as keyof typeof ids]}'`),
          );
          await tx.$executeRawUnsafe('SAVEPOINT before_rollback');
          await expect(
            tx.$executeRawUnsafe(script('rollback.sql')),
          ).rejects.toThrow(/AITOOLS-07 rollback/);
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT before_rollback');
          expect(await columns(tx)).toEqual(FOUR);
        });
      },
    );
  });
});
