/**
 * What the document and selfie routes answer (task NUV-03). Small and plain
 * so the app and the website draw their steps from it: which documents are
 * in, whether uploads are open, what the submission waits for. Never a file,
 * a file name, a number read off a document, or a face.
 */

export type DocumentKindView = 'identity' | 'proof_of_address';

/**
 * - `missing`: nothing sent for it yet;
 * - `confirming`: sent, and Nuvion's answer is not known yet (look again; do
 *   not send it twice);
 * - `send_again`: sent, no answer came, and once the wait was over Nuvion's
 *   own list did not show the file (or could not be read): WAWU keeps no
 *   copy, so ask the person for it again. Sending it is safe: the server
 *   asks Nuvion once more first and never sends a file Nuvion already has;
 * - `uploaded`: Nuvion has it;
 * - `not_accepted`: Nuvion refused the last file, nothing was kept: send
 *   another;
 * - `needs_new`: Nuvion's review said this document did not pass, and that
 *   stays true after the person corrects their details: only a new file
 *   clears it, and the opening is not sent again without one.
 */
export type DocumentStateView =
  | 'missing'
  | 'confirming'
  | 'send_again'
  | 'uploaded'
  | 'not_accepted'
  | 'needs_new';

export interface IdentityDocumentView {
  kind: DocumentKindView;
  state: DocumentStateView;
  /** Which sides were sent: `front`, and `back` for an ID that has one. */
  sides: Array<'front' | 'back'>;
  /** When Nuvion took it, ISO 8601 UTC; null until then. */
  uploadedAt: string | null;
}

/** What the opening still waits for before it is sent for review. */
export type DocumentStepView = 'identity' | 'proof_of_address' | 'selfie';

/**
 * `GET /money/identity/documents` and `POST /money/identity/documents`: the
 * state of the opening's documents. Opening is sent to Nuvion for review by
 * itself, once, when both documents are in (and the selfie has passed, when
 * the selfie is in use).
 */
export interface IdentityDocumentsView {
  /** False when this wallet's provider takes no documents: nothing to upload. */
  required: boolean;
  /** Uploads are accepted now. */
  open: boolean;
  /** Both kinds, always, in this order: identity, proof_of_address. */
  documents: IdentityDocumentView[];
  /** `not_used`: no selfie in this opening; `needed`; `done`. */
  selfie: 'not_used' | 'needed' | 'done';
  /** The opening was sent for Nuvion's review. */
  submitted: boolean;
  submittedAt: string | null;
  /** What is still needed before the opening is sent, in order. */
  waitingFor: DocumentStepView[];
  /** The largest file accepted, in bytes. */
  maxBytes: number;
  /** The file types accepted. */
  acceptedTypes: string[];
}

export type LivenessStateView =
  | 'not_in_use'
  | 'not_started'
  | 'pending'
  | 'passed'
  | 'not_passed'
  | 'expired';

/** `GET` and `POST /money/identity/liveness`: the hosted selfie. */
export interface IdentityLivenessView {
  /** False when the selfie is not part of this opening. */
  enabled: boolean;
  state: LivenessStateView;
  /** The secure page to open, or resume, while the selfie is pending; null otherwise. */
  url: string | null;
  /** When the current session started, ISO 8601 UTC. */
  startedAt: string | null;
  /** A (new) session may be started now. */
  canStart: boolean;
}
