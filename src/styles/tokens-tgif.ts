/**
 * The colours the shared TGIF card is drawn in (task HOME-09, H35's preview
 * image). The card is dark in both themes, as the canvas draws it
 * (`design/_gen/home.js`, the verse card), so these do not follow a theme.
 * Like `tokens-receipt.ts`, this is a token layer for a drawn document:
 * nothing else in the server draws colour.
 */
export const TGIF_TOKENS = {
  /** The verse card's ground. */
  ground: '#2A0C3E',
  /** --accent: the glow in the top right corner. */
  glow: '#9411C9',
  /** The glow's strength at its centre. */
  glowOpacity: 0.8,
  /** Text on the card. */
  ink: '#FFFFFF',
  /** The date label and the reference line. */
  inkSoft: 0.8,
} as const;
