import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { assetIdsOf } from '../flow/flow-support';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
  type ConversationRead,
  type CopyPresence,
  type ProviderCopy,
} from './ai-voice-provider';

/**
 * After the first try, the waits before each next try in the minute that
 * follows a job (2, 6, 15 and 40 seconds: five tries over about a minute).
 */
export const COPY_TRY_DELAYS_MS = [2_000, 6_000, 15_000, 40_000];
/**
 * A cleaned recording's item has no read the Hub can make, so a 404 to its
 * delete within this long of the provider's answer means "not stored yet" (seen
 * on the real provider for a transcript: 404 at 89 ms, then 200 about 40 s
 * later), so the copy is still there to delete. Later, a 404 means it is gone.
 */
export const NOT_STORED_YET_MS = 10 * 60_000;
/**
 * A transcript is confirmed gone only by two reads that both say 404, the first
 * at least `ai.copy_confirm_after_minutes` after the job ended and the second
 * at least `ai.copy_confirm_gap_minutes` after the first (PROVISIONAL, admin
 * settings; the owner confirms). Why: the real provider is eventually
 * consistent. For about a second after a DELETE its read answers 404 and the
 * transcript then appears (8 of 9 real jobs, 24 Oct 2026), so a 404 seen soon
 * after a delete proves nothing.
 */
export const COPY_CONFIRM_AFTER_SETTING = 'ai.copy_confirm_after_minutes';
export const COPY_CONFIRM_GAP_SETTING = 'ai.copy_confirm_gap_minutes';
/** The longest the Hub keeps trying; then it logs that the copy was never removed. */
export const COPY_GIVE_UP_MS = 24 * 60 * 60_000;
/** A job still `working` this long after it started is swept too (its run died). */
const STALE_WORKING_MS = 15 * 60_000;
const SWEEP_BATCH = 50;
/**
 * REC-DELETE: a Receptionist conversation the Hub could not prove deleted is dropped from the notes this long after it
 * was made, with one warning in the log. The provider's own one-day limit (the agent's `retention_days` 1) has passed
 * by then, so the provider deletes it itself; the extra hour is a margin.
 */
export const CONVERSATION_GIVE_UP_MS = 25 * 60 * 60_000;
/** A conversation sweep reads notes in pages of `SWEEP_BATCH`, at most this many pages in one pass. */
const CONVERSATION_PAGES = 20;
/**
 * REC-DELETE round 1: the sweep reads only notes made in the last `CONVERSATION_GIVE_UP_MS` (the partial index serves
 * this), and a separate small step drops the notes between that age and this one. A note older still is left alone: it
 * is past the provider's own limit by a day and a half, and nothing reads it.
 */
const CONVERSATION_DROP_FLOOR_MS = 48 * 60 * 60_000;
/**
 * A conversation the provider answers 404 for, by id, is not read from the provider's list until its job ended this
 * long ago: a few seconds after a reply it is usually just not stored yet, and the list read would only cost a call.
 */
const LIST_AFTER_MS = 30_000;
/** The list is read for the window the job ran in, widened by this much each side (a conversation starts inside it). */
const LIST_WINDOW_MARGIN_MS = 5 * 60_000;
/** The most in-process retry loops (2, 6, 15 and 40 seconds) running at once; the rest wait for the sweep. */
export const RETRY_LOOPS_MAX = 10;
/** How long a request waits for a conversation's delete before it answers and lets the delete carry on. */
export const REQUEST_WAIT_MS = 2_000;
/**
 * REC-DELETE: how often the sweep tries a conversation, by how long ago its job ended (the first minute has its own
 * short waits, `COPY_TRY_DELAYS_MS`): every minute for the first 5 minutes, every 5 minutes up to the first hour, every
 * 30 minutes after that. The sweep runs every minute and a try is due in a 2 minute window of each period, so a pass
 * that is late or skipped still tries once in the period.
 */
export function conversationDue(ageMs: number): boolean {
  if (ageMs < 5 * 60_000) return true;
  const period = ageMs < 60 * 60_000 ? 5 * 60_000 : 30 * 60_000;
  return ageMs % period < 2 * 60_000;
}

/**
 * How one try went. `gone`: a cleaned item's delete answered 2xx (confirmed).
 * `not_found`: a cleaned item's delete answered 404 (gone or not stored yet;
 * the sweep decides by age). `absent`: a transcript's read, after the delete,
 * said 404 (a first sign only: see `COPY_CONFIRM_AFTER_SETTING`). `keep`: the
 * copy is there or the provider did not say; try again.
 */
export type CopyTry = 'gone' | 'not_found' | 'absent' | 'keep';

/**
 * What a job's `providerRef` holds while the provider's copy is not yet
 * confirmed deleted: `transcript:<id>`, `isolation:<id>`, `voice:<id>` (AITOOLS-07), `asset:<id>+<id>` (AITOOLS-09) or `conversation:<id>` (REC-PRIVACY); for a transcript
 * that has answered 404 once after the confirm window opened, `@<ms>` is added
 * (when that first 404 was read), and a later read of the copy removes it. For
 * a `conversation:<id>` (REC-DELETE) `@<ms>` means "a delete was sent after a
 * read showed the conversation finished, at this time": from then on a read that
 * says 404 proves it gone, and before that a 404 proves nothing.
 */
export function markerOf(copy: ProviderCopy, absentSince?: number): string {
  return `${copy.kind}:${copy.id}${absentSince === undefined ? '' : `@${absentSince}`}`;
}

export interface NotedCopy {
  copy: ProviderCopy;
  /**
   * When a read of the transcript first said 404 in the confirm window (ms), if it has. For a conversation: when a delete
   * was sent after a read showed it finished (a later 404 then proves it gone).
   */
  absentSince: number | null;
}

export function copyOfMarker(marker: string | null): NotedCopy | null {
  if (!marker) return null;
  const at = marker.indexOf(':');
  const kind = marker.slice(0, at);
  let id = marker.slice(at + 1);
  let absentSince: number | null = null;
  const mark = /@(\d{1,15})$/.exec(id);
  if (mark) {
    absentSince = Number(mark[1]);
    id = id.slice(0, mark.index);
  }
  if (
    (kind !== 'transcript' &&
      kind !== 'isolation' &&
      kind !== 'voice' &&
      kind !== 'dub' &&
      // AITOOLS-09, AITOOLS-10: the person's photo or voice sent up for a run, ids joined with `+`.
      kind !== 'asset' &&
      // AITOOLS-13: the Studio project a podcast was made in.
      kind !== 'podcast' &&
      // REC-PRIVACY: a Receptionist conversation (`conversation:<id>`; not `convo:`, which is a live talk's own note).
      kind !== 'conversation') ||
    id === ''
  )
    return null;
  return { copy: { kind, id }, absentSince };
}

/**
 * The provider keeps no copy of a person's words or voice (AITOOLS-04). The
 * real provider is eventually consistent: it answers a transcript's delete 404
 * when it has not stored the copy yet, answers 200 to a delete and keeps the
 * copy (round 3), and (round 4) answers a read 404 for about a second after a
 * delete and then shows the transcript again (8 of 9 real jobs). So no single
 * answer proves a transcript is gone. The copy is deleted like this:
 *
 *   1. the job notes the copy on its row (`providerRef`, a marker) as soon as
 *      the provider has answered, so a server that dies still knows about it;
 *   2. when the job has ended, one try now, then four more over about a minute
 *      with growing waits, outside the job (a timer; the job is already done);
 *      every try is a DELETE (and a read whose answer is not used, this soon);
 *   3. a copy still noted is left to the sweep, which tries every minute the
 *      same way, until the copy is confirmed gone or `COPY_GIVE_UP_MS` passes.
 *
 * A transcript is confirmed gone only by two reads that both say 404 after a
 * delete: the first at least `ai.copy_confirm_after_minutes` after the job
 * ended (the first 404 is written into the marker), the second at least
 * `ai.copy_confirm_gap_minutes` after the first. A read that shows the copy
 * again takes the first 404 back. A 404 seen sooner changes nothing. A cleaned
 * item has no read the Hub can make (4 of 4 real items were gone after one
 * 204): a 2xx clears it, and a 404 clears it once `NOT_STORED_YET_MS` has passed.
 *
 * No log line holds a transcript, a name or an id of the provider. Holds no
 * transaction, connection or lock across a provider call.
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a spec
 * that builds its own module calls `sweep` directly.
 */
@Injectable()
export class ProviderCopyService implements OnModuleDestroy {
  private readonly logger = new Logger(ProviderCopyService.name);
  /** The waits between the first tries; a spec shortens them. */
  delaysMs: number[] = [...COPY_TRY_DELAYS_MS];
  /** The most retry loops at once (a burst of chats cannot make five reads each at the same moment); a spec sets it. */
  retryLimit = RETRY_LOOPS_MAX;
  /** How long a request waits for a conversation's delete before answering; a spec shortens it. */
  requestWaitMs = REQUEST_WAIT_MS;
  private retrying = 0;
  private closed = false;
  private sweeping = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Work a request stopped waiting for; it carries on here. */
  private readonly background = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    private readonly settings: PlanSettingsService,
  ) {}

  onModuleDestroy(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Minutes after the job ended before a 404 counts, and between the two reads (settings, PROVISIONAL). */
  confirmWindow(): { afterMs: number; gapMs: number } {
    return {
      afterMs: this.settings.number(COPY_CONFIRM_AFTER_SETTING) * 60_000,
      gapMs: this.settings.number(COPY_CONFIRM_GAP_SETTING) * 60_000,
    };
  }

  /**
   * Notes the provider's copy on the job's row. Never throws. Answers true only
   * when the note is on the row (the write went through and found the job); a
   * caller that hands a copy's removal over on the strength of the note (a
   * person's own voice) must not do so on a false.
   */
  async note(jobId: string, copy: ProviderCopy): Promise<boolean> {
    try {
      const written = await this.prisma.aiToolJob.updateMany({
        where: { id: jobId },
        data: { providerRef: markerOf(copy) },
      });
      if (written.count > 0) return true;
      this.logger.warn(
        `ai job ${jobId}: no job to note the provider's copy on`,
      );
      return false;
    } catch {
      this.logger.warn(`ai job ${jobId}: the provider's copy was not noted`);
      return false;
    }
  }

  /**
   * The job has ended: try to delete the provider's copy now. A copy that is
   * not yet gone is tried again after the waits, in the background, and then
   * left to the sweep. Never throws; the first try is awaited, the rest are not.
   */
  async discard(jobId: string, copy: ProviderCopy): Promise<void> {
    const endedAt = Date.now();
    // A conversation's note may already say a delete was sent (REC-DELETE): that is the one thing a 404 is read by.
    const current =
      copy.kind === 'conversation'
        ? ((await this.pending(jobId, copy)) ?? { copy, absentSince: null })
        : { copy, absentSince: null };
    const first = await this.attempt(jobId, current, 0);
    if (first === 'cleared') return;
    // REC-DELETE round 1: the retry loops are shared. Past `retryLimit` running at once the rest wait for the sweep.
    if (this.retrying >= this.retryLimit) return;
    this.retrying += 1;
    void this.retry(jobId, copy, endedAt)
      .catch(() => undefined)
      .finally(() => {
        this.retrying -= 1;
      });
  }

  /**
   * `discard`, for a request: waits for it at most `requestWaitMs` and then lets it carry on in the background (the
   * provider's DELETE of a finished conversation takes 7 to 8 seconds), so the request does not wait for the provider.
   */
  async discardWithin(jobId: string, copy: ProviderCopy): Promise<void> {
    await this.within(this.discard(jobId, copy), undefined);
  }

  /** Resolves when the work a request stopped waiting for has ended. For specs and a clean stop. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  /** Waits for `work` at most `requestWaitMs`; if it is not done by then `fallback` is the answer and `work` carries on. */
  private async within<T>(work: Promise<T>, fallback: T): Promise<T> {
    const tracked = work.catch(() => fallback);
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), this.requestWaitMs);
      timer.unref();
    });
    try {
      return await Promise.race([tracked, wait]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async retry(
    jobId: string,
    copy: ProviderCopy,
    endedAt: number,
  ): Promise<void> {
    for (const wait of this.delaysMs) {
      if (!(await this.sleep(wait))) return;
      const noted = await this.pending(jobId, copy);
      if (noted === null) return; // the sweep cleared it
      const age = Date.now() - endedAt;
      if ((await this.attempt(jobId, noted, age)) === 'cleared') return;
    }
    // Still there after the minute: the marker stays and the sweep keeps trying.
  }

  /** Resolves true after `ms`, or false when the service is shutting down. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.closed) return resolve(false);
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve(!this.closed);
      }, ms);
      t.unref();
      this.timers.add(t);
    });
  }

  /**
   * One try at one copy. A cleaned item: a delete. A transcript, `confirming`
   * (the job ended at least `ai.copy_confirm_after_minutes` ago, or a first 404
   * is already noted): a read FIRST, with no delete just before it, because the
   * provider answers a read 404 for about a second after a delete (so a read
   * that follows a delete proves nothing); a 404 is `absent`, any other answer
   * is followed by a delete. A transcript sooner than that: a delete, then a
   * read whose answer proves nothing this soon and is not used.
   */
  private async tryOnce(
    copy: ProviderCopy,
    confirming: boolean,
  ): Promise<CopyTry> {
    if (copy.kind === 'voice') {
      // AITOOLS-07: the AI version of a person's own voice. The Hub knows the
      // voice exists (the provider named it), so a 404 means it is already gone.
      const removed = await this.voice.deleteOwnVoice(copy.id);
      return removed === 'failed' ? 'keep' : 'gone';
    }
    if (copy.kind === 'asset') {
      // AITOOLS-09, AITOOLS-10: the Hub knows each asset exists (the provider named
      // it), so a 404 means it is already gone; any other failure is tried again.
      let allGone = true;
      for (const id of assetIdsOf(copy)) {
        if ((await this.voice.removeAsset(id)) === 'failed') allGone = false;
      }
      return allGone ? 'gone' : 'keep';
    }
    if (copy.kind === 'podcast') {
      // AITOOLS-13: the Hub knows the project exists (the provider named it), so a 404 means it is already gone.
      const removed = await this.voice.removePodcast(copy.id);
      return removed === 'failed' ? 'keep' : 'gone';
    }
    if (copy.kind === 'isolation') {
      const removed = await this.voice.deleteIsolation(copy.id);
      return removed === 'deleted'
        ? 'gone'
        : removed === 'not_found'
          ? 'not_found'
          : 'keep';
    }
    // A transcript (Captions) and a dub's project (AITOOLS-05) are read and
    // deleted the same way, by their own routes: the same "two clean reads of
    // 404" rule applies to both.
    const present = (): Promise<CopyPresence> =>
      copy.kind === 'dub'
        ? this.voice.dubPresence(copy.id)
        : this.voice.transcriptPresence(copy.id);
    const remove = (): Promise<unknown> =>
      copy.kind === 'dub'
        ? this.voice.removeDub(copy.id)
        : this.voice.deleteTranscript(copy.id);
    if (confirming) {
      if ((await present()) === 'absent') return 'absent';
      await remove();
      return 'keep';
    }
    await remove();
    await present();
    return 'keep';
  }

  /**
   * One try on a noted copy, `age` ms after its job ended, and what it does to
   * the note: cleared, or kept (with the first 404 written into it, or taken
   * back out of it). Never throws.
   */
  private async attempt(
    jobId: string,
    noted: NotedCopy,
    age: number,
    now: number = Date.now(),
  ): Promise<'cleared' | 'kept'> {
    const { copy, absentSince } = noted;
    // REC-DELETE: a conversation is read before it is deleted, and cleared only on proof (below).
    if (copy.kind === 'conversation')
      return this.attemptConversation(jobId, noted, now, age);
    const { afterMs, gapMs } = this.confirmWindow();
    const outcome = await this.tryOnce(
      copy,
      age >= afterMs || absentSince !== null,
    );
    if (
      copy.kind === 'voice' ||
      copy.kind === 'isolation' ||
      copy.kind === 'asset' ||
      copy.kind === 'podcast'
    ) {
      if (
        outcome === 'gone' ||
        (outcome === 'not_found' && age >= NOT_STORED_YET_MS)
      ) {
        await this.clear(jobId, noted);
        return 'cleared';
      }
      return 'kept';
    }
    if (outcome !== 'absent') {
      // The copy is there (or the provider did not say): a first 404 is void.
      if (absentSince !== null)
        await this.rewrite(jobId, noted, markerOf(copy));
      return 'kept';
    }
    if (age < afterMs) return 'kept'; // too soon after the job to believe a 404
    if (absentSince === null) {
      await this.rewrite(jobId, noted, markerOf(copy, now));
      return 'kept';
    }
    if (now - absentSince < gapMs) return 'kept';
    await this.clear(jobId, noted);
    return 'cleared';
  }

  /** What a read of a conversation by id says: `absent` (404), `unknown` (no answer, or a fault), or its status. */
  private async seen(
    conversationId: string,
  ): Promise<'absent' | 'unknown' | ConversationRead['status']> {
    try {
      return (await this.voice.readConversation(conversationId)).status;
    } catch (e) {
      return e instanceof AiVoiceProviderError && e.status === 404
        ? 'absent'
        : 'unknown';
    }
  }

  /**
   * What the provider's LIST says about a conversation: `absent` (a complete read of the window does not hold it),
   * `unknown` (no answer, a page that cannot be read, or more than the pages read), or its status. REC-DELETE round 1:
   * a conversation whose agent was deleted while it was being finished reads 404 by id and is still listed (and a delete
   * by id still removes it), so a 404 by id alone never proves one gone. The window is the job's own time, widened.
   */
  private async listedAs(
    jobId: string,
    conversationId: string,
    now: number,
  ): Promise<'absent' | 'unknown' | ConversationRead['status']> {
    try {
      const row = await this.prisma.aiToolJob.findUnique({
        where: { id: jobId },
        select: { createdAt: true, finishedAt: true },
      });
      if (!row) return 'unknown';
      const listed = await this.voice.listConversations({
        afterUnix: Math.floor(
          (row.createdAt.getTime() - LIST_WINDOW_MARGIN_MS) / 1000,
        ),
        beforeUnix: Math.ceil(
          ((row.finishedAt?.getTime() ?? now) + LIST_WINDOW_MARGIN_MS) / 1000,
        ),
      });
      return (
        listed.find((c) => c.conversationId === conversationId)?.status ??
        'absent'
      );
    } catch {
      return 'unknown';
    }
  }

  /**
   * REC-DELETE: one try at a Receptionist conversation the provider kept. Real provider, 30 and 31 Oct 2026: a
   * conversation reads 404 for a moment after it is made, then `in-progress`, `processing` and (about 3 to 4 seconds
   * after the reply) `done`; a DELETE sent before `done` answers 204 and is ignored (the conversation reads 404 for a
   * second or two and then comes back as `done` with its words); a DELETE sent once it is `done` answers 204 and the
   * next read says 404 for good. If its agent is deleted while it is still being finished, it is kept, reads 404 by id
   * and stays in the provider's list. So:
   *   - a read by id that says 404 is looked up in the provider's list (not for a note younger than `LIST_AFTER_MS`
   *     with no delete sent: it is probably not stored yet). Listed and finished: it is deleted by id (the delete works
   *     on it). Listed and not finished: left alone. Not listed: the note is cleared only if a delete was sent after a
   *     read showed it finished (the marker `@<ms>`); otherwise the note stays (nothing proves it ever existed, or is gone);
   *   - a finished one is marked, deleted, and read again; the note is cleared only when that read says 404 AND the
   *     list no longer holds it.
   * Never throws; no log line holds an id of the provider.
   */
  private async attemptConversation(
    jobId: string,
    noted: NotedCopy,
    now: number,
    age: number,
  ): Promise<'cleared' | 'kept'> {
    const id = noted.copy.id;
    let status = await this.seen(id);
    if (status === 'unknown') return 'kept';
    if (status === 'absent') {
      if (noted.absentSince === null && age < LIST_AFTER_MS) return 'kept';
      status = await this.listedAs(jobId, id, now);
      if (status === 'unknown') return 'kept';
      if (status === 'absent') {
        if (noted.absentSince === null) return 'kept';
        await this.clear(jobId, noted);
        return 'cleared';
      }
    }
    if (status !== 'done' && status !== 'failed') return 'kept';
    // Marked before the delete is sent, so a delete whose answer is lost still counts when a later read says gone.
    let sent = noted;
    if (noted.absentSince === null) {
      const marked = { copy: noted.copy, absentSince: now };
      if (await this.rewrite(jobId, noted, markerOf(noted.copy, now)))
        sent = marked;
    }
    if ((await this.voice.deleteConversation(id)) === 'failed') return 'kept';
    if ((await this.seen(id)) !== 'absent') return 'kept';
    if ((await this.listedAs(jobId, id, now)) !== 'absent') return 'kept';
    await this.clear(jobId, sent);
    return 'cleared';
  }

  /**
   * REC-DELETE: the Receptionist's agent was just deleted at the provider. A 404 by id for one of its conversations
   * proves nothing now: the provider keeps one that was still being finished (listed, and 404 by id). So the note is
   * tried like any other (read, the list, a delete once finished, a read of both after it) and cleared only by that; a
   * note with no delete sent stays pending for the sweep. Waits for the provider at most `requestWaitMs`.
   */
  async afterAgentDeleted(
    jobId: string,
    copy: ProviderCopy,
  ): Promise<'cleared' | 'kept'> {
    // No such note on the row any more (cleared meanwhile): nothing is left to keep.
    const noted = await this.pending(jobId, copy);
    if (!noted) return 'cleared';
    return this.within(
      this.attemptConversation(jobId, noted, Date.now(), Infinity),
      'kept',
    );
  }

  /** The note as the row holds it now, or null when it is cleared or another copy's. */
  private async pending(
    jobId: string,
    copy: ProviderCopy,
  ): Promise<NotedCopy | null> {
    try {
      const row = await this.prisma.aiToolJob.findUnique({
        where: { id: jobId },
        select: { providerRef: true },
      });
      const noted = copyOfMarker(row?.providerRef ?? null);
      return noted && noted.copy.kind === copy.kind && noted.copy.id === copy.id
        ? noted
        : null;
    } catch {
      return { copy, absentSince: null };
    }
  }

  private async rewrite(
    jobId: string,
    from: NotedCopy,
    to: string,
  ): Promise<boolean> {
    try {
      const written = await this.prisma.aiToolJob.updateMany({
        where: {
          id: jobId,
          providerRef: markerOf(from.copy, from.absentSince ?? undefined),
        },
        data: { providerRef: to },
      });
      return written.count > 0;
    } catch {
      this.logger.warn(
        `ai job ${jobId}: the provider's copy note was not updated`,
      );
      return false;
    }
  }

  private async clear(jobId: string, noted: NotedCopy): Promise<void> {
    try {
      await this.prisma.aiToolJob.updateMany({
        where: {
          id: jobId,
          providerRef: markerOf(noted.copy, noted.absentSince ?? undefined),
        },
        data: { providerRef: null },
      });
    } catch {
      this.logger.warn(`ai job ${jobId}: the provider's copy was not cleared`);
    }
  }

  /**
   * One pass over the copies still noted on a job: tries each once. Returns
   * how many were cleared and how many are still pending.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'ai-provider-copy-sweep' })
  async sweep(
    now: Date = new Date(),
  ): Promise<{ cleared: number; pending: number }> {
    const out = { cleared: 0, pending: 0 };
    if (this.sweeping) return out;
    this.sweeping = true;
    try {
      const rows = await this.prisma.aiToolJob.findMany({
        where: {
          createdAt: {
            gte: new Date(now.getTime() - COPY_GIVE_UP_MS - 3_600_000),
          },
          AND: [
            {
              OR: [
                { providerRef: { startsWith: 'transcript:' } },
                { providerRef: { startsWith: 'isolation:' } },
                { providerRef: { startsWith: 'voice:' } },
                { providerRef: { startsWith: 'dub:' } },
                { providerRef: { startsWith: 'asset:' } },
                { providerRef: { startsWith: 'podcast:' } },
              ],
            },
            {
              OR: [
                {
                  state: { in: ['done', 'failed'] },
                  finishedAt: { lt: new Date(now.getTime() - 30_000) },
                },
                {
                  state: 'working',
                  createdAt: {
                    lt: new Date(now.getTime() - STALE_WORKING_MS),
                  },
                },
              ],
            },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH,
        select: {
          id: true,
          providerRef: true,
          createdAt: true,
          finishedAt: true,
        },
      });
      for (const row of rows) {
        const noted = copyOfMarker(row.providerRef);
        if (!noted) continue;
        const age = now.getTime() - (row.finishedAt ?? row.createdAt).getTime();
        if (
          (await this.attempt(row.id, noted, age, now.getTime())) === 'cleared'
        )
          out.cleared += 1;
        else if (age >= COPY_GIVE_UP_MS) {
          this.logger.error(
            `ai job ${row.id}: the provider's copy of a ${noted.copy.kind} was never removed; giving up`,
          );
          await this.clear(
            row.id,
            (await this.pending(row.id, noted.copy)) ?? noted,
          );
          out.cleared += 1;
        } else out.pending += 1;
      }
      await this.sweepConversations(now, out);
    } catch (e) {
      this.logger.error(
        `provider copy sweep: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    } finally {
      this.sweeping = false;
    }
    return out;
  }

  /**
   * REC-DELETE: the notes of Receptionist conversations, tried on the schedule of `conversationDue` (a job that ended
   * long ago is tried less often), at most `SWEEP_BATCH` tries a pass.
   *   - Bounded: only notes made in the last `CONVERSATION_GIVE_UP_MS` are read (the partial index serves it), so the
   *     read stays small however many jobs there are.
   *   - Fair: NEWEST FIRST, read in pages by (time, id). A burst of old notes that are stuck can never keep a newer note
   *     waiting; an old note that is due is tried when the newer ones leave room, and it is on the slow schedule anyway.
   *   - A note older than `CONVERSATION_GIVE_UP_MS` (and under 48 hours) is dropped with one warning each, by a separate
   *     small read: the provider's own one-day limit has passed.
   */
  private async sweepConversations(
    now: Date,
    out: { cleared: number; pending: number },
  ): Promise<void> {
    const nowMs = now.getTime();
    const settled = new Date(nowMs - 30_000);
    const giveUp = new Date(nowMs - CONVERSATION_GIVE_UP_MS);
    const select = {
      id: true,
      providerRef: true,
      createdAt: true,
      finishedAt: true,
    } as const;
    for (let round = 0; round < CONVERSATION_PAGES; round += 1) {
      const old = await this.prisma.aiToolJob.findMany({
        where: {
          providerRef: { startsWith: 'conversation:' },
          createdAt: {
            gte: new Date(nowMs - CONVERSATION_DROP_FLOOR_MS),
            lt: giveUp,
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: SWEEP_BATCH,
        select,
      });
      for (const row of old) {
        const noted = copyOfMarker(row.providerRef);
        if (!noted) continue;
        this.logger.warn(
          `ai job ${row.id}: a Receptionist conversation was not proven deleted within 25 hours; the provider's own limit has passed, so the note is dropped`,
        );
        await this.clear(
          row.id,
          (await this.pending(row.id, noted.copy)) ?? noted,
        );
        out.cleared += 1;
      }
      if (old.length < SWEEP_BATCH) break;
    }
    let last: { createdAt: Date; id: string } | null = null;
    let tries = 0;
    for (let page = 0; page < CONVERSATION_PAGES; page += 1) {
      const rows: {
        id: string;
        providerRef: string | null;
        createdAt: Date;
        finishedAt: Date | null;
      }[] = await this.prisma.aiToolJob.findMany({
        where: {
          AND: [
            { providerRef: { startsWith: 'conversation:' } },
            { createdAt: { gte: giveUp } },
            {
              OR: [
                {
                  state: { in: ['done', 'failed'] },
                  OR: [{ finishedAt: { lt: settled } }, { finishedAt: null }],
                },
                {
                  state: 'working',
                  createdAt: { lt: new Date(nowMs - STALE_WORKING_MS) },
                },
              ],
            },
            ...(last
              ? [
                  {
                    OR: [
                      { createdAt: { lt: last.createdAt } },
                      { createdAt: last.createdAt, id: { lt: last.id } },
                    ],
                  },
                ]
              : []),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: SWEEP_BATCH,
        select,
      });
      for (const row of rows) {
        const noted = copyOfMarker(row.providerRef);
        if (!noted || noted.copy.kind !== 'conversation') continue;
        const age = nowMs - (row.finishedAt ?? row.createdAt).getTime();
        if (!conversationDue(age) || tries >= SWEEP_BATCH) {
          out.pending += 1;
          continue;
        }
        tries += 1;
        if ((await this.attempt(row.id, noted, age, nowMs)) === 'cleared')
          out.cleared += 1;
        else out.pending += 1;
      }
      if (rows.length < SWEEP_BATCH) break;
      last = rows[rows.length - 1];
    }
  }
}
