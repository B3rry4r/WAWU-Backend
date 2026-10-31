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
}

/** The preview a piece goes out with: the link, and the key of a file the Hub cut (so a failed publish can give it back). */
export interface PreviewAnswer {
  previewAsset: string;
  made: string | null;
}

export const NEEDS_PREVIEW =
  'Paid content needs a preview. Add a clip, or ask us to make it from your file.';
export const CANNOT_MAKE =
  'Only a video or an audio file can have its preview made for you. Add a clip.';
export const NO_SUCH_FILE = 'We could not find your file. Upload it again.';
const TRY_AGAIN = 'We could not make your preview just now. Try again.';

/** At most this many cuts run at once on the Hub; the rest wait their turn. */
const MAX_AT_ONCE = 2;

/**
 * PREVIEW-AUTO: which preview a piece is published with.
 *  - a clip the creator sent is used as it is (the way it always was);
 *  - a FREE piece with none has no preview step at all: the whole piece is open
 *    to everyone (R-8), so its "preview" is the full file itself and nothing
 *    new is stored or counted;
 *  - a PAID audio or video piece with none and `previewFromFile` has its
 *    preview cut by the Hub from the full file (the first 30 seconds, or its
 *    first third when the file is under 45 seconds), after the full file is
 *    stored, and stored as the piece's preview exactly as an uploaded one is:
 *    one confirmed `content/preview` file of the creator, counted once in their
 *    storage, released by `POST /uploads/release` like any other.
 * The cutters (`preview-cut/`) copy bytes in plain JavaScript: there is no
 * ffmpeg on the Hub (AITOOLS-04) and none was added.
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
    if (ask.contentType !== 'audio' && ask.contentType !== 'video')
      throw new BadRequestException(CANNOT_MAKE);
    const made = await this.makeFrom(creatorWawuId, ask.fullAsset);
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

  private async makeFrom(
    creatorWawuId: string,
    fullAsset: string,
  ): Promise<{ key: string; fileUrl: string }> {
    const fullKey = objectKeyFrom(fullAsset);
    const row = await this.prisma.storageObject.findUnique({
      where: { key: fullKey },
      select: {
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
      row.folder !== 'content/full' ||
      row.status !== 'confirmed' ||
      row.releasedAt ||
      row.removingAt
    )
      throw new BadRequestException(NO_SUCH_FILE);
    const cutter = cutterFor(row.contentType);
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

/** The cutter for a stored full file's type, or null when the Hub cannot cut that type. */
export function cutterFor(
  contentType: string,
): ((source: CutSource) => Promise<CutResult>) | null {
  if (contentType === 'audio/mpeg') return cutMp3;
  if (contentType === 'audio/wav') return cutWav;
  if (contentType === 'video/mp4' || contentType === 'video/quicktime')
    return cutMp4;
  return null;
}
