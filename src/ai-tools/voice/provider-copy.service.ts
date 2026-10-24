import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
  type CopyRemoval,
  type ProviderCopy,
} from './ai-voice-provider';

/**
 * After the first try, the waits before each next try in the minute that
 * follows a job (2, 6, 15 and 40 seconds: five tries over about a minute).
 */
export const COPY_TRY_DELAYS_MS = [2_000, 6_000, 15_000, 40_000];
/**
 * A 404 within this long of the provider's answer means "not stored yet"
 * (seen on the real provider: 404 at 89 ms, then 200 about 40 s later), so the
 * copy is still there to delete. Later, a 404 means it is gone.
 */
export const NOT_STORED_YET_MS = 10 * 60_000;
/** The longest the Hub keeps trying; then it logs that the copy was never removed. */
export const COPY_GIVE_UP_MS = 24 * 60 * 60_000;
/** A job still `working` this long after it started is swept too (its run died). */
const STALE_WORKING_MS = 15 * 60_000;
const SWEEP_BATCH = 50;

/** What a job's `providerRef` holds while the provider's copy is not yet confirmed deleted: `transcript:<id>` or `isolation:<id>`. */
export function markerOf(copy: ProviderCopy): string {
  return `${copy.kind}:${copy.id}`;
}

export function copyOfMarker(marker: string | null): ProviderCopy | null {
  if (!marker) return null;
  const at = marker.indexOf(':');
  const kind = marker.slice(0, at);
  const id = marker.slice(at + 1);
  if ((kind !== 'transcript' && kind !== 'isolation') || id === '') return null;
  return { kind, id };
}

/**
 * The provider keeps no copy of a person's words or voice (AITOOLS-04, round
 * 2). Deleting the copy once is not enough: the real provider answers 404 for
 * a transcript it has not stored yet. So a copy is deleted like this:
 *
 *   1. the job notes the copy on its row (`providerRef`, a marker) as soon as
 *      the provider has answered, so a server that dies still knows about it;
 *   2. when the job has ended, one try now, then four more over about a minute
 *      with growing waits, outside the job (a timer; the job is already done);
 *   3. a copy still there is left to the sweep, which tries every minute: a
 *      2xx clears the marker; a 404 clears it only once the copy has had
 *      `NOT_STORED_YET_MS` to be stored (before that it may not be there yet);
 *      any other answer keeps trying until `COPY_GIVE_UP_MS`, then logs.
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
  ) {}

  onModuleDestroy(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
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
    const first = await this.tryOnce(copy);
    if (first === 'deleted') {
      await this.clear(jobId, copy);
      return;
    }
    void this.retry(jobId, copy).catch(() => undefined);
  }

  private async retry(jobId: string, copy: ProviderCopy): Promise<void> {
    for (const wait of this.delaysMs) {
      if (!(await this.sleep(wait))) return;
      if (!(await this.pending(jobId, copy))) return; // the sweep cleared it
      if ((await this.tryOnce(copy)) === 'deleted') {
        await this.clear(jobId, copy);
        return;
      }
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

  private tryOnce(copy: ProviderCopy): Promise<CopyRemoval> {
    return copy.kind === 'transcript'
      ? this.voice.deleteTranscript(copy.id)
      : this.voice.deleteIsolation(copy.id);
  }

  private async pending(jobId: string, copy: ProviderCopy): Promise<boolean> {
    try {
      const row = await this.prisma.aiToolJob.findUnique({
        where: { id: jobId },
        select: { providerRef: true },
      });
      return row?.providerRef === markerOf(copy);
    } catch {
      return true;
    }
  }

  private async clear(jobId: string, copy: ProviderCopy): Promise<void> {
    try {
      await this.prisma.aiToolJob.updateMany({
        where: { id: jobId, providerRef: markerOf(copy) },
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
        const copy = copyOfMarker(row.providerRef);
        if (!copy) continue;
        const age = now.getTime() - (row.finishedAt ?? row.createdAt).getTime();
        const outcome = await this.tryOnce(copy);
        const gone =
          outcome === 'deleted' ||
          (outcome === 'not_found' && age >= NOT_STORED_YET_MS);
        if (gone) {
          await this.clear(row.id, copy);
          out.cleared += 1;
        } else if (age >= COPY_GIVE_UP_MS) {
          this.logger.error(
            `ai job ${row.id}: the provider's copy of a ${copy.kind} was never removed; giving up`,
          );
          await this.clear(row.id, copy);
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
