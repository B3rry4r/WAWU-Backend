/**
 * The short reference of a send (R2-MONEY D-03): the `WAW-XXXX-XXXX` a person reads off W12's receipt and W27's detail and quotes to
 * support. It is derived, never stored: the first eight hex digits of the send's id, which the send's stored reference
 * (`wawu-send-<id>` for a send to a WAWU user, `wawu-bank-<id>` for a send to a bank account) carries, in two groups of four. Nothing
 * here reads or writes a table, so the receipt, the app and the admin lookup all get the same answer from the same stored reference.
 *
 * Eight hex digits are 32 bits, so two sends can in principle share a short form; the lookup answers every send that does, newest
 * first, and the person's own details (amount, date) tell them apart. The app derives the same form with the same rule
 * (`src/features/send/reference.ts` in the mobile repo).
 */
import { BANK_SEND_REFERENCE_PREFIX } from '../../wallet-provider/wallet-provider.interface';

export const SEND_REFERENCE_PREFIX = 'wawu-send-';

const ID_TAIL =
  '([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORED = new RegExp(
  `^(?:${SEND_REFERENCE_PREFIX}|${BANK_SEND_REFERENCE_PREFIX})${ID_TAIL}$`,
  'i',
);
const SHORT = /^WAW-([0-9A-F]{4})-([0-9A-F]{4})$/i;

/** `WAW-8F2A-91C3` for a send's stored reference; null for any other kind of reference (they are shown whole). */
export function shortReferenceOf(reference: string): string | null {
  const found = STORED.exec(reference.trim());
  if (!found) return null;
  const hex = found[1].toUpperCase();
  return `WAW-${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export type ReferenceQuery =
  /** A short reference: the stored references of a send that begin with these eight hex digits. */
  | { kind: 'short'; hex: string }
  /** Anything else: matched whole against the stored reference. */
  | { kind: 'whole'; reference: string };

/** What a person or an agent typed into the lookup. Never throws: a blank string has no query. */
export function parseReferenceQuery(input: string): ReferenceQuery | null {
  const text = input.trim();
  if (text === '') return null;
  const short = SHORT.exec(text);
  if (short)
    return { kind: 'short', hex: `${short[1]}${short[2]}`.toLowerCase() };
  return { kind: 'whole', reference: text };
}
