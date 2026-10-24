// Contract tests for AITOOLS-04 round 4, HIGH 1: the real provider is
// eventually consistent. It answers a read 404 for about a second after a
// DELETE and the transcript then appears (8 of 9 real jobs, 24 Oct 2026), so
// the Hub never clears the note on a 404 seen soon after a delete. It keeps
// deleting on a schedule and clears the note only after two reads that say 404,
// the first at least `ai.copy_confirm_after_minutes` (10) after the job ended
// and the second at least `ai.copy_confirm_gap_minutes` (5) after the first,
// each read made with no delete just before it (PROVISIONAL settings).
//
// The stand-in models it: [[ack-then-appear:MS]] (a delete before MS removes
// nothing) with [[get404-after-delete:MS]] (a read answers 404 for MS after such
// a delete, then the copy shows again). Real HTTP against the caller's
// DATABASE_URL, the real job, input and copy services, and the real HTTP voice
// adapter against the stand-in on this machine. NOT RUN against the real
// provider. No payment provider and no Fintava double is started.

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
import { wavFile } from '../../../test/ai-tools/media-fixtures';
import { ProviderCopyService } from '../voice/provider-copy.service';

jest.setTimeout(120_000);

const plan = loadPlansConfig();
const CAPTIONS = plan.actions.find((a) => a.id === 'captions_per_min')!.points;
const MIN = 60_000;

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

describe('AITOOLS-04 r4: the provider copy is cleared only by two reads of 404, 10 and then 5 minutes on (contract)', () => {
  let h: AiHarness;
  let copies: ProviderCopyService;
  const auth = () => ({ Authorization: `Bearer ${h.tokensOf[PLAIN]}` });
  const captions = (fileKey: string) =>
    h
      .http()
      .post('/ai-tools/captions/jobs')
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .send({
        fileKey,
        quoteToken: h.tokens.issue(
          PLAIN,
          'captions_per_min',
          CAPTIONS,
          new Date(Date.now() + (300 - h.tokens.seconds) * 1000),
        ),
      });
  const jobRow = (id: string) =>
    h.prisma.aiToolJob.findUniqueOrThrow({ where: { id } });
  const readStatuses = () => h.standin.state.reads.map((r) => r.status);
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
    copies.delaysMs = []; // no background tries: the sweep is driven by the spec
  });

  it('the settings are the PROVISIONAL 10 and 5 minutes', () => {
    expect(copies.confirmWindow()).toEqual({
      afterMs: 10 * MIN,
      gapMs: 5 * MIN,
    });
  });

  it('a provider that hides the copy for a moment after a delete and then shows it again is not believed: the note stays until two clean reads of 404 are 5 minutes apart, the first 10 minutes after the job', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const key = h.inputs.add(
      PLAIN,
      wavFile(30, '[[ack-then-appear:1500]][[get404-after-delete:600]]'),
      'audio/wav',
    );
    const id = data<AiJobView>(await captions(key)).id;
    expect((await h.finish(PLAIN, id)).state).toBe('done');
    await until(() => h.standin.state.reads.length === 1);

    // The job's own try: the delete was acknowledged and did nothing, and the
    // read right after it says 404. The old rule cleared the note here.
    expect(transcriptTries()[0]).toMatchObject({ status: 200, kept: true });
    expect(h.standin.state.reads[0]).toMatchObject({
      status: 404,
      hidden: true,
    });
    expect(h.standin.openTranscripts()).toBe(1); // the provider still holds the words
    const marker = (await jobRow(id)).providerRef!;
    expect(marker).toMatch(/^transcript:tr-\d+$/);
    const finishedAt = (await jobRow(id)).finishedAt!;
    const at = (minutes: number) =>
      new Date(finishedAt.getTime() + minutes * MIN);

    // A pass a minute later: it deletes again, the read after it is 404 again,
    // and the note still stays (nothing is believed inside 10 minutes).
    expect(await copies.sweep(at(1))).toEqual({ cleared: 0, pending: 1 });
    expect((await jobRow(id)).providerRef).toBe(marker);

    // After the provider has taken the delete in (and the hiding is over), the
    // first pass past 10 minutes reads FIRST: the copy is there (200), so it is
    // deleted, and nothing is noted.
    await sleep(1800);
    expect(await copies.sweep(at(11))).toEqual({ cleared: 0, pending: 1 });
    expect((await jobRow(id)).providerRef).toBe(marker);
    expect(h.standin.openTranscripts()).toBe(0);

    // The next pass reads 404 with no delete before it: the first check. It is
    // written into the note (with its time) and the note stays.
    expect(await copies.sweep(at(12))).toEqual({ cleared: 0, pending: 1 });
    expect((await jobRow(id)).providerRef).toBe(
      `${marker}@${at(12).getTime()}`,
    );
    // Less than 5 minutes later, a second 404 does not clear it.
    expect(await copies.sweep(at(16.9))).toEqual({ cleared: 0, pending: 1 });
    expect((await jobRow(id)).providerRef).toBe(
      `${marker}@${at(12).getTime()}`,
    );
    // 5 minutes after the first: cleared.
    expect(await copies.sweep(at(17))).toEqual({ cleared: 1, pending: 0 });
    expect((await jobRow(id)).providerRef).toBeNull();

    // The reads the provider saw: hidden 404, hidden 404 (after the 1 minute
    // pass's own delete), 200, then three clean 404s. The deletes: the two
    // acknowledged ones and the one that worked; the three checks sent none.
    expect(readStatuses()).toEqual([404, 404, 200, 404, 404, 404]);
    expect(transcriptTries().map((t) => t.status)).toEqual([200, 200, 200]);
    expect(transcriptTries().filter((t) => t.kept)).toHaveLength(2);
    expect(h.standin.state.deletedTranscripts).toHaveLength(1);
    // The job itself was never touched: the words are there and the points kept.
    expect((await jobRow(id)).state).toBe('done');
    expect(await h.balance(PLAIN)).toBe(0);
    // Nothing is tried after the clear.
    expect(await copies.sweep(at(30))).toEqual({ cleared: 0, pending: 0 });
    expect(readStatuses()).toHaveLength(6);
  });

  it('a first 404 is taken back when the copy shows again: the note goes back to the plain marker and the delete is sent again', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const key = h.inputs.add(
      PLAIN,
      wavFile(30, '[[ack-then-appear:600000]]'), // the provider will not delete for 10 minutes
      'audio/wav',
    );
    const id = data<AiJobView>(await captions(key)).id;
    await h.finish(PLAIN, id);
    await until(() => h.standin.state.reads.length === 1);
    const marker = (await jobRow(id)).providerRef!;
    const finishedAt = (await jobRow(id)).finishedAt!;
    // A first 404 was noted 12 minutes after the job (written by hand: the
    // provider answered it, then showed the copy again).
    await h.prisma.aiToolJob.update({
      where: { id },
      data: { providerRef: `${marker}@${finishedAt.getTime() + 12 * MIN}` },
    });
    const before = transcriptTries().length;
    expect(
      await copies.sweep(new Date(finishedAt.getTime() + 18 * MIN)),
    ).toEqual({ cleared: 0, pending: 1 });
    // Past 5 minutes after the noted 404 the old rule would have cleared it; the
    // read found the copy (200), so the 404 is void and the delete goes out again.
    expect((await jobRow(id)).providerRef).toBe(marker);
    expect(h.standin.state.reads.at(-1)).toMatchObject({ status: 200 });
    expect(transcriptTries().length).toBe(before + 1);
    expect(h.standin.openTranscripts()).toBe(1);
  });

  it('a 404 read inside the first 10 minutes never clears a transcript, however many passes see it', async () => {
    await h.grant(PLAIN, CAPTIONS);
    const key = h.inputs.add(PLAIN, wavFile(30), 'audio/wav');
    const id = data<AiJobView>(await captions(key)).id;
    await h.finish(PLAIN, id);
    await until(() => h.standin.state.reads.length === 1);
    const marker = (await jobRow(id)).providerRef!;
    const finishedAt = (await jobRow(id)).finishedAt!;
    for (const m of [1, 3, 5, 9.9]) {
      expect(
        await copies.sweep(new Date(finishedAt.getTime() + m * MIN)),
      ).toEqual({ cleared: 0, pending: 1 });
      expect((await jobRow(id)).providerRef).toBe(marker);
    }
    expect(readStatuses().every((s) => s === 404)).toBe(true);
  });
});
