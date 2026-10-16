/**
 * The five cards of a TGIF day, in reading order (HOME-10). The slugs are the
 * contract: the app sends them, the database holds them to the same list with
 * a CHECK, and the stats answer lists every one of them even at zero.
 */
export const TGIF_CARDS = [
  'verse',
  'reality',
  'remember',
  'prayer',
  'takeaway',
] as const;
export type TgifCard = (typeof TGIF_CARDS)[number];

/** What a person can say to a card. "Amen" is the only reaction drawn. */
export const TGIF_REACTION_KINDS = ['amen'] as const;
export type TgifReactionKind = (typeof TGIF_REACTION_KINDS)[number];
