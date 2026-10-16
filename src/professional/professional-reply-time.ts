/**
 * "Usually replies in" on a professional's card (H10, "~3h usual reply") and
 * in the directory (PROS-02).
 *
 * It comes from real replies only: the time between a paid message being
 * sent (`DirectMessage.sentAt`, set when the payment is confirmed) and the
 * professional answering it (`respondedAt`). A message that was never
 * answered has no reply time and is not counted; it is refunded instead, and
 * the promise for that case is `dmResponseHours`, which the card already
 * carries.
 *
 * The figure is the MEDIAN of the most recent answered messages, so one
 * reply sent a day late does not move it the way an average would.
 *
 * PROVISIONAL(PRO-REPLY-SAMPLE, owner=YOU, why=no ruling names how many answered messages make a usual reply time or how many recent ones it is taken over)
 *
 * The most recent 20 answered messages, and no figure at all until there are
 * 3: with fewer, "usually" describes one or two conversations, and the card
 * shows nothing rather than a number that is mostly chance.
 */
export const REPLY_TIME_DEFAULTS = {
  sample: 20,
  minimumAnswered: 3,
} as const;

/** What the directory knows about one professional's replies. */
export interface ReplyTimeStats {
  /** Median minutes to reply, rounded up; null below the minimum. */
  usualReplyMinutes: number | null;
  /** Answered paid messages the figure was taken from (at most `sample`). */
  answeredCount: number;
}

export const NO_REPLY_STATS: ReplyTimeStats = {
  usualReplyMinutes: null,
  answeredCount: 0,
};

/**
 * Seconds to whole minutes, rounded up so a reply in 10 seconds reads as 1
 * minute, never 0. Null below the minimum number of answered messages.
 */
export function toReplyStats(
  medianSeconds: number | null,
  answeredCount: number,
  minimumAnswered: number = REPLY_TIME_DEFAULTS.minimumAnswered,
): ReplyTimeStats {
  if (medianSeconds === null || answeredCount < minimumAnswered) {
    return { usualReplyMinutes: null, answeredCount };
  }
  return {
    usualReplyMinutes: Math.max(1, Math.ceil(medianSeconds / 60)),
    answeredCount,
  };
}
