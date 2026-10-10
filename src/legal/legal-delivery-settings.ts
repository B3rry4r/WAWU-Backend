import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The legal team's WAWU accounts (FIX-24).
 *
 * A delivered legal document is handed to the client with a fresh link on
 * every read, so it must be a file the client may see: the client's own
 * upload given back, or a file one of these accounts uploaded. Any other
 * client's attachment, or a key nobody uploaded, is refused on delivery and
 * never signed on read.
 *
 * `LEGAL_DELIVERY_UPLOADER_IDS` is a comma-separated list of WAWU ids (spaces
 * around a comma are ignored, letters are compared without case). Unset or
 * empty is an empty list: then only a client's own files can be delivered
 * back to them. A value that is set but is not a list of WAWU ids stops the
 * server at boot, naming the setting.
 *
 * PROVISIONAL(LEGAL-DELIVERY-UPLOADERS, owner=YOU, why=the owner supplies the legal team's WAWU account ids; while the list is empty only a client's own files can be delivered back to them)
 */
export const LEGAL_DELIVERY_UPLOADER_IDS = 'LEGAL_DELIVERY_UPLOADER_IDS';

/** A WAWU id: the UUID WAWU ID gives every account (`sub` in its tokens). */
const WAWU_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The setting is set but unusable. Stops the server at boot. */
export class LegalDeliveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalDeliveryConfigError';
  }
}

/**
 * The listed ids, lower-cased. Unset or blank gives an empty list; anything
 * else must be WAWU ids separated by commas, or this throws naming the
 * setting and the first entry that is not one.
 */
export function readLegalDeliveryUploaderIds(
  raw: string | undefined | null,
): ReadonlySet<string> {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return new Set();
  }
  const ids = raw.split(',').map((entry) => entry.trim());
  const bad = ids.find((id) => !WAWU_ID.test(id));
  if (bad !== undefined) {
    throw new LegalDeliveryConfigError(
      bad === ''
        ? `${LEGAL_DELIVERY_UPLOADER_IDS} has an empty entry. Give WAWU ids separated by commas, or leave it empty.`
        : `${LEGAL_DELIVERY_UPLOADER_IDS} must be WAWU ids separated by commas. "${bad}" is not a WAWU id.`,
    );
  }
  return new Set(ids.map((id) => id.toLowerCase()));
}

/** The legal team's accounts, read once at boot. */
@Injectable()
export class LegalDeliverySettings {
  readonly uploaderIds: ReadonlySet<string>;

  constructor(config: ConfigService) {
    this.uploaderIds = readLegalDeliveryUploaderIds(
      config.get<string>(LEGAL_DELIVERY_UPLOADER_IDS),
    );
  }

  /** Whether this WAWU account is one of the legal team's. */
  isLegalTeam(wawuId: string): boolean {
    return this.uploaderIds.has(wawuId.toLowerCase());
  }
}
