/**
 * What GET /tgif/:date answers (task HOME-09): the five cards of one TGIF day.
 * One named interface, so the generated contract carries a named schema the
 * app can import.
 */
export interface TgifDayView {
  /** The day asked for, YYYY-MM-DD. */
  date: string;
  /** The series this day sits in, as the book writes it ("SONS, NOT SLAVES"). */
  series: string;
  /** The series' one-line theme. */
  seriesTheme: string;
  /** Card `verse`: the verse, without quotation marks. */
  verse: string;
  /** Card `verse`: where it comes from, with its translation ("Romans 8:24 (NIV)"). */
  verseReference: string;
  /** Card `reality`, already addressed to the caller by first name. */
  reality: string;
  /** Card `remember`: the line to carry. */
  remember: string;
  /** Card `prayer`. */
  prayer: string;
  /** Card `takeaway`: the one thing to do. */
  takeaway: string;
  /**
   * The link written on a shared card ("wawu/tgif"), or null until the owner
   * sets TGIF_SHARE_LINK. The app leaves the link out while this is null.
   */
  shareLink: string | null;
}
