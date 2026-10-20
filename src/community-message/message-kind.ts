/**
 * INBOX-22 (R-62). The kinds of message a community room takes, and what each
 * costs in WAWU Credits.
 *
 * Text and emoji are free. A photo, a video and a voice note cost credits, and
 * each price is an admin setting (TIER-06): `community_credit_cost_photo`,
 * `community_credit_cost_video` and `community_credit_cost_voice`. Nothing in
 * code states a price. Text has no setting: the ruling makes it free, so no
 * admin can make it cost.
 *
 * A message carries at most ONE attachment, so it has exactly one kind and
 * costs exactly that kind's price. Text sent beside an attachment is part of
 * the same message and adds nothing.
 *
 * Credits are a COUNT, never naira (R-5). Nothing here knows a naira value.
 */

export type MessageKind = 'text' | 'photo' | 'video' | 'voice';

/** The kinds that cost credits, in the order the Hub lists them. */
export const PAID_KINDS = ['photo', 'video', 'voice'] as const;
export type PaidMessageKind = (typeof PAID_KINDS)[number];

/** The admin setting that holds each paid kind's price. */
export const COST_SETTING: Record<PaidMessageKind, string> = {
  photo: 'community_credit_cost_photo',
  video: 'community_credit_cost_video',
  voice: 'community_credit_cost_voice',
};

/** The attachments of one message, as the send route receives them. */
export interface MessageAttachments {
  imageUrl?: string | null;
  videoUrl?: string | null;
  voiceUrl?: string | null;
}

/** How many of the three attachments a message carries (the table allows at most one). */
export function attachmentCount(parts: MessageAttachments): number {
  return [parts.imageUrl, parts.videoUrl, parts.voiceUrl].filter(Boolean)
    .length;
}

/**
 * The kind of a message. Call it only for a message with at most one
 * attachment (`attachmentCount`), which the send checks first.
 */
export function kindOf(parts: MessageAttachments): MessageKind {
  if (parts.videoUrl) return 'video';
  if (parts.voiceUrl) return 'voice';
  if (parts.imageUrl) return 'photo';
  return 'text';
}

/** What the kind is called in a sentence a person reads. */
const KIND_WORDS: Record<PaidMessageKind, string> = {
  photo: 'photo',
  video: 'video',
  voice: 'voice note',
};

function credits(n: number): string {
  return n === 1 ? '1 WAWU Credit' : `${n} WAWU Credits`;
}

/**
 * The sentence a sender is refused with when their credits do not cover a
 * message: what it costs, what they have, how many short, and that text is
 * free. Plain words, counts only, no dash.
 */
export function shortfallSentence(
  kind: PaidMessageKind,
  cost: number,
  have: number,
): string {
  const short = Math.max(cost - have, 1);
  const holding = have <= 0 ? 'none' : String(have);
  return `A ${KIND_WORDS[kind]} costs ${credits(cost)} and you have ${holding}. You are ${short} short. Text and emoji are free.`;
}
