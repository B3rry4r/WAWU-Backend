// Contract tests for AITOOLS-04 round 2 (the verifier's findings 1 to 7):
// a person's file cannot stop the Hub, the provider's copies are deleted even
// when the provider has not stored them yet, Clean audio reads the real
// header, QuickTime is read, and the low findings.
//
// Real HTTP against the caller's DATABASE_URL, the real controller, job and
// input services, points service and settings, and the real HTTP voice
// adapter against the voice stand-in on this machine. The person's files are
// kept in memory. NOT RUN against the real provider. No payment provider and
// no Fintava double is started.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { loadPlansConfig } from '../../plans/plans-config';
import type { AiFileQuoteView, AiJobView } from '../ai-tools-view.type';
import {
  bootAiTools,
  type AiHarness,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';
import {
  craftedAsf,
  mp4File,
  wavFile,
  withId3,
} from '../../../test/ai-tools/media-fixtures';
import { parseInWorker } from '../input/media-length';
import { ProviderCopyService } from '../voice/provider-copy.service';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const CAPTIONS = plan.actions.find((a) => a.id === 'captions_per_min')!.points;
const CLEAN = plan.actions.find((a) => a.id === 'clean_audio_per_min')!.points;

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason: Record<string, unknown> & { code: string } }).reason;
const until = async (ok: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('gave up waiting');
};

describe('AITOOLS-04 r2: Captions and Clean audio (contract)', () => {
  let h: AiHarness;
  let copies: ProviderCopyService;
  const auth = (who: string) => ({
    Authorization: `Bearer ${h.tokensOf[who]}`,
  });
  const upload = (
    bytes: Buffer,
    type = 'audio/wav',
    folder = 'ai/input-audio',
  ) => h.inputs.add(PLAIN, bytes, type, folder);
  const tokenFor = (action: string, cost: number) =>
    h.tokens.issue(
      PLAIN,
      action,
      cost,
      new Date(Date.now() + (300 - h.tokens.seconds) * 1000),
    );
  const quote = (route: 'captions' | 'clean-audio', fileKey: string) =>
    h
      .http()
      .post(`/ai-tools/${route}/quote`)
      .set(auth(PLAIN))
      .send({ fileKey });
  const job = (
    route: 'captions' | 'clean-audio',
    fileKey: string,
    minutes: number,
  ) => {
    const action =
      route === 'captions' ? 'captions_per_min' : 'clean_audio_per_min';
    const per = route === 'captions' ? CAPTIONS : CLEAN;
    return h
      .http()
      .post(`/ai-tools/${route}/jobs`)
      .set(auth(PLAIN))
      .set('Idempotency-Key', randomUUID())
      .send({ fileKey, quoteToken: tokenFor(action, per * minutes) });
  };
  const nothingHeld = async (balance: number) => {
    expect(
      await h.prisma.pointHold.findMany({ where: { wawuUserId: PLAIN } }),
    ).toHaveLength(0);
    expect(
      await h.prisma.aiToolJob.findMany({ where: { wawuUserId: PLAIN } }),
    ).toHaveLength(0);
    expect(await h.balance(PLAIN)).toBe(balance);
  };
  const jobRow = (id: string) =>
    h.prisma.aiToolJob.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    h = await bootAiTools();
    copies = h.get<ProviderCopyService>(ProviderCopyService);
  });
  afterAll(async () => {
    await h.clean();
    await h.close();
  });
  beforeEach(async () => {
    await h.jobs.drain();
    await h.clean();
    h.store.files.clear();
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    h.inputs.failRead = false;
    const s = h.standin.state;
    s.transcribe.length = 0;
    s.isolate.length = 0;
    s.deletedTranscripts.length = 0;
    s.deletedIsolations.length = 0;
    s.deleteTries.length = 0;
    copies.delaysMs = [50, 50, 50];
  });

  it('HIGH 1: the 278-byte crafted ASF declared audio/mpeg is refused as unreadable, holds nothing, and /health answers while a parser loops in its worker', async () => {
    await h.grant(PLAIN, CAPTIONS * 3);
    const asfKey = upload(craftedAsf(), 'audio/mpeg');
    const hiddenKey = upload(withId3(craftedAsf()), 'audio/mpeg');
    const goodKey = upload(wavFile(30));

    // A parser really is looping in a worker (no type hint: the old way)...
    const looping = parseInWorker(craftedAsf(), undefined, { timeoutMs: 2500 });
    await new Promise((r) => setTimeout(r, 300));

    // ...and the Hub still answers: /health, a good quote, and the crafted files' quotes.
    const started = Date.now();
    for (let i = 0; i < 10; i++) {
      const health = await h.http().get('/health');
      expect(health.status).toBe(200);
    }
    const good = await quote('captions', goodKey);
    expect(good.status).toBe(200);
    expect(data<AiFileQuoteView>(good).file.minutes).toBe(1);
    for (const key of [asfKey, hiddenKey]) {
      for (const route of ['captions', 'clean-audio'] as const) {
        const res = await quote(route, key);
        expect(res.status).toBe(422);
        expect(reasonOf(res).code).toBe('ai_file_unreadable');
      }
      const run = await job('captions', key, 1);
      expect(run.status).toBe(422);
      expect(reasonOf(run).code).toBe('ai_file_unreadable');
    }
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await looping).toBeNull(); // stopped at its time limit
    expect(Date.now() - started).toBeLessThan(6000);

    // Nothing held, no provider call, the files are still there.
    const jobs = await h.prisma.aiToolJob.findMany({
      where: { wawuUserId: PLAIN },
    });
    expect(jobs).toHaveLength(0);
    expect(h.standin.state.transcribe).toHaveLength(0);
    expect(h.inputs.files.has(asfKey)).toBe(true);
    expect(await h.balance(PLAIN)).toBe(CAPTIONS * 3);
  });

  it('MEDIUM 4: a QuickTime .mov (video/quicktime) is read as ISO BMFF and priced; LOW 5: a fragmented MP4 is refused and never priced at 0 minutes; LOW 6: a "1:00" clip is one minute', async () => {
    await h.grant(PLAIN, CAPTIONS * 3);
    const mov = upload(
      mp4File({ brand: 'qt  ', milliseconds: 30_064 }),
      'video/quicktime',
      'ai/input-video',
    );
    const movQuote = await quote('captions', mov);
    expect(movQuote.status).toBe(200);
    expect(data<AiFileQuoteView>(movQuote)).toMatchObject({
      costPoints: CAPTIONS,
      file: { minutes: 1 },
    });
    const real90 = upload(
      mp4File({ milliseconds: 90_064 }),
      'video/mp4',
      'ai/input-video',
    );
    expect(
      data<AiFileQuoteView>(await quote('clean-audio', real90)),
    ).toMatchObject({ costPoints: CLEAN * 2, file: { minutes: 2 } });
    const oneMinute = upload(
      mp4File({ milliseconds: 60_064 }),
      'video/mp4',
      'ai/input-video',
    );
    expect(
      data<AiFileQuoteView>(await quote('captions', oneMinute)),
    ).toMatchObject({ costPoints: CAPTIONS, file: { minutes: 1 } });
    const fragmented = upload(
      mp4File({ fragmented: true }),
      'video/mp4',
      'ai/input-video',
    );
    for (const route of ['captions', 'clean-audio'] as const) {
      const res = await quote(route, fragmented);
      expect(res.status).toBe(422);
      expect(reasonOf(res).code).toBe('ai_file_unreadable');
      expect((await job(route, fragmented, 1)).status).toBe(422);
    }
    await nothingHeld(CAPTIONS * 3);
  });

  it('HIGH 2: the transcript delete answers 404 while the provider has not stored it; the Hub tries again in the background and the copy is gone, while the job was already done', async () => {
    await h.grant(PLAIN, CAPTIONS);
    copies.delaysMs = [250, 250, 250, 250, 250, 250, 250, 250];
    const key = upload(wavFile(30, '[[store-delay:1200]]'));
    const res = await job('captions', key, 1);
    expect(res.status).toBe(202);
    const id = data<AiJobView>(res).id;
    const end = await h.finish(PLAIN, id);
    expect(end.state).toBe('done');
    // The first try found nothing (404) and the copy is still at the provider.
    expect(h.standin.state.deleteTries[0]).toMatchObject({
      kind: 'transcript',
      status: 404,
    });
    expect(h.standin.openTranscripts()).toBe(1);
    expect((await jobRow(id)).providerRef).toMatch(/^transcript:tr-\d+$/);
    // Tries again until it is stored and gone.
    await until(() => h.standin.state.deletedTranscripts.length === 1);
    expect(h.standin.openTranscripts()).toBe(0);
    const tries = h.standin.state.deleteTries.filter(
      (t) => t.kind === 'transcript',
    );
    expect(tries.length).toBeGreaterThan(1);
    expect(tries[tries.length - 1].status).toBe(200);
    // Round 4 changed this assertion (it was: the note is null once the copy is
    // deleted). A read that says 404 soon after a delete proves nothing (the real
    // provider hides the copy for a second and it then shows again), so the note
    // stays until two reads 5 minutes apart say 404, the first 10 minutes after
    // the job ended (ai-tools-files-r4.contract.spec.ts).
    expect((await jobRow(id)).providerRef).toMatch(/^transcript:tr-\d+$/);
    // The words are on the job and the points were kept.
    expect((await jobRow(id)).state).toBe('done');
    expect(await h.balance(PLAIN)).toBe(0);
  });

  it('HIGH 2: when the tries in the first minute run out, the sweep finishes the delete; a 404 inside the not-stored-yet window keeps the copy noted, a 404 after it clears it', async () => {
    await h.grant(PLAIN, CAPTIONS);
    copies.delaysMs = []; // no background tries: only the sweep
    const key = upload(wavFile(30, '[[store-delay:900]]'));
    const res = await job('captions', key, 1);
    const id = data<AiJobView>(res).id;
    await h.finish(PLAIN, id);
    await until(async () => (await jobRow(id)).state === 'done');
    expect(h.standin.openTranscripts()).toBe(1);
    const marker = (await jobRow(id)).providerRef!;
    expect(marker).toMatch(/^transcript:tr-\d+$/);

    // Not stored yet: 404, and the copy stays noted.
    const finishedAt = (await jobRow(id)).finishedAt!;
    const early = await copies.sweep(new Date(finishedAt.getTime() + 31_000));
    expect(early).toEqual({ cleared: 0, pending: 1 });
    expect((await jobRow(id)).providerRef).toBe(marker);
    expect(h.standin.state.deletedTranscripts).toHaveLength(0);

    // Stored now: the sweep deletes it. Round 4 changed this assertion (it was
    // cleared: 1 on the first read of 404, 61 s after the answer): a 404 that
    // soon after a delete does not clear the note.
    await new Promise((r) => setTimeout(r, 1000));
    const later = await copies.sweep(new Date(finishedAt.getTime() + 61_000));
    expect(later).toEqual({ cleared: 0, pending: 1 });
    expect(h.standin.state.deletedTranscripts).toHaveLength(1);
    expect(h.standin.openTranscripts()).toBe(0);
    expect((await jobRow(id)).providerRef).toBe(marker);

    // A transcript the provider never had: a 404 inside the window is kept (this
    // is the round 2 assertion, restored as it was). After the window the first
    // 404 is written into the note; a second one 5 minutes later clears it.
    await h.prisma.aiToolJob.update({
      where: { id },
      data: { providerRef: 'transcript:tr-never-existed' },
    });
    expect(await copies.sweep(new Date(finishedAt.getTime() + 60_000))).toEqual(
      {
        cleared: 0,
        pending: 1,
      },
    );
    expect((await jobRow(id)).providerRef).toBe('transcript:tr-never-existed');
    expect(
      await copies.sweep(new Date(finishedAt.getTime() + 11 * 60_000)),
    ).toEqual({ cleared: 0, pending: 1 });
    expect(
      await copies.sweep(new Date(finishedAt.getTime() + 17 * 60_000)),
    ).toEqual({ cleared: 1, pending: 0 });
    expect((await jobRow(id)).providerRef).toBeNull();
    // A pass that finds nothing noted does nothing.
    expect(await copies.sweep()).toEqual({ cleared: 0, pending: 0 });
  });

  it('HIGH 3: Clean audio takes the provider id from the audio-isolation-id header and deletes that item (the real answer was 204)', async () => {
    await h.grant(PLAIN, CLEAN);
    const key = upload(wavFile(30));
    const res = await job('clean-audio', key, 1);
    expect(res.status).toBe(202);
    const id = data<AiJobView>(res).id;
    const end = await h.finish(PLAIN, id);
    expect(end.state).toBe('done');
    await until(() => h.standin.state.deletedIsolations.length === 1);
    expect(h.standin.state.deleteTries).toEqual([
      {
        kind: 'isolation',
        id: h.standin.state.deletedIsolations[0],
        status: 204,
      },
    ]);
    expect(h.standin.openIsolations()).toBe(0);
    await until(async () => (await jobRow(id)).providerRef === null);
  });

  it('HIGH 3: a cleaned item that is not stored yet is deleted on a later try', async () => {
    await h.grant(PLAIN, CLEAN);
    copies.delaysMs = [250, 250, 250, 250, 250, 250];
    const key = upload(wavFile(30, '[[store-delay:900]]'));
    const res = await job('clean-audio', key, 1);
    const id = data<AiJobView>(res).id;
    await h.finish(PLAIN, id);
    await until(() => h.standin.state.deletedIsolations.length === 1);
    const statuses = h.standin.state.deleteTries.map((t) => t.status);
    expect(statuses[0]).toBe(404);
    expect(statuses[statuses.length - 1]).toBe(204);
    await until(async () => (await jobRow(id)).providerRef === null);
  });

  it('LOW 7: words written to the row before the commit are cleared when a read reconciled the job to failed inside that window', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const key = upload(wavFile(30));
    const realCommit = h.spend.commit.bind(h.spend);
    const spy = jest
      .spyOn(h.spend, 'commit')
      .mockImplementationOnce(async (holdId: string) => {
        // The words are on the row now. The stale sweep gives the points back
        // and a read reconciles the job to failed, all before this commit.
        await h.spend.release(holdId);
        const mine = await h.prisma.aiToolJob.findFirstOrThrow({
          where: { holdId },
        });
        expect(mine.outputs).not.toBeNull();
        const read = await h
          .http()
          .get(`/ai-tools/jobs/${mine.id}`)
          .set(auth(PLAIN));
        expect(data<AiJobView>(read).state).toBe('failed');
        return realCommit(holdId);
      });
    let id = '';
    try {
      const res = await job('captions', key, 1);
      id = data<AiJobView>(res).id;
      await h.jobs.drain();
    } finally {
      spy.mockRestore();
    }
    const row = await jobRow(id);
    expect(row.state).toBe('failed');
    expect(row.failureCode).toBe('timed_out');
    expect(row.outputs).toBeNull();
    expect(await h.balance(PLAIN)).toBe(CAPTIONS);
  });
});
