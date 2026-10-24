import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  AI_INPUT_FOLDERS,
  AI_INPUT_MAX_BYTES_SETTING,
} from '../../storage/dto/presign-upload.dto';
import { StorageService } from '../../storage/storage.service';
import { AiToolError } from '../ai-tools-error';
import { minutesOf, readSeconds } from './media-length';

/**
 * A person's own file for an AI tool (AITOOLS-04): the Hub's way to take a
 * file in, which Dubbing reuses. The file goes up through the presign flow
 * into a private folder (`ai/input-audio`, `ai/input-video`); a job names it
 * by its key. One seam so a spec can run the whole job without a bucket;
 * production is `StorageAiInputFiles`.
 */
export const AI_INPUT_FILES = Symbol('AI_INPUT_FILES');

/** A stored file the Hub has checked is the caller's own, in an AI input folder. */
export interface InputFileRow {
  key: string;
  folder: string;
  bytes: number;
  contentType: string;
}

export interface AiInputFiles {
  /** The caller's own landed file in an AI input folder, or null (another person's, not there, wrong folder, not landed). */
  find(wawuUserId: string, key: string): Promise<InputFileRow | null>;
  /** The file's bytes; throws when it cannot be read or is over `maxBytes`. A network call. */
  read(
    key: string,
    maxBytes: number,
  ): Promise<{ audio: Buffer; contentType: string }>;
  /** Drops the file. Never throws. */
  remove(key: string): Promise<void>;
}

@Injectable()
export class StorageAiInputFiles implements AiInputFiles {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async find(wawuUserId: string, key: string): Promise<InputFileRow | null> {
    const row = await this.prisma.storageObject.findUnique({
      where: { key },
      select: {
        key: true,
        wawuUserId: true,
        folder: true,
        bytes: true,
        contentType: true,
        status: true,
      },
    });
    if (
      !row ||
      row.wawuUserId !== wawuUserId ||
      !(AI_INPUT_FOLDERS as readonly string[]).includes(row.folder) ||
      !row.key.startsWith(`${row.folder}/${wawuUserId}/`) ||
      row.status !== 'confirmed'
    )
      return null;
    return {
      key: row.key,
      folder: row.folder,
      bytes: Number(row.bytes),
      contentType: row.contentType,
    };
  }

  read(
    key: string,
    maxBytes: number,
  ): Promise<{ audio: Buffer; contentType: string }> {
    return this.storage.readStored(key, maxBytes);
  }

  remove(key: string): Promise<void> {
    return this.storage.removeGenerated(key);
  }
}

export const FILE_NOT_FOUND_MESSAGE = "We couldn't find that file.";
export const FILE_UNREADABLE_MESSAGE =
  "We couldn't read that file. No points were taken.";

/** The file a job is about, checked and measured by the Hub. */
export interface OpenedInput {
  key: string;
  bytes: number;
  contentType: string;
  /** The length the Hub read from the file itself. */
  seconds: number;
  /** Minutes the job is priced in: rounded up, at least 1. */
  minutes: number;
}

/** A size in words a person reads: "500 MB". */
export function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10} GB`;
  return `${Math.max(1, Math.round(mb))} MB`;
}

/**
 * Opens a person's file for a job: it must be their own landed file in an AI
 * input folder (another person's key answers not found), within the byte cap
 * (`ai.input_max_bytes`), and its length must be readable from the file
 * itself. Every refusal happens before anything is priced or held.
 */
@Injectable()
export class AiInputService {
  constructor(
    private readonly settings: PlanSettingsService,
    @Inject(AI_INPUT_FILES) private readonly files: AiInputFiles,
  ) {}

  /** The cap on a file's size, from the settings. */
  maxBytes(): number {
    return this.settings.number(AI_INPUT_MAX_BYTES_SETTING);
  }

  async open(wawuUserId: string, fileKey: string): Promise<OpenedInput> {
    const row = await this.files.find(wawuUserId, fileKey);
    if (!row) throw new AiToolError('not_found', FILE_NOT_FOUND_MESSAGE);
    const cap = this.maxBytes();
    if (row.bytes > cap)
      throw new AiToolError(
        'ai_file_too_large',
        `That file is too big. The most is ${sizeText(cap)}. No points were taken.`,
        { cap: 'file_bytes', capLimit: cap, capUnit: 'bytes' },
      );
    let seconds: number | null = null;
    try {
      const { audio } = await this.files.read(row.key, cap);
      // The bytes are handed to the reader's worker thread without a copy and
      // are not used again here; the provider run reads the file afresh.
      seconds = await readSeconds(audio, { transfer: true });
    } catch {
      seconds = null;
    }
    if (seconds === null)
      throw new AiToolError('ai_file_unreadable', FILE_UNREADABLE_MESSAGE);
    return {
      key: row.key,
      bytes: row.bytes,
      contentType: row.contentType,
      seconds,
      minutes: minutesOf(seconds),
    };
  }

  /** The bytes of an opened file, for the one provider run. */
  read(key: string): Promise<{ audio: Buffer; contentType: string }> {
    return this.files.read(key, this.maxBytes());
  }

  remove(key: string): Promise<void> {
    return this.files.remove(key);
  }
}
