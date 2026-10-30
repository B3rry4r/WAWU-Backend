import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { AiClonedVoice } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  AiToolError,
  CLONE_EXISTS_MESSAGE,
  CLONE_FULL_MESSAGE,
  OWN_VOICE_LINE_CHANGED_MESSAGE,
  OWN_VOICE_NAME_REQUIRED_MESSAGE,
} from '../ai-tools-error';
import type { SavedVoiceView } from '../ai-tools-view.type';
import { CLONE_SAMPLE_MAX_BYTES } from '../tools/file-checks';
import {
  CLONE_SAMPLE_MAX_SECONDS_SETTING,
  CLONE_SAMPLE_MIN_SECONDS_SETTING,
} from '../tools/my-voice.tool';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
  type CopyRemoval,
} from '../voice/ai-voice-provider';
import { FOLDER_CONTENT_TYPES } from '../../storage/dto/presign-upload.dto';

export const CLONES_PER_PERSON_SETTING = 'ai.clones_per_person';
export const CLONES_TOTAL_MAX_SETTING = 'ai.clones_total_max';
export const MY_VOICE_LISTED_SETTING = 'ai.listed.my-voice';

/**
 * The words a person agrees to before the Hub keeps a clone of their voice (AITOOLS-11, R-109). Like AITOOLS-07's line,
 * it names the person and not the provider (R-68), but it covers a copy that is KEPT until they remove it, and the voice
 * tools, not one VoiceOver. A person who removes the clone takes the agreement back with it.
 */
export function cloneConsentLineFor(name: string): string {
  const who = name.trim();
  if (!who) return OWN_VOICE_NAME_REQUIRED_MESSAGE;
  return `I am ${who}. I agree that Who Made This? may keep an AI version of my voice, and use it in my voice tools, until I remove it.`;
}

/**
 * THE SAVED CLONE OF A PERSON'S OWN VOICE (AITOOLS-11, R-109). The row is the Hub's record of a voice the provider
 * holds for the person; the provider's own id never leaves the Hub. Rules:
 *
 *   1. one clone a person (`ai.clones_per_person`) and a Hub-wide ceiling (`ai.clones_total_max`), both counted under
 *      one advisory lock together with the reservation, so two taps at once make one clone;
 *   2. the reservation is written BEFORE the provider is asked; the provider's id is filled the moment it answers;
 *   3. removing the clone takes it out of every list at once (`removedAt`); the row is deleted when the provider has
 *      dropped its copy (tried at once, then every minute by the sweep);
 *   4. a reservation or a clone whose job did not keep its points is given back (provider copy and row);
 *   5. account deletion removes every clone of the person at the provider first (`beforeErase`) and waits while one is
 *      left.
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a spec calls `sweep` directly.
 */
@Injectable()
export class AiCloneService {
  private readonly logger = new Logger(AiCloneService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
  ) {}

  /** The person's clone that voices can be made in now: the provider has answered and it is not removed. Settles stale rows first. */
  async activeFor(wawuUserId: string): Promise<AiClonedVoice | null> {
    const rows = await this.settle(wawuUserId);
    return (
      rows.find((r) => r.providerVoiceId !== null && r.removedAt === null) ??
      null
    );
  }

  /**
   * The person's live rows after the stale ones are given back: a reservation or a clone whose job ended failed (the
   * sweep gave its points back) or is gone is removed here, so a dead job can never block the person.
   */
  private async settle(wawuUserId: string): Promise<AiClonedVoice[]> {
    const rows = await this.prisma.aiClonedVoice.findMany({
      where: { wawuUserId, removedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const live: AiClonedVoice[] = [];
    for (const row of rows) {
      const job = await this.prisma.aiToolJob.findUnique({
        where: { id: row.jobId },
        select: { state: true },
      });
      if (!job || job.state === 'failed') await this.discardRow(row);
      else live.push(row);
    }
    return live;
  }

  async view(wawuUserId: string, name: string): Promise<SavedVoiceView> {
    const rows = await this.settle(wawuUserId);
    const row = rows[0] ?? null;
    const listed = this.settings.number(MY_VOICE_LISTED_SETTING) === 1;
    return {
      available: listed && this.voice.fileToolsConfigured,
      state: !row ? 'none' : row.providerVoiceId ? 'ready' : 'making',
      name: row ? row.name : null,
      createdAt: row?.providerVoiceId ? row.createdAt.toISOString() : null,
      consent: { line: cloneConsentLineFor(name) },
      sample: {
        folder: 'ai/input-audio',
        accepts: [...FOLDER_CONTENT_TYPES['ai/input-audio']],
        minSeconds: this.settings.number(CLONE_SAMPLE_MIN_SECONDS_SETTING),
        maxSeconds: this.settings.number(CLONE_SAMPLE_MAX_SECONDS_SETTING),
        maxBytes: CLONE_SAMPLE_MAX_BYTES,
      },
    };
  }

  /** Refuses (nothing held) when the person already has a clone or the Hub is at its ceiling. */
  async assertCanMake(wawuUserId: string): Promise<void> {
    await this.settle(wawuUserId);
    const [mine, all] = await Promise.all([
      this.prisma.aiClonedVoice.count({ where: { wawuUserId } }),
      this.prisma.aiClonedVoice.count(),
    ]);
    if (mine >= this.settings.number(CLONES_PER_PERSON_SETTING))
      throw new AiToolError('clone_exists', CLONE_EXISTS_MESSAGE);
    if (all >= this.settings.number(CLONES_TOTAL_MAX_SETTING))
      throw new AiToolError('ai_tool_unavailable', CLONE_FULL_MESSAGE);
  }

  /** Checks the words the person agreed to are exactly the ones the Hub served for them. */
  assertConsent(name: string, line: string): void {
    if (name.trim() === '')
      throw new AiToolError(
        'own_voice_name_required',
        OWN_VOICE_NAME_REQUIRED_MESSAGE,
      );
    if (line !== cloneConsentLineFor(name))
      throw new AiToolError(
        'own_voice_consent_line_changed',
        OWN_VOICE_LINE_CHANGED_MESSAGE,
      );
  }

  /**
   * Writes the reservation for a job under ONE advisory lock with the counts, so two jobs at once cannot both pass.
   * The lock covers only these database statements, never the provider call. `'exists'` / `'full'` when it cannot.
   */
  async reserve(
    wawuUserId: string,
    jobId: string,
    name: string,
    consentLine: string,
    now: Date = new Date(),
  ): Promise<'reserved' | 'exists' | 'full'> {
    const perPerson = this.settings.number(CLONES_PER_PERSON_SETTING);
    const total = this.settings.number(CLONES_TOTAL_MAX_SETTING);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wawu-ai-cloned-voice'))`;
      const already = await tx.aiClonedVoice.findUnique({ where: { jobId } });
      if (already) return 'reserved';
      const mine = await tx.aiClonedVoice.count({ where: { wawuUserId } });
      if (mine >= perPerson) return 'exists';
      if ((await tx.aiClonedVoice.count()) >= total) return 'full';
      await tx.aiClonedVoice.create({
        data: { wawuUserId, jobId, name, consentLine, consentAt: now },
      });
      return 'reserved';
    });
  }

  /**
   * The provider has answered: its id goes on the reservation at once, so a server that dies after this still knows the
   * voice is there. `kept`: the reservation stands. `removed`: the person removed it meanwhile (the id is on the row, so
   * the removal path deletes the voice). `missing`: no row at all (the account is going), so the caller deletes the voice.
   */
  async attach(
    jobId: string,
    providerVoiceId: string,
  ): Promise<'kept' | 'removed' | 'missing'> {
    const done = await this.prisma.aiClonedVoice.updateMany({
      where: { jobId },
      data: { providerVoiceId },
    });
    if (done.count === 0) return 'missing';
    const row = await this.prisma.aiClonedVoice.findUnique({
      where: { jobId },
      select: { removedAt: true },
    });
    return row && row.removedAt === null ? 'kept' : 'removed';
  }

  /** The job did not keep its points: the reservation, and any voice the provider made, are given back. Never throws. */
  async discardByJob(jobId: string): Promise<void> {
    try {
      const row = await this.prisma.aiClonedVoice.findUnique({
        where: { jobId },
      });
      if (row) await this.discardRow(row);
    } catch {
      this.logger.warn(`a clone of a voice was not given back yet (${jobId})`);
    }
  }

  /** Removes one row: at the provider first, then the row. A provider that cannot be reached leaves the row marked removed for the sweep. */
  private async discardRow(row: AiClonedVoice): Promise<CopyRemoval | 'none'> {
    if (!row.providerVoiceId) {
      await this.prisma.aiClonedVoice.deleteMany({ where: { id: row.id } });
      return 'none';
    }
    if (row.removedAt === null)
      await this.prisma.aiClonedVoice.updateMany({
        where: { id: row.id, removedAt: null },
        data: { removedAt: new Date() },
      });
    const gone = await this.voice.deleteOwnVoice(row.providerVoiceId);
    if (gone === 'deleted' || gone === 'not_found')
      await this.prisma.aiClonedVoice.deleteMany({ where: { id: row.id } });
    return gone;
  }

  /**
   * `DELETE /ai-tools/my-voice`: every clone of the person leaves their lists at once and is deleted at the provider.
   * `gone` when the provider holds none now, `pending` while the Hub is still removing one.
   */
  async remove(wawuUserId: string): Promise<'gone' | 'pending'> {
    const rows = await this.prisma.aiClonedVoice.findMany({
      where: { wawuUserId },
    });
    for (const row of rows) await this.discardRow(row);
    const left = await this.prisma.aiClonedVoice.count({
      where: { wawuUserId },
    });
    return left === 0 ? 'gone' : 'pending';
  }

  /** The account is being erased: every clone of the person is removed at the provider first. Throws while one is left (the purge waits). */
  async beforeErase(wawuUserId: string): Promise<void> {
    // A reservation still being made is removed too: its job will find it gone and delete the voice it made.
    const rows = await this.prisma.aiClonedVoice.findMany({
      where: { wawuUserId },
    });
    for (const row of rows) await this.discardRow(row);
    const left = await this.prisma.aiClonedVoice.count({
      where: { wawuUserId },
    });
    if (left > 0) {
      this.logger.warn(
        `account purge: ${left} saved voice(s) of one person are still held by the AI provider; the purge waits`,
      );
      throw new Error(
        'The AI provider still holds a saved voice. The purge will try again.',
      );
    }
  }

  /** Every minute: voices that were removed and not yet dropped by the provider, and reservations whose job is dead. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'ai-cloned-voice-sweep' })
  async sweep(): Promise<{ removed: number; left: number }> {
    if (this.sweeping) return { removed: 0, left: 0 };
    this.sweeping = true;
    let removed = 0;
    try {
      const pending = await this.prisma.aiClonedVoice.findMany({
        where: { removedAt: { not: null } },
        take: 50,
      });
      for (const row of pending) {
        const r = await this.discardRow(row);
        if (r === 'deleted' || r === 'not_found' || r === 'none') removed += 1;
      }
      const stale = await this.prisma.aiClonedVoice.findMany({
        where: {
          removedAt: null,
          createdAt: { lt: new Date(Date.now() - 3_600_000) },
        },
        take: 50,
      });
      for (const row of stale) {
        const job = await this.prisma.aiToolJob.findUnique({
          where: { id: row.jobId },
          select: { state: true },
        });
        if (!job || job.state === 'failed') {
          await this.discardRow(row);
          removed += 1;
        }
      }
    } catch (e) {
      this.logger.warn(
        `saved voice sweep: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    } finally {
      this.sweeping = false;
    }
    return {
      removed,
      left: await this.prisma.aiClonedVoice.count({
        where: { removedAt: { not: null } },
      }),
    };
  }
}
