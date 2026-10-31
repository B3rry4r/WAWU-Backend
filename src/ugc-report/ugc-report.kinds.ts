/**
 * REPORT-UGC. What can be reported, and why. One list for the route, the admin queue and the support mail, so the app,
 * the moderators and the mailbox use the same words.
 */

/** The things a person can report. `direct_message` is a paid question (the table DmReport keeps its own row too). */
export const UGC_KINDS = [
  'piece',
  'comment',
  'profile',
  'community_message',
  'chat_message',
  'direct_message',
] as const;
export type UgcKind = (typeof UGC_KINDS)[number];

/** The short fixed list of reasons, in the order the app draws them. The words are the app's (see the app's reasons file). */
export const UGC_REASONS = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'illegal',
  'impersonation',
  'other',
] as const;
export type UgcReason = (typeof UGC_REASONS)[number];

/** The words a moderator and the support mail read. */
export const UGC_REASON_LABELS: Record<UgcReason, string> = {
  spam: 'Spam or a scam',
  harassment: 'Harassment or bullying',
  hate: 'Hate or threats',
  sexual: 'Nudity or sexual content',
  illegal: 'Illegal or dangerous',
  impersonation: 'Pretending to be someone',
  other: 'Something else',
};

export const UGC_KIND_LABELS: Record<UgcKind, string> = {
  piece: 'Piece',
  comment: 'Comment',
  profile: 'Profile',
  community_message: 'Community message',
  chat_message: 'Chat message',
  direct_message: 'Paid question',
};

export const UGC_STATUSES = ['open', 'dismissed', 'actioned'] as const;
export type UgcStatus = (typeof UGC_STATUSES)[number];

/** The longest note a reporter may add. */
export const UGC_NOTE_MAX = 500;

/** Where each new report is mailed (WAWU ID's relay owns the sender). `UGC_REPORT_MAIL_TO` overrides it on a server. */
export const UGC_SUPPORT_EMAIL = 'support@wawuafrica.com';
