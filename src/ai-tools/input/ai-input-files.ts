import type { Readable } from 'node:stream';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  AI_INPUT_FOLDERS,
  AI_INPUT_IMAGE_FOLDER,
  AI_INPUT_IMAGE_MAX_BYTES,
  AI_INPUT_MAX_BYTES_SETTING,
} from '../../storage/dto/presign-upload.dto';
import { StorageService } from '../../storage/storage.service';
import { AiToolError } from '../ai-tools-error';
import { IMAGE_SNIFF_HEAD_BYTES, sniffImage } from './image-sniff';
import { minutesOf, readSeconds } from './media-length';
import { SNIFF_HEAD_BYTES, sniffContainer } from './media-sniff';
import { type ReadGate, readGate } from './read-gate';
import type { StreamedFile } from '../voice/ai-voice-provider';

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
  /**
   * The file's first `bytes` bytes (fewer when the file is shorter), enough to
   * tell what it is without reading the rest. Throws when it cannot be read.
   * A network call.
   */
  readHead(key: string, bytes: number): Promise<Buffer>;
  /**
   * The file's bytes, read as a stream that is stopped at `maxBytes`; throws
   * when it cannot be read, is empty or is over `maxBytes`. A network call.
   */
  read(
    key: string,
    maxBytes: number,
  ): Promise<{ audio: Buffer; contentType: string }>;
  /** The file's real length in bytes, from the store (not the row's declared number). Throws when it cannot be read. A network call. */
  length(key: string): Promise<number>;
  /**
   * Opens the file to be streamed, reading nothing yet: its real length and a
   * stream of exactly that many bytes (it fails when it passes the length or
   * `maxBytes`, or ends early). Throws when it cannot be opened, is empty or
   * is over `maxBytes`. The caller reads it to its end or destroys it.
   */
  open(
    key: string,
    maxBytes: number,
  ): Promise<{ stream: Readable; bytes: number; contentType: string }>;
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
      // AITOOLS-08: a photo for a Studio tool is in the third input folder (its own constant: AI_INPUT_FOLDERS pins the two older ones).
      !(
        (AI_INPUT_FOLDERS as readonly string[]).includes(row.folder) ||
        row.folder === AI_INPUT_IMAGE_FOLDER
      ) ||
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

  readHead(key: string, bytes: number): Promise<Buffer> {
    return this.storage.readStoredHead(key, bytes);
  }

  read(
    key: string,
    maxBytes: number,
  ): Promise<{ audio: Buffer; contentType: string }> {
    return this.storage.readStored(key, maxBytes);
  }

  length(key: string): Promise<number> {
    return this.storage.storedLength(key);
  }

  async open(
    key: string,
    maxBytes: number,
  ): Promise<{ stream: Readable; bytes: number; contentType: string }> {
    const o = await this.storage.openStored(key, maxBytes);
    return { stream: o.body, bytes: o.length, contentType: o.contentType };
  }

  remove(key: string): Promise<void> {
    return this.storage.removeGenerated(key);
  }
}

export const FILE_NOT_FOUND_MESSAGE = "We couldn't find that file.";
export const PHOTO_UNREADABLE_TEXT =
  "We couldn't open that photo. Choose a JPEG, PNG or WebP picture. No points were taken.";
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
    /** Only a spec passes its own gate; the Hub has one (`readGate`). */
    @Optional() private readonly gate: ReadGate = readGate,
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
    const seconds = await this.measure(wawuUserId, row);
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

  /**
   * A person's photo for a Studio tool (AITOOLS-08), checked before anything is
   * priced or held: their own landed file in `ai/input-image` (another person's
   * key answers not found), within 25 MB, and a PNG, JPEG or WebP picture by its
   * first bytes. Only the head is read.
   */
  async openPhoto(
    wawuUserId: string,
    photoKey: string,
  ): Promise<{ key: string; bytes: number; contentType: string }> {
    const row = await this.files.find(wawuUserId, photoKey);
    if (!row || row.folder !== AI_INPUT_IMAGE_FOLDER)
      throw new AiToolError('not_found', FILE_NOT_FOUND_MESSAGE);
    if (row.bytes > AI_INPUT_IMAGE_MAX_BYTES)
      throw new AiToolError(
        'ai_file_too_large',
        `That photo is too big. The most is ${sizeText(AI_INPUT_IMAGE_MAX_BYTES)}. No points were taken.`,
        {
          cap: 'file_bytes',
          capLimit: AI_INPUT_IMAGE_MAX_BYTES,
          capUnit: 'bytes',
        },
      );
    let picture;
    try {
      const real = await this.files.length(row.key);
      if (real <= 0 || real > AI_INPUT_IMAGE_MAX_BYTES) picture = null;
      else
        picture = sniffImage(
          await this.files.readHead(row.key, IMAGE_SNIFF_HEAD_BYTES),
        );
    } catch {
      picture = null;
    }
    if (picture === null)
      throw new AiToolError('ai_photo_unreadable', PHOTO_UNREADABLE_TEXT);
    return { key: row.key, bytes: row.bytes, contentType: picture.contentType };
  }

  /**
   * The file's length in seconds, or null when it cannot be read. The Hub
   * reads one file per account at a time (a second read from the account
   * waits for the first, a third is refused busy); a file that is not one of the
   * containers the tools take is refused from its first 16 KB, without the
   * rest; the rest is read only after the file has its parser turn (a file
   * that waits is not in memory); too many waiting, or a wait past ONE deadline
   * of `waitMs` shared by the account's place and the turn (round 4; it was a
   * wait of `waitMs` for each, 30.5 s in the race), is the Hub's busy answer
   * (a `ServiceUnavailableException`, nothing held). The turn is charged the
   * file's REAL length from the store, and the read is stopped at it.
   */
  private async measure(
    wawuUserId: string,
    row: InputFileRow,
  ): Promise<number | null> {
    const until = this.gate.deadline();
    const releaseAccount = await this.gate.claimAccount(wawuUserId, until);
    try {
      let real: number;
      try {
        const head = await this.files.readHead(row.key, SNIFF_HEAD_BYTES);
        if (sniffContainer(head) === null) return null;
        real = await this.files.length(row.key);
      } catch {
        return null;
      }
      if (real <= 0 || real > this.maxBytes()) return null;
      const releaseTurn = await this.gate.takeTurn(real, until);
      try {
        const { audio } = await this.files.read(row.key, real);
        // The bytes are handed to the reader's worker thread without a copy and
        // are not used again here; the provider run streams the file afresh.
        return await readSeconds(audio, { transfer: true });
      } catch {
        return null;
      } finally {
        releaseTurn();
      }
    } finally {
      releaseAccount();
    }
  }

  /**
   * The person's file opened for the provider run (round 4: it used to be read
   * whole, per running job, with no limit, then copied again into the request
   * body: 8 jobs from one account took the Hub up 1.6 GB). The run takes the
   * SAME place as a quote: the account's one place, a global turn charged the
   * file's real length (so a quote and a job share both), under one deadline.
   * Past it, or with too many waiting, the busy answer (a
   * `ServiceUnavailableException`; the pipeline gives the job's points back).
   * Nothing of the file is read here; the returned file streams to the
   * provider, and `sent()` (called by the provider seam when the last byte is
   * written, and again when the run ends) hands the place and the turn back.
   * Peak memory of a job: the stream's own buffers, about 64 KB, at any size.
   */
  async openForRun(
    wawuUserId: string,
    key: string,
    /** AITOOLS-08: a smaller cap for a photo (25 MB); the setting's cap otherwise. */
    cap: number = this.maxBytes(),
  ): Promise<StreamedFile> {
    const until = this.gate.deadline();
    const releaseAccount = await this.gate.claimAccount(wawuUserId, until);
    let releaseTurn: (() => void) | null = null;
    try {
      const real = await this.files.length(key);
      if (real <= 0 || real > cap)
        throw new Error('the file is empty or too large');
      releaseTurn = await this.gate.takeTurn(real, until);
      const opened = await this.files.open(key, real);
      const turn = releaseTurn;
      let given = false;
      return {
        bytes: opened.bytes,
        contentType: opened.contentType,
        stream: opened.stream,
        sent: () => {
          if (given) return;
          given = true;
          opened.stream.destroy();
          turn();
          releaseAccount();
        },
      };
    } catch (e) {
      releaseTurn?.();
      releaseAccount();
      throw e;
    }
  }

  remove(key: string): Promise<void> {
    return this.files.remove(key);
  }
}
