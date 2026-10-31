import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { objectKeyFrom, StorageService } from '../storage/storage.service';
import { cutMp3, cutWav } from './preview-cut/cut-audio';
import { cutMp4 } from './preview-cut/cut-mp4';
import { cutPdf } from './preview-cut/cut-pdf';
import {
  CutRefusal,
  type CutResult,
  type CutSource,
} from './preview-cut/cut-types';

/** What `resolve` needs of a piece being published. */
export interface PreviewAsk {
  contentType: string;
  accessType: string;
  fullAsset: string;
  previewAsset?: string | null;
  previewFromFile?: boolean | null;
  /** The cover the piece goes out with: a template's (or a course of documents') preview is a copy of it. */
  coverAsset?: string | null;
}

/** The preview a piece goes out with: the link, and the key of a file the Hub cut (so a failed publish can give it back). */
export interface PreviewAnswer {
  previewAsset: string;
  made: string | null;
}

export const NEEDS_PREVIEW =
  'Paid content needs a preview. Add a clip, or ask us to make it from your file.';
export const CANNOT_MAKE =
  'A picture sends its own smaller copy as the preview. We cannot make one from the file here.';
export const NEEDS_COVER =
  'This piece needs a cover picture, because the cover is what buyers see before paying. Add one.';
export const NO_SUCH_FILE = 'We could not find your file. Upload it again.';
const TRY_AGAIN = 'We could not make your preview just now. Try again.';

/** At most this many cuts run at once on the Hub; the rest wait their turn. */
const MAX_AT_ONCE = 2;

/**
 * PREVIEW-AUTO: which preview a piece is published with. R-118: nobody uploads a separate preview file for any kind.
 *  - a clip or a file the creator sent is used as it is (the web does, and the app sends the smaller copy of a picture);
 *  - a FREE piece with none has no preview step at all: the whole piece is open to everyone (R-8), so its "preview" is the
 *    full file itself and nothing new is stored or counted;
 *  - a PAID piece with none and `previewFromFile` has its preview made by the Hub after the full file is stored, and stored as
 *    the piece's preview exactly as an uploaded one is: one confirmed `content/preview` file of the creator, counted once in
 *    their storage, released by `POST /uploads/release` like any other:
 *      audio, video   the first 30 seconds (the first third of a file under 45 seconds);
 *      pdf            the first 3 pages (the first page of a file under 6 pages);
 *      course         the same cut of the FIRST LESSON (`fullAsset` is the first lesson's file) when that is a video;
 *                     any other first lesson (a document, an archive) previews as the piece's cover;
 *      template       the cover (a template's full file is a spreadsheet, a document, a deck, a CSV or an archive);
 *      picture        not made here: the phone sends its own smaller copy.
 * The cutters (`preview-cut/`) copy bytes in plain JavaScript: there is no ffmpeg on the Hub (AITOOLS-04). A PDF is cut with
 * `pdf-lib`, also plain JavaScript.
 */
@Injectable()
export class PreviewCutService {
  private readonly logger = new Logger(PreviewCutService.name);
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  async resolve(
    creatorWawuId: string,
    ask: PreviewAsk,
  ): Promise<PreviewAnswer> {
    if (ask.previewAsset) return { previewAsset: ask.previewAsset, made: null };
    if (ask.accessType === 'free')
      return { previewAsset: ask.fullAsset, made: null };
    if (!ask.previewFromFile) throw new BadRequestException(NEEDS_PREVIEW);
    switch (ask.contentType) {
      case 'audio':
      case 'video':
      case 'pdf':
        return this.answer(await this.makeFrom(creatorWawuId, ask));
      case 'course': {
        // The first lesson's file is `fullAsset`: a video is cut, anything else previews as the cover.
        const type = await this.storedTypeOf(creatorWawuId, ask.fullAsset);
        return this.answer(
          cutterFor(type, 'course')
            ? await this.makeFrom(creatorWawuId, ask)
            : await this.makeFromCover(creatorWawuId, ask),
        );
      }
      case 'template':
        return this.answer(await this.makeFromCover(creatorWawuId, ask));
      default:
        throw new BadRequestException(CANNOT_MAKE);
    }
  }

  private answer(made: { key: string; fileUrl: string }): PreviewAnswer {
    return { previewAsset: made.fileUrl, made: made.key };
  }

  /** Gives a cut preview back when the publish it was made for did not go through. Never throws. */
  async giveBack(creatorWawuId: string, key: string | null): Promise<void> {
    if (!key) return;
    try {
      await this.storage.releaseUpload(creatorWawuId, key);
    } catch (err) {
      this.logger.warn(
        `Could not give back cut preview ${key}: ${String(err)}`,
      );
    }
  }

  /**
   * The stored row of a file the creator names, proved to be theirs and still held, and confirmed. The app never calls
   * `POST /uploads/confirm` for a creator's upload (the sweep confirms it a quarter of an hour on), so a file sent for a piece
   * a moment after it landed is still `pending`: the creator's OWN pending row is confirmed here exactly as storage confirms any
   * upload (`StorageService.confirmUpload`: the bucket is asked, nothing else is a rule of ours), then cut. Another person's row,
   * a released one and one the bucket does not hold are the same refusal as a file that never existed.
   */
  private async ownedFile(
    creatorWawuId: string,
    asset: string,
    folder: string,
  ): Promise<{ key: string; contentType: string }> {
    const key = objectKeyFrom(asset);
    const row = await this.prisma.storageObject.findUnique({
      where: { key },
      select: {
        id: true,
        wawuUserId: true,
        folder: true,
        status: true,
        releasedAt: true,
        removingAt: true,
        contentType: true,
      },
    });
    if (
      !row ||
      row.wawuUserId !== creatorWawuId ||
      row.folder !== folder ||
      (row.status !== 'confirmed' && row.status !== 'pending') ||
      row.releasedAt ||
      row.removingAt
    )
      throw new BadRequestException(NO_SUCH_FILE);
    // Asked of the bucket outside any lock or transaction (a network call); a bucket that cannot be asked is storage's own 503.
    if (
      !(await this.storage.confirmUpload({
        id: row.id,
        status: row.status,
        key,
      }))
    )
      throw new BadRequestException(NO_SUCH_FILE);
    return { key, contentType: row.contentType };
  }

  private async storedTypeOf(
    creatorWawuId: string,
    fullAsset: string,
  ): Promise<string> {
    return (await this.ownedFile(creatorWawuId, fullAsset, 'content/full'))
      .contentType;
  }

  private async makeFrom(
    creatorWawuId: string,
    ask: PreviewAsk,
  ): Promise<{ key: string; fileUrl: string }> {
    const full = await this.ownedFile(
      creatorWawuId,
      ask.fullAsset,
      'content/full',
    );
    const fullKey = full.key;
    const cutter = cutterFor(full.contentType, ask.contentType);
    if (!cutter)
      throw new BadRequestException(new CutRefusal('unsupported').message);
    let cut: CutResult;
    await this.takeTurn();
    try {
      const length = await this.storage.storedLength(fullKey);
      const source: CutSource = {
        length,
        read: (start, end) => this.storage.readStoredRange(fullKey, start, end),
      };
      cut = await cutter(source);
    } catch (err) {
      if (err instanceof CutRefusal)
        throw new BadRequestException({
          message: err.message,
          reason: { code: `preview_cut_${err.code}` },
        });
      this.logger.warn(`Preview cut failed for ${fullKey}: ${String(err)}`);
      throw new ServiceUnavailableException(TRY_AGAIN);
    } finally {
      this.release();
    }
    // The same name for the same full file: a retry replaces the cut in place and never counts twice.
    const name = `auto-${createHash('sha1').update(fullKey).digest('hex').slice(0, 20)}`;
    const stored = await this.storage.putCutPreview(
      creatorWawuId,
      name,
      cut.body,
      cut.contentType,
    );
    return { key: stored.key, fileUrl: stored.fileUrl };
  }

  /** The preview of a piece with no media to cut: a copy of its cover, stored as its own `content/preview` file (the cover can then change without touching the preview). */
  private async makeFromCover(
    creatorWawuId: string,
    ask: PreviewAsk,
  ): Promise<{ key: string; fileUrl: string }> {
    if (!ask.coverAsset) throw new BadRequestException(NEEDS_COVER);
    const cover = await this.ownedFile(
      creatorWawuId,
      ask.coverAsset,
      'content/cover',
    );
    let body: Buffer;
    try {
      const length = await this.storage.storedLength(cover.key);
      body = await this.storage.readStoredRange(cover.key, 0, length);
    } catch (err) {
      this.logger.warn(`Cover copy failed for ${cover.key}: ${String(err)}`);
      throw new ServiceUnavailableException(TRY_AGAIN);
    }
    const name = `auto-${createHash('sha1').update(cover.key).digest('hex').slice(0, 20)}`;
    const stored = await this.storage.putCutPreview(
      creatorWawuId,
      name,
      body,
      cover.contentType,
    );
    return { key: stored.key, fileUrl: stored.fileUrl };
  }

  private takeTurn(): Promise<void> {
    if (this.running < MAX_AT_ONCE) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}

/**
 * The cutter for a stored full file's type when it is the full file of a piece of `pieceType`, or null when the Hub cannot cut
 * that file for that kind of piece (an audio piece is never cut as a document, a PDF piece never as a recording, and a course
 * is cut only when its first lesson is a video).
 */
export function cutterFor(
  contentType: string,
  pieceType: string,
): ((source: CutSource) => Promise<CutResult>) | null {
  const isVideo =
    contentType === 'video/mp4' || contentType === 'video/quicktime';
  if (pieceType === 'audio') {
    if (contentType === 'audio/mpeg') return cutMp3;
    if (contentType === 'audio/wav') return cutWav;
    return null;
  }
  if (pieceType === 'video' || pieceType === 'course')
    return isVideo ? cutMp4 : null;
  if (pieceType === 'pdf')
    return contentType === 'application/pdf' ? cutPdf : null;
  return null;
}
