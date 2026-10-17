import { Injectable } from '@nestjs/common';
import { StorageService } from '../../storage/storage.service';

/**
 * Where a finished job's audio is kept (AITOOLS-01). One seam so a spec can
 * run the whole job without a bucket; production is `StorageAiAudioStore`.
 */
export const AI_AUDIO_STORE = Symbol('AI_AUDIO_STORE');

export const AI_AUDIO_FOLDER = 'ai/voiceover';

export interface AiAudioStore {
  /** Keeps the audio for the job and returns its key. Writing the same job again replaces it. */
  put(
    wawuUserId: string,
    jobId: string,
    audio: Buffer,
    contentType: 'audio/mpeg',
  ): Promise<string>;
  /** A link the person's app plays the audio from. */
  urlFor(key: string): Promise<string>;
  /** Drops the audio of a job that did not keep its points. Never throws. */
  remove(key: string): Promise<void>;
}

/** The Hub's own object storage, with the file recorded as the person's (their account deletion removes it). */
@Injectable()
export class StorageAiAudioStore implements AiAudioStore {
  constructor(private readonly storage: StorageService) {}

  put(
    wawuUserId: string,
    jobId: string,
    audio: Buffer,
    contentType: 'audio/mpeg',
  ): Promise<string> {
    return this.storage.putGenerated(
      wawuUserId,
      AI_AUDIO_FOLDER,
      jobId,
      audio,
      contentType,
    );
  }

  urlFor(key: string): Promise<string> {
    return this.storage.readUrlFor(key);
  }

  remove(key: string): Promise<void> {
    return this.storage.removeGenerated(key);
  }
}

/** The key a job's audio is stored under: one per job, so the job can find it again without a column write. */
export function audioKeyFor(wawuUserId: string, jobId: string): string {
  return `${AI_AUDIO_FOLDER}/${wawuUserId}/${jobId}.mp3`;
}
