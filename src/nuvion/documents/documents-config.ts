import type { PersonRateWindow } from '../../money/person-window-limiter';

/**
 * Limits and plain sentences of the document and selfie routes (task
 * NUV-03). The sentences are ours: no provider name, no provider text, no
 * em-dash, nothing the caller sent.
 */

/**
 * PROVISIONAL(NUVION-DOCUMENT-UPLOAD-LIMITS, owner=YOU, why=no ruling names a limit for document uploads; every upload is up to 20 MB held in memory and one call to Nuvion, so a person's attempts and the uploads in flight at once are capped)
 *
 * How many upload requests one person may make (a hundred a day would be a
 * script: two documents, a few retries and a replacement or two fit well
 * inside these), and how many uploads the server holds at once.
 */
export const DOCUMENT_UPLOAD_WINDOWS: readonly PersonRateWindow[] = [
  { name: 'ten_minutes', limit: 8, windowMs: 10 * 60_000 },
  { name: 'day', limit: 30, windowMs: 24 * 60 * 60_000 },
];
export const DOCUMENT_UPLOADS_AT_ONCE = 4;
/** How long an upload waits for a place before `document_busy`. */
export const DOCUMENT_UPLOAD_WAIT_MS = 5_000;
/** Hosted selfie sessions one person may start. */
export const LIVENESS_START_WINDOWS: readonly PersonRateWindow[] = [
  { name: 'hour', limit: 6, windowMs: 60 * 60_000 },
];

export const MSG = {
  noWallet: "You don't have a wallet yet. Open your wallet to continue.",
  closed:
    'Your wallet is not taking documents right now. Check where your opening stands.',
  notNeeded: 'Your wallet does not need documents.',
  inProgress:
    'We are still confirming your last upload. Check again in a moment.',
  busy: 'We are busy with other uploads. Try again in a moment.',
  rateLimited: 'You have sent a lot of files. Try again later.',
  unreachable: 'We could not send that right now. Try again in a moment.',
  unconfirmed:
    'We could not confirm that upload yet. Check again in a moment before you send it again.',
  notAccepted:
    'We could not accept that file. Check that it is clear and complete, then try again.',
  badKind: 'Say which document this is: identity or proof_of_address.',
  noFile: 'Choose a file to upload.',
  badPart: 'That request has a part we do not read.',
  fileEmpty: 'That file is empty. Choose another.',
  fileTooBig: 'That file is larger than 10 MB. Choose a smaller one.',
  fileType: 'Upload a PDF, JPG or PNG file.',
  sidesDiffer: 'Use the same file type for both sides.',
  backOnlyId: 'Only an ID document has a back side.',
  sidesTogether: 'Send both sides of an ID in one request: file and file_back.',
  selfieOff: 'A selfie is not needed for this wallet.',
  selfieRefused: 'The selfie check is not available right now.',
  badReturn: 'The address to return to must be a secure web address we know.',
} as const;
