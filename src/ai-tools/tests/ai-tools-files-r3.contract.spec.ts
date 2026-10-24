// Contract tests for AITOOLS-04 round 3:
//   HIGH 1: the real provider answers 200 to a delete sent just after its
//   answer and the transcript appears afterwards, so a 2xx is not "gone": the
//   note stays until a read of the copy says 404, in the first minute's tries
//   and in the sweep, and a copy that is really gone is cleared once.
//   HIGH 2 (HTTP): a second read from the same account answers the Hub's busy
//   refusal with nothing held.
//
// Real HTTP against the caller's DATABASE_URL, the real controller, job and
// input services, points service and settings, and the real HTTP voice
// adapter against the voice stand-in on this machine. NOT RUN against the
// real provider. No payment provider and no Fintava double is started.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { loadPlansConfig } from '../../plans/plans-config';
import type { AiJobView } from '../ai-tools-view.type';
import {
  bootAiTools,
  type AiHarness,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';
import { atomFlood, wavFile } from '../../../test/ai-tools/media-fixtures';
import { READ_BUSY_MESSAGE } from '../input/read-gate';
import { ProviderCopyService } from '../voice/provider-copy.service';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const CAPTIONS = plan.actions.find((a) => a.id === 'captions_per_min')!.points;

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const until = async (ok: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('gave up waiting');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AITOOLS-04 r3: the provider copy is kept until a read says 404 (contract)', () => {
  let h: AiHarness;
  let copies: ProviderCopyService;
  const auth = (who: string) => ({
    Authorization: `Bearer ${h.tokensOf[who]}`,
  });
  const tokenFor = (action: string, cost: number) =>
    h.tokens.issue(
      PLAIN,
      action,
      cost,
      new Date(Date.now() + (300 - h.tokens.seconds) * 1000),
    );
  const captions = (fileKey: string) =>
    h
      .http()
      .post('/ai-tools/captions/jobs')
      .set(auth(PLAIN))
      .set('Idempotency-Key', randomUUID())
      .send({ fileKey, quoteToken: tokenFor('captions_per_min', CAPTIONS) });
  const jobRow = (id: string) =>
    h.prisma.aiToolJob.findUniqueOrThrow({ where: { id } });
  const transcriptTries = () =>
    h.standin.state.deleteTries.filter((t) => t.kind === 'transcript');

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
    h.inputs.reads.length = 0;
    h.inputs.failRead = false;
    const s = h.standin.state;
    s.transcribe.length = 0;
    s.isolate.length = 0;
    s.deletedTranscripts.length = 0;
    s.deletedIsolations.length = 0;
    s.deleteTries.length = 0;
    s.reads.length = 0;
    copies.delaysMs = [50, 50, 50];
  });

  it('HIGH 1: the provider answers 200 to an early delete and the copy is still there: the note stays, the tries go on, and only a read that says 404 clears it', async () => {
    await h.grant(PLAIN, CAPTIONS);
    copies.delaysMs = [300, 300, 300, 300, 300, 300, 300, 300, 300, 300];
    const key = h.inputs.add(
      PLAIN,
      wavFile(30, '[[ack-then-appear:1500]]'),
      'audio/wav',
    );
    const res = await captions(key);
    expect(res.status).toBe(202);
    const id = data<AiJobView>(res).id;
    expect((await h.finish(PLAIN, id)).state).toBe('done');

    // The first try: the provider said 200 and the copy is still readable.
    expect(transcriptTries()[0]).toMatchObject({ status: 200, kept: true });
    expect(h.standin.state.reads[0]).toMatchObject({ status: 200 });
    expect(h.standin.openTranscripts()).toBe(1);
    expect(h.standin.state.deletedTranscripts).toHaveLength(0);
    expect((await jobRow(id)).providerRef).toMatch(/^transcript:tr-\d+$/);

    // Later tries delete it for real; a read says 404; only then is the note cleared.
    await until(async () => (await jobRow(id)).providerRef === null);
    expect(h.standin.openTranscripts()).toBe(0);
    expect(h.standin.state.deletedTranscripts).toHaveLength(1);
    const kept = transcriptTries().filter((t) => t.kept);
    expect(kept.length).toBeGreaterThanOrEqual(1);
    const reads = h.standin.state.reads.map((r) => r.status);
    expect(reads[0]).toBe(200);
    expect(reads[reads.length - 1]).toBe(404);
    expect(reads.filter((s) => s === 404)).toHaveLength(1);
    // Nothing is tried after the clear.
    const tries = transcriptTries().length;
    await sleep(900);
    expect(transcriptTries()).toHaveLength(tries);
    expect((await jobRow(id)).state).toBe('done');
    expect(await h.balance(PLAIN)).toBe(0);
  });

  it('HIGH 1: a copy that is really gone is cleared once: one delete, one read that says 404, then nothing more', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const key = h.inputs.add(PLAIN, wavFile(30), 'audio/wav');
    const res = await captions(key);
    const id = data<AiJobView>(res).id;
    expect((await h.finish(PLAIN, id)).state).toBe('done');
    await until(async () => (await jobRow(id)).providerRef === null);
    expect(transcriptTries()).toEqual([
      {
        kind: 'transcript',
        id: h.standin.state.deletedTranscripts[0],
        status: 200,
      },
    ]);
    expect(h.standin.state.reads).toEqual([
      {
        kind: 'transcript',
        id: h.standin.state.deletedTranscripts[0],
        status: 404,
      },
    ]);
    // The retry timers would fire inside this time; the cleared note stops them.
    await sleep(500);
    expect(transcriptTries()).toHaveLength(1);
    expect(h.standin.state.reads).toHaveLength(1);
    expect(h.standin.openTranscripts()).toBe(0);
  });

  it('HIGH 1: the sweep does the same: a 200 that leaves the copy readable keeps the note; after the provider has taken it in, a delete and a read of 404 clear it', async () => {
    await h.grant(PLAIN, CAPTIONS);
    copies.delaysMs = []; // no background tries: only the sweep
    const key = h.inputs.add(
      PLAIN,
      wavFile(30, '[[ack-then-appear:900]]'),
      'audio/wav',
    );
    const res = await captions(key);
    const id = data<AiJobView>(res).id;
    await h.finish(PLAIN, id);
    await until(async () => (await jobRow(id)).state === 'done');
    const marker = (await jobRow(id)).providerRef!;
    const finishedAt = (await jobRow(id)).finishedAt!;

    // The first delete (in the job) was acknowledged and the copy is still there.
    expect(transcriptTries()[0]).toMatchObject({ status: 200, kept: true });
    // Far later by the clock, but the provider is not ready: still kept, still noted.
    const early = await copies.sweep(
      new Date(finishedAt.getTime() + 60 * 60_000),
    );
    expect(early).toEqual({ cleared: 0, pending: 1 });
    expect((await jobRow(id)).providerRef).toBe(marker);
    expect(h.standin.openTranscripts()).toBe(1);

    await sleep(1000);
    const later = await copies.sweep(new Date(finishedAt.getTime() + 61_000));
    expect(later).toEqual({ cleared: 1, pending: 0 });
    expect(h.standin.openTranscripts()).toBe(0);
    expect((await jobRow(id)).providerRef).toBeNull();
    expect(h.standin.state.reads.map((r) => r.status)).toEqual([200, 200, 404]);
  });

  it('LOW (b): a copy the provider no longer has is cleared the moment a read says 404, with no 10 minute wait; a cleaned recording (no read exists) still waits for its window', async () => {
    await h.grant(PLAIN, CAPTIONS);
    copies.delaysMs = [];
    const key = h.inputs.add(PLAIN, wavFile(30), 'audio/wav');
    const id = data<AiJobView>(await captions(key)).id;
    await h.finish(PLAIN, id);
    await until(async () => (await jobRow(id)).providerRef === null);
    const finishedAt = (await jobRow(id)).finishedAt!;

    // Changed assertion (round 2 pinned the defect): a transcript note whose copy
    // is not at the provider used to be kept for 10 minutes after the answer, and
    // blocked the AITOOLS-02 rollback that long. A read of 404 is the proof now.
    await h.prisma.aiToolJob.update({
      where: { id },
      data: { providerRef: 'transcript:tr-never-existed' },
    });
    expect(await copies.sweep(new Date(finishedAt.getTime() + 60_000))).toEqual(
      {
        cleared: 1,
        pending: 0,
      },
    );
    expect((await jobRow(id)).providerRef).toBeNull();

    // A cleaned recording's item: no read, so a 404 inside the window is kept.
    await h.prisma.aiToolJob.update({
      where: { id },
      data: { providerRef: 'isolation:iso-never-existed' },
    });
    expect(await copies.sweep(new Date(finishedAt.getTime() + 60_000))).toEqual(
      {
        cleared: 0,
        pending: 1,
      },
    );
    expect(
      await copies.sweep(new Date(finishedAt.getTime() + 11 * 60_000)),
    ).toEqual({ cleared: 1, pending: 0 });
    expect((await jobRow(id)).providerRef).toBeNull();
  });

  it('HIGH 2 over HTTP: while one file of an account is being read, a second quote from the account waits its turn, a third is refused with the busy words, and nothing is held', async () => {
    const slow = h.inputs.add(
      PLAIN,
      atomFlood(8 * 1024 * 1024),
      'video/mp4',
      'ai/input-video',
    );
    const second = h.inputs.add(PLAIN, wavFile(5), 'audio/wav');
    const third = h.inputs.add(PLAIN, wavFile(6), 'audio/wav');
    const quote = (fileKey: string) =>
      h
        .http()
        .post('/ai-tools/captions/quote')
        .set(auth(PLAIN))
        .send({ fileKey });
    const first = quote(slow).then((r) => r);
    await until(() =>
      h.inputs.reads.some((r) => r.key === slow && r.kind === 'whole'),
    );
    const waits = quote(second).then((r) => r);
    await sleep(150);
    const refused = await quote(third);
    expect(refused.status).toBe(503);
    expect((refused.body as { message: string }).message).toBe(
      READ_BUSY_MESSAGE,
    );
    expect(h.inputs.reads.filter((r) => r.key === third)).toHaveLength(0);
    expect(h.inputs.reads.filter((r) => r.key === second)).toHaveLength(0);
    expect(
      await h.prisma.pointHold.findMany({ where: { wawuUserId: PLAIN } }),
    ).toHaveLength(0);
    expect((await first).status).toBe(422); // the flood is unreadable at its time limit
    expect((await waits).status).toBe(200); // the waiting quote is served after it
    expect((await quote(third)).status).toBe(200); // and the account is free again
  });
});
