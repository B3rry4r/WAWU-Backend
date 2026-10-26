import type { AdCtaDestination } from '../../../generated/prisma/enums';

/**
 * What a tap on a sponsored card does, and which of the card's fields go with
 * each kind (ADS-LINK, R-92). One place, so create, edit and the database's
 * AdCreative_cta_check say the same thing.
 *
 *   link   opens ctaUrl (an https address) in the phone's browser; the card
 *          draws a button with ctaLabel
 *   none   the card is only shown: no button, no label, nothing to open
 *   event  opens the event ctaDestinationId; draws a button with ctaLabel.
 *          Ads are not tied to events (R-92), so the dashboard no longer
 *          offers it, but campaigns that already use it keep working.
 */
export interface CtaFields {
  ctaDestination: AdCtaDestination;
  ctaLabel: string | null;
  ctaDestinationId: string | null;
  ctaUrl: string | null;
}

/** What a request may carry for the three kind-specific fields. */
export interface CtaInput {
  ctaDestination?: AdCtaDestination;
  ctaLabel?: string;
  ctaDestinationId?: string;
  ctaUrl?: string;
}

type KindField = 'ctaLabel' | 'ctaDestinationId' | 'ctaUrl';

/** The fields each kind keeps. Every other kind-specific field is null. */
export const CTA_FIELDS: Record<AdCtaDestination, readonly KindField[]> = {
  event: ['ctaLabel', 'ctaDestinationId'],
  link: ['ctaLabel', 'ctaUrl'],
  none: [],
};

const ALL_FIELDS: readonly KindField[] = [
  'ctaLabel',
  'ctaDestinationId',
  'ctaUrl',
];

const NOT_ALLOWED: Record<KindField, string> = {
  ctaLabel:
    'A card that does nothing has no button, so it takes no ctaLabel. Leave it out.',
  ctaDestinationId: 'ctaDestinationId is only for a card that opens an event.',
  ctaUrl: 'ctaUrl is only for a card that opens a web link.',
};

const REQUIRED: Record<KindField, string> = {
  ctaLabel:
    'ctaLabel is required: a card that opens a link or an event has a button.',
  ctaDestinationId: 'ctaDestinationId is required when a card opens an event.',
  ctaUrl: 'ctaUrl is required when a card opens a web link.',
};

export type CtaResult =
  { ok: true; value: CtaFields } | { ok: false; message: string };

/**
 * The kind-specific fields a card will have once `sent` is applied to `prev`
 * (null when the card is new). A field the new kind keeps and `sent` leaves
 * out is carried over from `prev`; a field the new kind does not keep is
 * cleared, but SENDING one is refused, so a request never says something the
 * card will not hold. A field the kind needs and has none of is refused.
 */
export function resolveCta(prev: CtaFields | null, sent: CtaInput): CtaResult {
  const kind = sent.ctaDestination ?? prev?.ctaDestination;
  if (!kind) return { ok: false, message: 'ctaDestination is required.' };

  const keeps = CTA_FIELDS[kind];
  const next: CtaFields = {
    ctaDestination: kind,
    ctaLabel: null,
    ctaDestinationId: null,
    ctaUrl: null,
  };
  for (const field of ALL_FIELDS) {
    if (!keeps.includes(field)) {
      if (sent[field] !== undefined) {
        return { ok: false, message: NOT_ALLOWED[field] };
      }
      continue;
    }
    const value = sent[field] ?? prev?.[field] ?? null;
    if (value === null) return { ok: false, message: REQUIRED[field] };
    next[field] = value;
  }
  return { ok: true, value: next };
}
