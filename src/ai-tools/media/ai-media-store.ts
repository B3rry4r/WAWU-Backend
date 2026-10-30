import type { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { StorageService } from '../../storage/storage.service';
import { AI_IMAGE_FOLDER, AI_VIDEO_FOLDER } from '../audio/ai-audio-store';
import { formatRule, type UploadFormatId } from '../../storage/upload-formats';

/**
 * Where a finished Studio picture or video is kept, and how a result becomes
 * a piece (AITOOLS-08, R-109). One seam so a spec can run whole jobs without a
 * bucket; production is `StorageAiMediaStore`. The audio of the older tools
 * stays on `AI_AUDIO_STORE`, which a Buffer fits; a video is a stream.
 */
export const AI_MEDIA_STORE = Symbol('AI_MEDIA_STORE');

export { AI_IMAGE_FOLDER, AI_VIDEO_FOLDER };
/** Every folder the Studio picture and video tools write to: each is the person's own, so their account deletion removes it. */
export const AI_MEDIA_FOLDERS = [AI_IMAGE_FOLDER, AI_VIDEO_FOLDER] as const;
export type AiMediaFolder = (typeof AI_MEDIA_FOLDERS)[number];

/** What a Studio result may be, by kind: the types the Hub serves. A type outside these fails the job and every point goes back. */
export const AI_IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export const AI_VIDEO_CONTENT_TYPES = ['video/mp4'] as const;

const MB = 1024 * 1024;
/** The most one result may be: a request bound, not a product figure. A video follows the largest file the Create flow takes (512 MB). */
export const AI_MEDIA_MAX_BYTES = {
  image: 64 * MB,
  video: 512 * MB,
} as const;

/** A stored result as the store knows it. */
export interface StoredMedia {
  key: string;
  bytes: number;
}

export interface AiMediaStore {
  /**
   * Keeps a result, streamed (never held whole), for the job, and returns its
   * key and size. Writing the same job again replaces it.
   */
  put(
    wawuUserId: string,
    jobId: string,
    stream: Readable,
    contentType: string,
    folder: AiMediaFolder,
    maxBytes: number,
  ): Promise<StoredMedia>;
  /** A link the person's app plays or shows the file from. */
  urlFor(key: string): Promise<string>;
  /** A link that saves the file under a plain file name (AITOOLS-08). */
  downloadUrlFor(key: string, fileName: string): Promise<string>;
  /** Drops a result of a job that did not keep its points. Never throws. */
  remove(key: string): Promise<void>;
  /** A stored result's bytes (Talking photo reading a finished voice result for its length). Throws when it cannot be read or is over `maxBytes`. */
  read(
    key: string,
    maxBytes: number,
  ): Promise<{ audio: Buffer; contentType: string }>;
  /** A stored result opened to be streamed to the provider: its real length and a stream of exactly that many bytes. */
  open(
    key: string,
    maxBytes: number,
  ): Promise<{ stream: Readable; bytes: number; contentType: string }>;
  /** The result copied into the person's own content folder as an upload counted like any (AITOOLS-08); see `StorageService.copyIntoContent`. */
  copyIntoContent(
    wawuUserId: string,
    sourceKey: string,
    seed: string,
  ): Promise<{
    key: string;
    fileUrl: string;
    bytes: number;
    contentType: string;
    replayed: boolean;
  }>;
}

/** The Hub's own object storage, with the file recorded as the person's (their account deletion removes it). */
@Injectable()
export class StorageAiMediaStore implements AiMediaStore {
  constructor(private readonly storage: StorageService) {}

  put(
    wawuUserId: string,
    jobId: string,
    stream: Readable,
    contentType: string,
    folder: AiMediaFolder,
    maxBytes: number,
  ): Promise<StoredMedia> {
    return this.storage.putGeneratedStream(
      wawuUserId,
      folder,
      jobId,
      stream,
      contentType,
      maxBytes,
    );
  }

  urlFor(key: string): Promise<string> {
    return this.storage.readUrlFor(key);
  }

  downloadUrlFor(key: string, fileName: string): Promise<string> {
    return this.storage.downloadUrlFor(key, fileName);
  }

  remove(key: string): Promise<void> {
    return this.storage.removeGenerated(key);
  }

  read(
    key: string,
    maxBytes: number,
  ): Promise<{ audio: Buffer; contentType: string }> {
    return this.storage.readStored(key, maxBytes);
  }

  async open(
    key: string,
    maxBytes: number,
  ): Promise<{ stream: Readable; bytes: number; contentType: string }> {
    const o = await this.storage.openStored(key, maxBytes);
    return { stream: o.body, bytes: o.length, contentType: o.contentType };
  }

  copyIntoContent(wawuUserId: string, sourceKey: string, seed: string) {
    return this.storage.copyIntoContent(wawuUserId, sourceKey, seed);
  }
}

/** The key a job's result is stored under: one per job, so the job can find it again without a column write. */
export function mediaKeyFor(
  wawuUserId: string,
  jobId: string,
  folder: AiMediaFolder,
  extension: string,
): string {
  return `${folder}/${wawuUserId}/${jobId}.${extension}`;
}

/** The Create format that takes a file of this type (`GET /uploads/formats`), or null when no format takes it (a FLAC dub, an AAC clip). */
export function pieceFormatFor(
  contentType: string,
): 'video' | 'audio' | 'image' | null {
  const order: UploadFormatId[] = ['video', 'audio', 'image'];
  for (const id of order)
    if (formatRule(id).full.contentTypes.includes(contentType))
      return id as 'video' | 'audio' | 'image';
  return null;
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** A day as the files and titles write it: "30 oct 2026" in Lagos time (the Hub's people live there). */
export function dayText(at: Date): {
  day: number;
  month: string;
  year: number;
} {
  const lagos = new Date(at.getTime() + 60 * 60 * 1000);
  return {
    day: lagos.getUTCDate(),
    month: MONTHS[lagos.getUTCMonth()],
    year: lagos.getUTCFullYear(),
  };
}

/** The plain file name a download saves under: `studio-image-30-oct-2026.png`. No provider or model name, no person's name. */
export function downloadNameFor(
  toolId: string,
  at: Date,
  extension: string,
): string {
  const d = dayText(at);
  return `studio-${toolId}-${d.day}-${d.month}-${d.year}.${extension}`;
}
