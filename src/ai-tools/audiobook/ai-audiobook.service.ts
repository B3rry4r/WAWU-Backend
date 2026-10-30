import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { AiToolJob } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { AiJobService } from '../ai-job.service';
import {
  AI_AUDIO_STORE,
  AI_AUDIOBOOK_PART_FOLDER,
  type AiAudioStore,
} from '../audio/ai-audio-store';
import { AiInputService } from '../input/ai-input-files';
import { AI_MEDIA_STORE, type AiMediaStore } from '../media/ai-media-store';
import {
  AUDIOBOOK_ACTION,
  AUDIOBOOK_MAX_RUN_SETTING,
  AUDIOBOOK_MODEL_SETTING,
} from '../tools/audiobook.tool';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
} from '../voice/ai-voice-provider';
import { chunkBook, contextOf } from './audiobook-chunks';
import { parseBookRef, partKeyFor } from './audiobook-support';
import { Mp3Error, readMp3, sameFormat, type Mp3Body } from './mp3-join';

/** Tries at one chapter (each on a later pass) before the job gives up and every point goes back. */
export const CHAPTER_TRIES = 3;
/** The most one chapter file may be: a chapter is under 10,000 characters, about ten minutes of audio. */
const MAX_CHAPTER_BYTES = 64 * 1024 * 1024;
const PASS_BATCH = 20;
/** The most bytes of kept text one job reads back: the setting's characters are at most four bytes each. */
const TEXT_READ_CAP = 4 * 1024 * 1024;

export interface AudiobookPass {
  read: number;
  done: number;
  failed: number;
  waiting: number;
}

/**
 * SPEAKS THE AUDIOBOOKS (AITOOLS-13, R-109). A job holds the points for the whole text up front and stays `working`; its
 * row notes how many chapters the text makes (`bookrun:<chapters>:<size>`) and the words are kept in a private file
 * until the job ends. Every few seconds this takes each working audiobook one step: it speaks the next chapter that has
 * no file yet (the speech route, with the words before and after it so the voice carries over), stores it, and when
 * every chapter has a file it joins them into ONE mp3 streamed to storage (one chapter in memory at a time), COMMITS the
 * hold and marks the job done. The place the Hub keeps is the chapter files themselves, so a Hub that restarts carries
 * on with the next chapter and never speaks one twice, holds twice or charges twice. A chapter the provider refuses, a
 * file that is not whole mp3, a format that changes between chapters, or the longest run (`ai.audiobook_max_run_minutes`)
 * gives every point back and removes the chapter files. No transaction, connection or lock is held across a provider
 * call. One pass at a time; one server runs the cron (a second would at worst speak a chapter twice).
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a spec calls `pass` directly.
 */
@Injectable()
export class AiAudiobookService {
  private readonly logger = new Logger(AiAudiobookService.name);
  private passing = false;
  /** Failed tries at a chapter by job and chapter (a restart only gives more tries; the longest run still ends it). */
  private readonly tries = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    @Inject(AI_AUDIO_STORE) private readonly audio: AiAudioStore,
    @Inject(AI_MEDIA_STORE) private readonly media: AiMediaStore,
    private readonly input: AiInputService,
    private readonly jobs: AiJobService,
  ) {}

  @Cron('*/5 * * * * *', { name: 'ai-audiobook-follow' })
  async tick(): Promise<void> {
    try {
      await this.pass();
    } catch (e) {
      this.logger.error(
        `audiobook follower: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    }
  }

  /** One pass over the working audiobooks: one step each. Never throws for one job's trouble. */
  async pass(now: Date = new Date()): Promise<AudiobookPass> {
    const out: AudiobookPass = { read: 0, done: 0, failed: 0, waiting: 0 };
    if (this.passing) return out;
    this.passing = true;
    try {
      const rows = await this.prisma.aiToolJob.findMany({
        where: { tool: AUDIOBOOK_ACTION, state: 'working' },
        orderBy: { createdAt: 'asc' },
        take: PASS_BATCH,
      });
      for (const row of rows) {
        out.read += 1;
        const outcome = await this.follow(row, now).catch((e: unknown) => {
          this.logger.warn(
            `ai job ${row.id} (audiobook): a pass could not follow it (${(e as Error).name ?? 'Error'})`,
          );
          return 'waiting' as const;
        });
        out[outcome] += 1;
      }
    } finally {
      this.passing = false;
    }
    return out;
  }

  /** The chapter files this job has stored, by index. */
  private async stored(job: AiToolJob): Promise<Set<number>> {
    const keys = await this.audio.list(
      job.wawuUserId,
      AI_AUDIOBOOK_PART_FOLDER,
      `${job.id}-c`,
    );
    const have = new Set<number>();
    for (const k of keys) {
      const m = /-c(\d+)\.mp3$/.exec(k);
      if (m) have.add(Number(m[1]));
    }
    return have;
  }

  private async follow(
    seen: AiToolJob,
    now: Date,
  ): Promise<'done' | 'failed' | 'waiting'> {
    // A hold the sweep gave back, or a commit a dead run left, ends the job here.
    const job = await this.jobs.reconcile(seen);
    if (job.state !== 'working')
      return job.state === 'done' ? 'done' : 'failed';
    const limitMs = this.settings.number(AUDIOBOOK_MAX_RUN_SETTING) * 60_000;
    if (now.getTime() - job.createdAt.getTime() > limitMs) {
      this.logger.warn(
        `ai job ${job.id} (audiobook): still working past its longest run`,
      );
      await this.jobs.failFollowed(job.id, 'timed_out', null);
      return 'failed';
    }
    const ref = parseBookRef(job.providerRef);
    // The first step has not noted its chapters yet (the request is still starting): the longest run ends it.
    if (!ref || !job.inputRef) return 'waiting';

    let chapters: string[];
    try {
      const text = await this.input.readKeptText(job.inputRef, TEXT_READ_CAP);
      chapters = chunkBook(text, ref.chunkChars);
    } catch {
      await this.jobs.failFollowed(job.id, 'file_unreadable', null);
      return 'failed';
    }
    if (chapters.length !== ref.chapters) {
      this.logger.error(
        `ai job ${job.id} (audiobook): the words no longer make ${ref.chapters} chapters`,
      );
      await this.jobs.failFollowed(job.id, 'provider_failed', null);
      return 'failed';
    }

    const have = await this.stored(job);
    let next = 0;
    while (next < chapters.length && have.has(next)) next += 1;
    if (next < chapters.length) return this.speak(job, chapters, next);
    return this.join(job, chapters.length);
  }

  /** Speaks chapter `index` and stores it. A refusal ends the job; a try that may work later is tried again on a later pass. */
  private async speak(
    job: AiToolJob,
    chapters: readonly string[],
    index: number,
  ): Promise<'failed' | 'waiting'> {
    const around = contextOf(chapters, index);
    const tryKey = `${job.id}:${index}`;
    try {
      const spoken = await this.voice.speakChapter({
        voiceId: job.voiceId,
        text: chapters[index],
        model: this.settings.lines(AUDIOBOOK_MODEL_SETTING)[0],
        previousText: around.previous,
        nextText: around.next,
      });
      if (spoken.audio.length > MAX_CHAPTER_BYTES)
        throw new Mp3Error('too big');
      // A chapter that is not whole mpeg audio is refused here, before it is kept (the join would otherwise skip or play wrong).
      readMp3(spoken.audio);
      await this.audio.put(
        job.wawuUserId,
        `${job.id}-c${index}`,
        spoken.audio,
        'audio/mpeg',
        AI_AUDIOBOOK_PART_FOLDER,
      );
      this.tries.delete(tryKey);
      return 'waiting';
    } catch (e) {
      const status = e instanceof AiVoiceProviderError ? e.status : undefined;
      const rejected =
        (e instanceof AiVoiceProviderError && e.kind === 'rejected') ||
        e instanceof Mp3Error;
      const tries = (this.tries.get(tryKey) ?? 0) + 1;
      this.logger.warn(
        `ai job ${job.id} (audiobook): chapter ${index + 1} was not made (try ${tries}${
          status !== undefined ? `, the provider answered ${status}` : ''
        })`,
      );
      if (!rejected && tries < CHAPTER_TRIES) {
        this.tries.set(tryKey, tries);
        return 'waiting';
      }
      this.tries.delete(tryKey);
      await this.jobs.failFollowed(
        job.id,
        rejected ? 'provider_failed' : 'provider_unavailable',
        null,
      );
      return 'failed';
    }
  }

  /** Every chapter has its file: join them into one mp3, streamed to storage, and finish the job. */
  private async join(
    job: AiToolJob,
    chapters: number,
  ): Promise<'done' | 'failed' | 'waiting'> {
    const media = this.media;
    const keys = Array.from({ length: chapters }, (_, i) =>
      partKeyFor(job.wawuUserId, job.id, i),
    );
    async function* pieces(): AsyncGenerator<Buffer> {
      let first: Mp3Body | null = null;
      for (const key of keys) {
        const { audio } = await media.read(key, MAX_CHAPTER_BYTES);
        const body = readMp3(audio);
        if (first === null) first = body;
        else if (!sameFormat(first, body)) throw new Mp3Error('format changes');
        yield body.body;
      }
    }
    const stream = Readable.from(pieces(), { objectMode: false });
    await this.jobs.completeFollowed(job.id, {
      media: {
        kind: 'audio',
        contentType: 'audio/mpeg',
        bytes: null,
        stream,
        close: () => stream.destroy(),
      },
    });
    const after = await this.prisma.aiToolJob.findUnique({
      where: { id: job.id },
      select: { state: true },
    });
    return after?.state === 'done'
      ? 'done'
      : after?.state === 'failed'
        ? 'failed'
        : 'waiting';
  }
}
