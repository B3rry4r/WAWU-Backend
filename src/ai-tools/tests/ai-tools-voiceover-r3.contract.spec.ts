// AITOOLS-07 round 3 (verifier round 1 findings):
//  1. the data export holds the agreement for VoiceOver in the person's own
//     voice, the time a result was saved and the result a draft uses;
//  2. account deletion removes a voice copy the provider still holds, before the
//     job rows that note it go, and waits (keeping the note) while the provider
//     refuses;
//  3. `noteCopy` says false when the note was not written, and the voice is then
//     not handed over unnoted; `?saved=false` lists only the unsaved results.
//
// Real HTTP against the caller's DATABASE_URL with real RS256 tokens from
// mock-wawu-id, the real services, and the real HTTP voice adapter talking to the
// voice stand-in (scripts/dev/voice-standin.cjs) on this machine. The real
// provider is not called.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { ProductDraftService } from '../../content-piece/product-draft.service';
import { EXPORT_SECTIONS } from '../../data-export-request/data-export-sections';
import { loadPlansConfig } from '../../plans/plans-config';
import type { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AiJobPage, AiJobView, OwnVoiceView } from '../ai-tools-view.type';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
} from '../voice/ai-voice-provider';
import { ProviderCopyService } from '../voice/provider-copy.service';
import {
  bootAiTools,
  type AiHarness,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const voiceover = plan.actions.find((a) => a.id === 'voiceover_per_min')!;
const ONE_MINUTE = voiceover.points;
const TEXT =
  'Welcome to the pricing playbook. Here is how to put a number on your work.';
const NOTE_PREFIX = 'voice:';

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

describe('AITOOLS-07 round 3: export, account deletion and the two lows (contract)', () => {
  let h: AiHarness;
  let copies: ProviderCopyService;
  let purge: AccountPurgeService;
  let provider: AiVoiceProvider;
  /** People made up for the purge checks (no token, no points): removed after. */
  const ghosts: string[] = [];

  const as = (who: string) => `Bearer ${h.tokensOf[who]}`;
  const get = (who: string, path: string, query: Record<string, string> = {}) =>
    h.http().get(path).query(query).set('Authorization', as(who));
  const post = (who: string, path: string, body: object = {}) =>
    h.http().post(path).set('Authorization', as(who)).send(body);
  const jobRow = (id: string) =>
    h.prisma.aiToolJob.findUniqueOrThrow({ where: { id } });
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
  const agree = async (who: string) => {
    const view = data<OwnVoiceView>(await get(who, '/ai-tools/own-voice'));
    return post(who, '/ai-tools/own-voice/consent', {
      line: view.consent.line,
    });
  };
  const runAndFinish = async (who: string, voiceId: string, text = TEXT) => {
    const res = await h.create(who, {
      text,
      voiceId,
      quoteToken: h.quote(who, ONE_MINUTE),
    });
    expect(res.status).toBe(202);
    return (await h.finish(
      who,
      data<AiJobView>(res).id,
    )) as unknown as AiJobView;
  };
  let at = { cloned: 0, deleted: 0 };
  const since = () => ({
    cloned: h.standin.state.cloned - at.cloned,
    deleted: h.standin.state.deleted - at.deleted,
  });

  /**
   * A person (not signed in) whose finished VoiceOver in their own voice left a
   * copy at the provider that is noted on the job, as a provider that was down
   * when the job ended leaves it. `marker` in the recording makes the provider
   * refuse to delete it until `releaseStubborn()`.
   */
  const personWithNotedClone = async (marker = '') => {
    const who = randomUUID();
    ghosts.push(who);
    const job = await h.prisma.aiToolJob.create({
      data: {
        wawuUserId: who,
        tool: 'voiceover_per_min',
        idempotencyKey: randomUUID(),
        requestHash: 'x',
        voiceId: 'own',
        characters: 10,
        units: 1,
        costPoints: ONE_MINUTE,
        state: 'done',
        finishedAt: new Date(),
      },
    });
    await h.prisma.voiceProfile.create({
      data: {
        wawuUserId: who,
        sampleKey: `voice/sample/${randomUUID()}.mp3`,
        sampleAt: new Date(),
        ownVoiceConsentAt: new Date(),
        ownVoiceConsentLine: 'I agree.',
      },
    });
    let made = '';
    await provider.speakInOwnVoice(
      {
        sample: {
          audio: Buffer.from(`a take ${marker}`),
          contentType: 'audio/mpeg',
        },
        text: 'Hello.',
      },
      {
        // The Hub notes the voice on the job and takes over its removal.
        handOver: async (id) => {
          made = id;
          return copies.note(job.id, { kind: 'voice', id });
        },
      },
    );
    return { who, job, made };
  };

  beforeAll(async () => {
    h = await bootAiTools();
    copies = h.get<ProviderCopyService>(ProviderCopyService);
    purge = h.get<AccountPurgeService>(AccountPurgeService);
    provider = h.get<AiVoiceProvider>(AI_VOICE_PROVIDER);
    // No background tries in these specs: a retry is shown by calling the purge again.
    copies.delaysMs = [];
  });
  afterAll(async () => {
    for (const who of ghosts) {
      await h.prisma.aiToolJob.deleteMany({ where: { wawuUserId: who } });
      await h.prisma.voiceProfile.deleteMany({ where: { wawuUserId: who } });
      await h.prisma.productDraft.deleteMany({ where: { wawuUserId: who } });
    }
    await h.clean();
    await h.close();
  });
  beforeEach(async () => {
    await h.clean();
    h.store.files.clear();
    h.store.removed.length = 0;
    h.voiceFiles.samples.clear();
    h.standin.releaseStubborn();
    at = {
      cloned: h.standin.state.cloned,
      deleted: h.standin.state.deleted,
    };
    await h.grant(PLAIN, ONE_MINUTE * 10);
  });

  // ---------------------------------------------------------------------------
  // 1. The data export
  // ---------------------------------------------------------------------------

  it('export: the agreement for VoiceOver (when and its words), the time a result was saved and the result a draft uses are in the export', async () => {
    await recordVoice(PLAIN);
    expect((await agree(PLAIN)).status).toBe(200);
    const job = await runAndFinish(PLAIN, 'ada');
    expect((await post(PLAIN, `/ai-tools/jobs/${job.id}/save`)).status).toBe(
      200,
    );
    await h.prisma.productDraft.create({
      data: { wawuUserId: PLAIN, title: 'Intro', mediaJobId: job.id },
    });

    const section = (key: string) => {
      const s = EXPORT_SECTIONS.find((x) => x.key === key);
      if (!s) throw new Error(`no export section ${key}`);
      return s.load(h.prisma, PLAIN);
    };
    const voice = (await section('voiceProfile')) as Record<string, unknown>;
    const profile = await h.prisma.voiceProfile.findUniqueOrThrow({
      where: { wawuUserId: PLAIN },
    });
    expect(profile.ownVoiceConsentAt).not.toBeNull();
    expect(voice.ownVoiceConsentAt).toEqual(profile.ownVoiceConsentAt);
    expect(voice.ownVoiceConsentLine).toBe(profile.ownVoiceConsentLine);
    expect(String(voice.ownVoiceConsentLine)).toContain('VoiceOver');
    // The recording's file key is still not exported.
    expect(voice).not.toHaveProperty('sampleKey');

    const jobs = (await section('aiToolJobs')) as Record<string, unknown>[];
    const saved = (await jobRow(job.id)).savedAt;
    expect(saved).not.toBeNull();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].savedAt).toEqual(saved);
    // The provider's note and the audio's key are still not exported.
    expect(jobs[0]).not.toHaveProperty('providerRef');
    expect(jobs[0]).not.toHaveProperty('audioKey');

    const drafts = (await section('productDrafts')) as Record<
      string,
      unknown
    >[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0].mediaJobId).toBe(job.id);
  });

  // ---------------------------------------------------------------------------
  // 2. Account deletion and a voice the provider still holds
  // ---------------------------------------------------------------------------

  it('purge: a voice copy noted on a job is dropped at the provider before the rows go; the stand-in is empty after', async () => {
    const { who, job, made } = await personWithNotedClone();
    expect(made).not.toBe('');
    expect(h.standin.openClones()).toBe(1);
    expect((await jobRow(job.id)).providerRef).toBe(`${NOTE_PREFIX}${made}`);

    const out = await purge.purge(who);

    expect(h.standin.openClones()).toBe(0);
    expect(since().deleted).toBe(1);
    expect(out.failed).toEqual([]);
    expect(await h.prisma.aiToolJob.count({ where: { wawuUserId: who } })).toBe(
      0,
    );
    expect(
      await h.prisma.voiceProfile.count({ where: { wawuUserId: who } }),
    ).toBe(0);
    // Safe to run again: nothing left to drop, nothing to fail on.
    const again = await purge.purge(who);
    expect(again.failed).toEqual([]);
    expect(h.standin.openClones()).toBe(0);
  });

  it('purge: while the provider refuses, nothing is deleted and the note stays; once it answers, the next pass drops the voice and the rows', async () => {
    const { who, job, made } = await personWithNotedClone('[[remove-fail]]');
    const draft = await h.prisma.productDraft.create({
      data: { wawuUserId: who, title: 'Kept until the voice is gone' },
    });
    expect(h.standin.openClones()).toBe(1);

    // The provider is down: the purge stops before it deletes a row.
    await expect(purge.purge(who)).rejects.toThrow(/still holds a copy/);
    expect(h.standin.openClones()).toBe(1);
    expect(h.standin.state.removeRefused).toBeGreaterThan(0);
    expect((await jobRow(job.id)).providerRef).toBe(`${NOTE_PREFIX}${made}`);
    expect(await h.prisma.productDraft.count({ where: { id: draft.id } })).toBe(
      1,
    );
    // The agreement is taken back at once, so nothing new can be made meanwhile.
    const profile = await h.prisma.voiceProfile.findUniqueOrThrow({
      where: { wawuUserId: who },
    });
    expect(profile.ownVoiceConsentAt).toBeNull();
    expect(profile.ownVoiceConsentLine).toBeNull();
    // Still failing on the next pass while the provider is down.
    await expect(purge.purge(who)).rejects.toThrow(/still holds a copy/);
    expect(h.standin.openClones()).toBe(1);

    // The provider is back: the next pass drops the voice, then the rows.
    h.standin.releaseStubborn();
    const out = await purge.purge(who);
    expect(out.failed).toEqual([]);
    expect(h.standin.openClones()).toBe(0);
    expect(await h.prisma.aiToolJob.count({ where: { wawuUserId: who } })).toBe(
      0,
    );
    expect(await h.prisma.productDraft.count({ where: { id: draft.id } })).toBe(
      0,
    );
  });

  it("purge: only the deleted person's copies are dropped; another person's noted voice stays for its own job", async () => {
    const mine = await personWithNotedClone();
    const theirs = await personWithNotedClone();
    expect(h.standin.openClones()).toBe(2);
    await purge.purge(mine.who);
    expect(h.standin.openClones()).toBe(1);
    expect((await jobRow(theirs.job.id)).providerRef).toBe(
      `${NOTE_PREFIX}${theirs.made}`,
    );
    await purge.purge(theirs.who);
    expect(h.standin.openClones()).toBe(0);
  });

  it('purge: a person with no voice copy is purged as before', async () => {
    const who = randomUUID();
    ghosts.push(who);
    await h.prisma.aiToolJob.create({
      data: {
        wawuUserId: who,
        tool: 'voiceover_per_min',
        idempotencyKey: randomUUID(),
        requestHash: 'x',
        voiceId: 'ada',
        characters: 10,
        units: 1,
        costPoints: ONE_MINUTE,
        state: 'done',
        finishedAt: new Date(),
      },
    });
    const out = await purge.purge(who);
    expect(out.failed).toEqual([]);
    expect(await h.prisma.aiToolJob.count({ where: { wawuUserId: who } })).toBe(
      0,
    );
    expect(since().deleted).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. noteCopy and ?saved=false
  // ---------------------------------------------------------------------------

  it('note: answers true only when the note is on a job row; false when there is no such job or the write fails', async () => {
    const { who, job } = await personWithNotedClone();
    expect(await copies.note(job.id, { kind: 'voice', id: 'v-1' })).toBe(true);
    expect((await jobRow(job.id)).providerRef).toBe('voice:v-1');
    expect(await copies.note(randomUUID(), { kind: 'voice', id: 'v-2' })).toBe(
      false,
    );

    const down = new ProviderCopyService(
      {
        aiToolJob: {
          updateMany: () => Promise.reject(new Error('database down')),
        },
      } as unknown as PrismaService,
      provider,
      {} as PlanSettingsService,
    );
    expect(await down.note(job.id, { kind: 'voice', id: 'v-3' })).toBe(false);
    expect((await jobRow(job.id)).providerRef).toBe('voice:v-1');
    down.onModuleDestroy();
    // The voice made for this check is dropped again (its note is the one written above).
    await h.prisma.aiToolJob.update({
      where: { id: job.id },
      data: { providerRef: `voice:${h.standin.state.clones.at(-1)}` },
    });
    await purge.purge(who);
    expect(h.standin.openClones()).toBe(0);
  });

  it('note: a job whose note could not be written does not hand the voice over; the adapter removes it itself and the job still finishes', async () => {
    await recordVoice(PLAIN);
    await agree(PLAIN);
    const noteSpy = jest.spyOn(copies, 'note').mockResolvedValueOnce(false);
    const discardSpy = jest.spyOn(copies, 'discard');
    try {
      const job = await runAndFinish(PLAIN, 'own');
      expect(job.state).toBe('done');
      expect(noteSpy).toHaveBeenCalledTimes(1);
      // Handed over unnoted would have left the removal to the pipeline's discard.
      expect(discardSpy).not.toHaveBeenCalled();
      expect(since().cloned).toBe(1);
      expect(since().deleted).toBe(1);
      expect(h.standin.openClones()).toBe(0);
      expect((await jobRow(job.id)).providerRef).toBeNull();
    } finally {
      noteSpy.mockRestore();
      discardSpy.mockRestore();
    }
  });

  it('note: a job whose note is written is still handed over (the pipeline removes the voice and clears the note)', async () => {
    await recordVoice(PLAIN);
    await agree(PLAIN);
    const discardSpy = jest.spyOn(copies, 'discard');
    try {
      const job = await runAndFinish(PLAIN, 'own');
      expect(job.state).toBe('done');
      expect(discardSpy).toHaveBeenCalledTimes(1);
      expect(since().deleted).toBe(1);
      expect(h.standin.openClones()).toBe(0);
      expect((await jobRow(job.id)).providerRef).toBeNull();
    } finally {
      discardSpy.mockRestore();
    }
  });

  it('GET /ai-tools/jobs?saved=false lists only the results not saved; saved=true only the saved; absent lists every job', async () => {
    const a = await runAndFinish(PLAIN, 'ada');
    const b = await runAndFinish(PLAIN, 'tunde');
    const c = await runAndFinish(PLAIN, 'ada');
    await post(PLAIN, `/ai-tools/jobs/${b.id}/save`);

    const ids = async (query: Record<string, string>) =>
      data<AiJobPage>(await get(PLAIN, '/ai-tools/jobs', query)).items.map(
        (j) => [j.id, j.saved],
      );
    expect(await ids({ saved: 'false' })).toEqual([
      [c.id, false],
      [a.id, false],
    ]);
    expect(await ids({ saved: 'true' })).toEqual([[b.id, true]]);
    expect(await ids({})).toEqual([
      [c.id, false],
      [b.id, true],
      [a.id, false],
    ]);
    // Taking it out moves it to the unsaved list.
    await h
      .http()
      .delete(`/ai-tools/jobs/${b.id}/save`)
      .set('Authorization', as(PLAIN));
    expect((await ids({ saved: 'false' })).map(([id]) => id)).toEqual([
      c.id,
      b.id,
      a.id,
    ]);
    expect(await ids({ saved: 'true' })).toEqual([]);
    // Pages of the unsaved list carry on from the cursor.
    const first = data<AiJobPage>(
      await get(PLAIN, '/ai-tools/jobs', { saved: 'false', limit: '2' }),
    );
    expect(first.items.map((j) => j.id)).toEqual([c.id, b.id]);
    const next = data<AiJobPage>(
      await get(PLAIN, '/ai-tools/jobs', {
        saved: 'false',
        limit: '2',
        cursor: first.nextCursor ?? '',
      }),
    );
    expect(next.items.map((j) => j.id)).toEqual([a.id]);
  });

  // ---------------------------------------------------------------------------
  // Lead ruling (Default, owner may override): Use in a product takes any of the
  // person's own finished jobs, saved or not.
  // ---------------------------------------------------------------------------

  it('Use in a product (lead ruling): an own finished result attaches whether or not it was saved', async () => {
    const unsaved = await runAndFinish(PLAIN, 'ada');
    expect((await jobRow(unsaved.id)).savedAt).toBeNull();
    const saved = await runAndFinish(PLAIN, 'tunde');
    await post(PLAIN, `/ai-tools/jobs/${saved.id}/save`);

    const drafts = new ProductDraftService(
      h.prisma,
      null as never,
      null as never,
    );
    const one = await drafts.create(PLAIN, {
      title: 'Unsaved result',
      mediaJobId: unsaved.id,
    });
    const two = await drafts.create(PLAIN, {
      title: 'Saved result',
      mediaJobId: saved.id,
    });
    expect(one.mediaJobId).toBe(unsaved.id);
    expect(two.mediaJobId).toBe(saved.id);
  });
});
