import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  StorageService,
  deliverableKeyFrom,
  linkNamesStorage,
  type BucketLocation,
} from '../storage/storage.service';
import { LegalDeliverySettings } from './legal-delivery-settings';

/**
 * Why a delivered file may not be handed to a client:
 *
 *   not_a_legal_document      LEGAL-03's N1 rule: not a bare key or a link on
 *                             this bucket, or not under `legal/document/`
 *   no_upload_record          no `StorageObject` row names the key, so
 *                             nobody uploaded it through WAWU
 *   uploaded_by_someone_else  the row's uploader is neither the request's
 *                             owner nor one of the legal team's accounts
 */
export type DeliveryRefusal =
  'not_a_legal_document' | 'no_upload_record' | 'uploaded_by_someone_else';

/** One stored or posted value, judged: its key when it may be handed over. */
export type DeliveryCheck =
  { key: string; refusal: null } | { key: null; refusal: DeliveryRefusal };

/**
 * What a refused field is told (after its name, such as `files.0.url`). One
 * message for every refusal, so the answer never says whose file a key is.
 */
export const DELIVERY_REFUSAL_MESSAGE =
  'must be a document the legal team uploaded to WAWU storage, or one the client uploaded themselves.';

/** What the log says about a file listed without a link. */
const WITHHELD_WHY: Record<DeliveryRefusal, string> = {
  not_a_legal_document: 'it is not a legal document on WAWU storage',
  no_upload_record: 'no upload record names its key',
  uploaded_by_someone_else:
    'it was uploaded by neither the client nor the legal team',
};

/** How many withheld files are remembered, so each is logged once. */
const WARNED_LIMIT = 10_000;

/**
 * Which files may be delivered to whom (FIX-24, lead ruling 8 Oct 2026).
 *
 * LEGAL-03's N1 rule tied a delivered key only to the `legal/document/`
 * folder of this bucket. That folder also holds what clients attach to their
 * own matters, and support sees those keys in the ops queue, so one client's
 * document could be delivered to another, whose list then signed a fresh
 * link to it on every read. A key is now accepted only when all hold:
 *
 *   - it passes N1 (`deliverableKeyFrom`);
 *   - a `StorageObject` row exists for exactly that key;
 *   - that row's uploader is the request's owner (a client's own file given
 *     back) or one of the legal team's accounts (`LEGAL_DELIVERY_UPLOADER_IDS`).
 *
 * The same rule decides what is signed on read: a stored key that fails it
 * is listed without a link, logged once at warn level, and never signed.
 */
@Injectable()
export class LegalDeliveryRule {
  private readonly logger = new Logger(LegalDeliveryRule.name);
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly settings: LegalDeliverySettings,
  ) {}

  /** This bucket's origin and key prefix, or null with no storage configured. */
  location(): Promise<BucketLocation | null> {
    return this.storage.bucketLocation();
  }

  /**
   * Each value judged for a request owned by `ownerWawuId`, in order. One
   * query for every key, whatever the number of values. Never throws on a
   * value: anything that is not one of our keys is `not_a_legal_document`.
   */
  async check(
    ownerWawuId: string,
    values: readonly unknown[],
    at: BucketLocation | null,
  ): Promise<DeliveryCheck[]> {
    const keys = values.map((value) => deliverableKeyFrom(value, at));
    const wanted = [
      ...new Set(keys.filter((key): key is string => key !== null)),
    ];
    const uploads =
      wanted.length === 0
        ? []
        : await this.prisma.storageObject.findMany({
            where: { key: { in: wanted } },
            select: { key: true, wawuUserId: true },
          });
    const uploaderOf = new Map(uploads.map((u) => [u.key, u.wawuUserId]));
    const owner = ownerWawuId.toLowerCase();
    return keys.map((key): DeliveryCheck => {
      if (key === null) return { key: null, refusal: 'not_a_legal_document' };
      const uploader = uploaderOf.get(key);
      if (uploader === undefined) {
        return { key: null, refusal: 'no_upload_record' };
      }
      if (
        uploader.toLowerCase() !== owner &&
        !this.settings.isLegalTeam(uploader)
      ) {
        return { key: null, refusal: 'uploaded_by_someone_else' };
      }
      return { key, refusal: null };
    });
  }

  /**
   * Whether a link names this bucket's host or the storage endpoint's (or a
   * host under either). Used by the older single-file route, which still
   * takes a link on any other host as it always has.
   */
  namesOurStorage(link: string, at: BucketLocation | null): boolean {
    return linkNamesStorage(
      link,
      at,
      this.config.get<string>('STORAGE_ENDPOINT'),
    );
  }

  /**
   * Logs, once per file, that a stored file is listed without a link. Names
   * the request, the file and the reason, never the stored value: a legacy
   * value can be a signed link, which is a bearer token.
   */
  withheld(requestId: string, fileId: string, refusal: DeliveryRefusal): void {
    const id = `${requestId}:${fileId}`;
    if (this.warned.has(id)) return;
    if (this.warned.size >= WARNED_LIMIT) this.warned.clear();
    this.warned.add(id);
    this.logger.warn(
      `Delivered file ${fileId} on legal request ${requestId} is listed without a link: ${WITHHELD_WHY[refusal]}.`,
    );
  }
}
