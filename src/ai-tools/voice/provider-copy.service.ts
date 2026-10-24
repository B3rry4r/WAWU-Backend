import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
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
 * How one try went. `gone`: a cleaned item's delete answered 2xx (confirmed).
 * `not_found`: a cleaned item's delete answered 404 (gone or not stored yet;
 * the sweep decides by age). `absent`: a transcript's read, after the delete,
 * said 404 (a first sign only: see `COPY_CONFIRM_AFTER_SETTING`). `keep`: the
 * copy is there or the provider did not say; try again.
 */
export type CopyTry = 'gone' | 'not_found' | 'absent' | 'keep';

/**
 * What a job's `providerRef` holds while the provider's copy is not yet
 * confirmed deleted: `transcript:<id>` or `isolation:<id>`; for a transcript
 * that has answered 404 once after the confirm window opened, `@<ms>` is added
 * (when that first 404 was read), and a later read of the copy removes it.
 */
export function markerOf(copy: ProviderCopy, absentSince?: number): string {
  return `${copy.kind}:${copy.id}${absentSince === undefined ? '' : `@${absentSince}`}`;
}

export interface NotedCopy {
  copy: ProviderCopy;
  /** When a read of the transcript first said 404 in the confirm window (ms), if it has. */
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
  if ((kind !== 'transcript' && kind !== 'isolation') || id === '') return null;
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
  private closed = false;
  private sweeping = false;
  private readonly timers = new Set<NodeJS.Timeout>();

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

  /** Notes the provider's copy on the job's row. Never throws. */
  async note(jobId: string, copy: ProviderCopy): Promise<void> {
    try {
      await this.prisma.aiToolJob.updateMany({
        where: { id: jobId },
        data: { providerRef: markerOf(copy) },
      });
    } catch {
      this.logger.warn(`ai job ${jobId}: the provider's copy was not noted`);
    }
  }

  /**
   * The job has ended: try to delete the provider's copy now. A copy that is
   * not yet gone is tried again after the waits, in the background, and then
   * left to the sweep. Never throws; the first try is awaited, the rest are not.
   */
  async discard(jobId: string, copy: ProviderCopy): Promise<void> {
    const endedAt = Date.now();
    const first = await this.attempt(jobId, { copy, absentSince: null }, 0);
    if (first === 'cleared') return;
    void this.retry(jobId, copy, endedAt).catch(() => undefined);
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
    if (copy.kind === 'isolation') {
      const removed = await this.voice.deleteIsolation(copy.id);
      return removed === 'deleted'
        ? 'gone'
        : removed === 'not_found'
          ? 'not_found'
          : 'keep';
    }
    if (confirming) {
      if ((await this.voice.transcriptPresence(copy.id)) === 'absent')
        return 'absent';
      await this.voice.deleteTranscript(copy.id);
      return 'keep';
    }
    await this.voice.deleteTranscript(copy.id);
    await this.voice.transcriptPresence(copy.id);
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
    const { afterMs, gapMs } = this.confirmWindow();
    const outcome = await this.tryOnce(
      copy,
      age >= afterMs || absentSince !== null,
    );
    if (copy.kind === 'isolation') {
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
  ): Promise<void> {
    try {
      await this.prisma.aiToolJob.updateMany({
        where: {
          id: jobId,
          providerRef: markerOf(from.copy, from.absentSince ?? undefined),
        },
        data: { providerRef: to },
      });
    } catch {
      this.logger.warn(
        `ai job ${jobId}: the provider's copy note was not updated`,
      );
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
    } catch (e) {
      this.logger.error(
        `provider copy sweep: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    } finally {
      this.sweeping = false;
    }
    return out;
  }
}
