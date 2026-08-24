/**
 * The boundary around Gemini.
 *
 * An interface with a DI token rather than a direct SDK call, following the
 * same pattern this codebase already uses for Flutterwave: a real adapter
 * that talks to the network, a deterministic mock that does not, and a
 * factory that picks between them. Contract tests then exercise the whole
 * legal-intake flow without a network call or an API key, and without
 * asserting against whatever a model happened to say that afternoon.
 */

export interface GeminiBriefRequest {
  /** The system-level framing. Kept separate so it can be audited. */
  instruction: string;
  /** The intake, already rendered as text by the caller. */
  content: string;
}

/**
 * What the model is asked to return, and all this backend will accept.
 *
 * A narrow, checked shape rather than free prose. The brief is read by a
 * lawyer before advising a client, so it needs a predictable structure the
 * dashboard can render and a human can scan — not a wall of text whose
 * headings change between requests.
 */
export interface GeminiBrief {
  /** Two or three sentences a consultant can read in ten seconds. */
  summary: string;
  /** The legal issues the matter turns on. */
  keyIssues: string[];
  /** What the consultant should establish early, phrased as questions. */
  questionsToClarify: string[];
  /** Anything that looks time-critical or high-risk. Often empty. */
  risks: string[];
}

export interface GeminiClient {
  generateBrief(request: GeminiBriefRequest): Promise<GeminiBrief>;
}

export const GEMINI_CLIENT = Symbol('GEMINI_CLIENT');
