/**
 * Every shape the assistant routes answer with (LEGAL-01), one named
 * interface each, so the contract publishes named schemas the app can share
 * (BACKEND_GAPS G-1) rather than one inline object per route.
 */

/**
 * One of the problems the assistant offers as a tap before anything is said
 * (S14's "A tenancy problem", "Register a business"...). Picking one sets the
 * intake's `matter`; typing instead lets the assistant work the matter out.
 */
export interface LegalAssistantTopic {
  /** Sent back as `quickReplyId` (`topic:<matter>`). */
  id: string;
  label: string;
  /** One of the fourteen intake matters (`GET /legal/intake/matters`). */
  matter: string;
  matterLabel: string;
}

/** A tappable answer under the newest assistant message. */
export interface LegalAssistantQuickReply {
  /** Sent back as `quickReplyId`. */
  id: string;
  label: string;
}

/**
 * Who wrote a message. `assistant` is the WAWU Legal assistant (the AI, or a
 * line the server writes), never a person; `consultant` is a WAWU Legal
 * consultant writing from the dashboard.
 */
export type LegalAssistantAuthor = 'client' | 'assistant' | 'consultant';

/**
 * A photo, video or PDF on a line of the conversation (R2-LEGAL3): the person
 * sent it for their matter, or a consultant delivered it. `url` is a fresh
 * link that lives 15 minutes (a PDF is a download, a picture opens in place),
 * or null when storage could not make one just now.
 */
export interface LegalAssistantAttachment {
  url: string | null;
  contentType: string;
  bytes: number;
  /** The file's own name, shown on a PDF; null for a picture or video. */
  name: string | null;
}

export interface LegalAssistantMessage {
  id: string;
  authorRole: LegalAssistantAuthor;
  body: string;
  createdAt: Date;
  /** The consultant's name on a consultant's message; null otherwise. */
  consultantName: string | null;
  /** The file this line carries; absent on a line of words. */
  attachment?: LegalAssistantAttachment | null;
}

/** `POST /legal/assistant/{id}/attachments`: where to upload one file, and the `key` the send takes as `attachment.key`. */
export interface LegalAssistantUpload {
  uploadUrl: string;
  key: string;
}

/** One line of the brief card (S16): "Lease", "Signed, 14 months left". */
export interface LegalAssistantBriefRow {
  label: string;
  value: string;
}

/**
 * The brief as the client is shown it to confirm (S16), and, once sent,
 * exactly what the consultant was given.
 */
export interface LegalAssistantBrief {
  matter: string;
  matterLabel: string;
  /** "Matter" first, then what the client said, in the client's words. */
  rows: LegalAssistantBriefRow[];
  /** True when it can be sent to a consultant. */
  ready: boolean;
  /**
   * The line under "Send to a consultant" (S16): "Nothing is charged yet."
   * Set while the brief can still be sent, and only because it is true:
   * sending opens a matter with no fee on it. Null once sent (G-500).
   */
  note: string | null;
}

/** The consultant who has joined the conversation (S17). */
export interface LegalAssistantConsultant {
  /** The consultant's name as WAWU Legal holds it; null if none is recorded. */
  name: string | null;
  joinedAt: Date;
}

/**
 * The fixed-price service this conversation's matter starts as (S24, S26;
 * R2-LEGAL2, BACKEND_GAPS G-LEGAL-06-1): set when the matter maps to a
 * `simple` catalogue service that WAWU has put a price on in admin (R-14).
 * The price is that record's, never a number in the app or here.
 */
export interface LegalAssistantFixedPrice {
  /** The catalogue service's code ("cac-registration"). */
  code: string;
  name: string;
  blurb: string;
  /** Whole naira, as WAWU set it in admin. */
  priceNaira: number;
  /** How long it takes ("5 to 7 working days"), or null when WAWU says none. */
  turnaround: string | null;
  /** What the person needs to hand over, one short phrase each; empty when none is named. */
  needs: string[];
}

/**
 * Where the conversation stands.
 * - `profiling`: the assistant is asking.
 * - `brief_ready`: the brief card can be sent (S16).
 * - `sent`: the brief went to a consultant and a matter was opened. Nothing
 *   has been charged at any of these stages.
 */
export type LegalAssistantStage = 'profiling' | 'brief_ready' | 'sent';

/** The whole conversation, as the app draws S14 to S17. */
export interface LegalAssistantThread {
  /** The intake id. */
  id: string;
  stage: LegalAssistantStage;
  matter: string;
  matterLabel: string;
  /** Oldest first. */
  messages: LegalAssistantMessage[];
  /** The live taps under the newest assistant message; empty once sent. */
  quickReplies: LegalAssistantQuickReply[];
  brief: LegalAssistantBrief | null;
  /**
   * The client's last message has no answer yet because the assistant could
   * not reply; `POST /legal/assistant/{id}/reply` asks again.
   */
  awaitingReply: boolean;
  /** The matter opened by "Send to a consultant"; null until then. */
  legalRequestId: string | null;
  /** That matter's status (`awaiting_quote` until a consultant prices it). */
  requestStatus: string | null;
  /**
   * That matter's path: `consultation` (talk to a consultant, book, quote) or
   * `simple` (a fixed-price service with no consultation). Null until sent.
   */
  requestPath: 'simple' | 'consultation' | null;
  /**
   * Set while this conversation can start a fixed-price request in place of
   * being sent to a consultant (S24). `POST /legal/assistant/{id}/start`
   * starts it; sending is refused for such a matter.
   */
  fixedPrice: LegalAssistantFixedPrice | null;
  /** Set once a consultant has written in the conversation. */
  consultant: LegalAssistantConsultant | null;
  /** True once a consultant has joined: the assistant answers no more. */
  assistantStopped: boolean;
}

/**
 * What the assistant and the client said before the brief was sent, for the
 * consultant (`GET /legal/ops/intakes/{id}/assistant`).
 */
export interface LegalAssistantTranscript {
  intakeId: string;
  legalRequestId: string | null;
  brief: LegalAssistantBrief | null;
  messages: LegalAssistantMessage[];
}
