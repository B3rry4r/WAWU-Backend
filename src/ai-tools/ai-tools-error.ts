import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Why an AI tool route refused (AITOOLS-01). Same body as every other refusal:
 * `{ statusCode, message, data: null, reason: { code, message, ... } }`
 * (docs/contract/CONVENTIONS.md section 3). Cap and points refusals are
 * `PointsError`, passed through as POINTS-03 sends them.
 */
export type AiToolErrorCode =
  | 'idempotency_key_required'
  | 'idempotency_key_reused'
  /** The job costs other points than the quote showed, or the quote is old or not this person's. */
  | 'quote_changed'
  | 'ai_voice_unknown'
  | 'ai_text_empty'
  | 'ai_tool_unavailable'
  | 'not_found';

export const AI_TOOL_ERROR_STATUS: Record<AiToolErrorCode, HttpStatus> = {
  idempotency_key_required: HttpStatus.BAD_REQUEST,
  idempotency_key_reused: HttpStatus.CONFLICT,
  quote_changed: HttpStatus.CONFLICT,
  ai_voice_unknown: HttpStatus.BAD_REQUEST,
  ai_text_empty: HttpStatus.BAD_REQUEST,
  ai_tool_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  not_found: HttpStatus.NOT_FOUND,
};

export interface AiToolErrorDetail {
  /** `quote_changed`: what the job costs now, in points. */
  costPoints?: number;
}

export class AiToolError extends HttpException {
  readonly code: AiToolErrorCode;

  constructor(
    code: AiToolErrorCode,
    message: string,
    detail: AiToolErrorDetail = {},
  ) {
    super(
      { message, reason: { code, message, ...detail } },
      AI_TOOL_ERROR_STATUS[code],
    );
    this.code = code;
  }
}

export const KEY_REQUIRED_MESSAGE =
  'Send an Idempotency-Key of 8 to 128 letters, digits, - or _ with this job.';
export const KEY_REUSED_MESSAGE =
  'That Idempotency-Key was already used for a different job. Start the job again.';
export const QUOTE_CHANGED_MESSAGE =
  'The cost changed or the quote ended. Check the points and run it again. No points were taken.';
export const VOICE_UNKNOWN_MESSAGE = 'Pick one of the voices on the list.';
export const TEXT_EMPTY_MESSAGE = 'Type or paste the words to speak.';
export const UNAVAILABLE_MESSAGE =
  'AI voice tools are not available right now. No points were taken.';
export const JOB_NOT_FOUND_MESSAGE = "We couldn't find that job.";
/** What a person reads when a job failed. PT2c. */
export const JOB_FAILED_MESSAGE =
  "That didn't work. No points were taken. Try again.";
