import { Injectable } from '@nestjs/common';
import { StorageService } from '../../storage/storage.service';

/**
 * Where a finished job's audio is kept (AITOOLS-01). One seam so a spec can
 * run the whole job without a bucket; production is `StorageAiAudioStore`.
 */
export const AI_AUDIO_STORE = Symbol('AI_AUDIO_STORE');

export const AI_AUDIO_FOLDER = 'ai/voiceover';
/** A Sound effect job's audio (AITOOLS-03), under its own folder. */
export const AI_SFX_FOLDER = 'ai/sound-effect';
/** A Music track job's audio (AITOOLS-03), under its own folder. */
export const AI_MUSIC_FOLDER = 'ai/music';
/** Every folder the AI tools write audio to: each is the person's own, so their account deletion removes it. */
export const AI_AUDIO_FOLDERS = [
  AI_AUDIO_FOLDER,
  AI_SFX_FOLDER,
  AI_MUSIC_FOLDER,
] as const;
export type AiAudioFolder = (typeof AI_AUDIO_FOLDERS)[number];

export interface AiAudioStore {
  /**
   * Keeps the audio for the job and returns its key. Writing the same job
   * again replaces it. `folder` is the tool's own (VoiceOver's when left out).
   */
  put(
    wawuUserId: string,
    jobId: string,
    audio: Buffer,
    contentType: 'audio/mpeg',
    folder?: AiAudioFolder,
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
    folder: AiAudioFolder = AI_AUDIO_FOLDER,
  ): Promise<string> {
    return this.storage.putGenerated(
      wawuUserId,
      folder,
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
export function audioKeyFor(
  wawuUserId: string,
  jobId: string,
  folder: AiAudioFolder = AI_AUDIO_FOLDER,
): string {
  return `${folder}/${wawuUserId}/${jobId}.mp3`;
}
