import type { WalletProviderName } from '../../wallet-provider/wallet-provider.interface';

/**
 * Every sentence the earnings sweep writes on `discrepancy` when it sends a
 * daily move or a single earning to a person (OPS-26, F1; R-55). One list:
 * the sweep builds its notes from it and the admin list (`GET
 * /admin/money/earnings/in-review`) reads them back through it, so a sentence
 * is written in one place and the two cannot drift apart. A new sentence is
 * added here and only here.
 *
 * The list also decides what an admin is told. `discrepancy` is a free text
 * column; the admin list sends it only when it is made of these sentences,
 * and sends nothing otherwise (`knownReviewReason`).
 */

/** What one gap in a sentence may hold: a regex source, bounded. */
interface Slot {
  readonly source: string;
}

type Value = string | number | bigint;

const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The provider's name as notes print it (its adapter's `label`). */
export const PROVIDER_LABELS: Record<WalletProviderName, string> = {
  fintava: 'Fintava',
  nuvion: 'Nuvion',
};

/** A figure in kobo (a provider's own can be negative), up to 18 digits. */
const KOBO: Slot = { source: '-?\\d{1,18}' };
/** A number of hours from the settings. */
const HOURS: Slot = { source: '\\d{1,6}(?:\\.\\d{1,6})?' };
/** The label of a provider this server can run. */
const PROVIDER: Slot = {
  source: Object.values(PROVIDER_LABELS).map(escapeRegex).join('|'),
};

/**
 * A sentence with gaps, written once as a template: `make` fills the gaps for
 * the writer, `source` is the same sentence with each gap limited to what it
 * may hold, for the reader.
 */
function sentence<S extends Slot[]>(
  strings: TemplateStringsArray,
  ...slots: S
): {
  make: (...values: { [K in keyof S]: Value }) => string;
  source: string;
} {
  return {
    make: (...values) =>
      strings.reduce(
        (out, part, i) =>
          out + part + (i < values.length ? String(values[i]) : ''),
        '',
      ),
    source: strings.reduce(
      (out, part, i) =>
        out +
        escapeRegex(part) +
        (i < slots.length ? `(?:${slots[i].source})` : ''),
      '',
    ),
  };
}

export const EARNING_REVIEW_REASONS = {
  /** An earning whose sale stopped being a finished one. */
  saleNotFinished: sentence`the sale is no longer a finished one (not completed, or under review); the earning waits for a person`,
  /** A single earning above the provider's cap on one move. */
  earningAboveCap: sentence`the earning of ${KOBO} kobo is above the cap of ${KOBO} kobo on one move through WAWU's account`,
  /** A daily move above the provider's cap on one move. */
  moveAboveCap: sentence`the move of ${KOBO} kobo is above the cap of ${KOBO} kobo on one move through WAWU's account`,
  /** The wallet first refused the move more than the review bound ago. */
  refusedTooLong: sentence`the wallet first refused this move ${HOURS} hours ago and it has not landed`,
  /** The payee's wallet is WAWU's own account. */
  sameAccount: sentence`the move would take money from WAWU's account to WAWU's account`,
  /** The provider moved another amount than asked. */
  movedOtherAmount: sentence`${PROVIDER} moved ${KOBO} kobo for a move of ${KOBO} kobo`,
  /** The provider moved the money and then reversed it. */
  reversed: sentence`${PROVIDER} moved the earnings and then reversed it; WAWU's account holds the money again`,
  /** The provider did not say whether the move happened. */
  noAnswer: sentence`no answer from ${PROVIDER} about the move after ${HOURS} hours; it may have moved`,
  /** A landed move whose reported charge is not one we can use. */
  chargeOnLandedMove: sentence`${PROVIDER} reported a charge of ${KOBO} kobo on the move`,
} as const;

/**
 * The longest note the writers leave: `joinNotes` cuts a column at this many
 * characters, so a longer one is not ours.
 */
const NOTE_MAX = 1000;

/** One sentence at the start of a text, then the end or the next one. */
const STARTS = Object.values(EARNING_REVIEW_REASONS).map(
  (r) => new RegExp(`^(?:${r.source})(?:$|; (?=[\\s\\S]))`),
);

/**
 * The note as written when it is made only of the sweep's own sentences, in
 * the order `joinNotes` leaves them ("one; two"), else `null`: a text that is
 * not entirely ours is not sent, in whole or in part.
 */
export function knownReviewReason(note: string | null): string | null {
  if (!note || note.length > NOTE_MAX) return null;
  let rest = note;
  while (rest.length > 0) {
    const start = STARTS.map((re) => re.exec(rest)).find((m) => m !== null);
    if (!start) return null;
    rest = rest.slice(start[0].length);
  }
  return note;
}
