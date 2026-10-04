/**
 * The colours a receipt is drawn in (task WALLET-18): the image, the PDF
 * and the public page at wawu/r/<code>. A receipt is always a white
 * document, in both themes (W42), so these are the design system's light
 * values (mobile repo `design/_ds/wawu/tokens/colors.css`, `[data-theme=
 * "light"]`) and the receipt's own greys as the canvas draws W41 to W43
 * (`design/_gen/wallet.js`, `rcpt`). This file is the token layer for the
 * backend's drawn documents; nothing else in the server draws colour.
 */
export const RECEIPT_TOKENS = {
  /** --surface-card */
  paper: '#FFFFFF',
  /** --surface-page, behind the card on the public page */
  page: '#F6F5F8',
  /** --text-primary */
  ink: '#111018',
  /** The receipt's labels and date (W41) */
  muted: '#6E6A78',
  /** The receipt's footer line (W41) */
  faint: '#8A8694',
  /** --surface-sunken: the line between rows, the PDF's page edge */
  hairline: '#EEECF2',
  /** --accent */
  accent: '#9411C9',
  /** --positive */
  positive: '#12925A',
  /** --warning */
  warning: '#C77700',
  /** --danger */
  danger: '#D93A3A',
} as const;

export type ReceiptTone = 'positive' | 'warning' | 'danger' | 'ink';
