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
  /** A description (Sound effect, Music track) with nothing in it. */
  | 'ai_prompt_empty'
  /** A description longer than the tool's setting allows (AITOOLS-03). Nothing is held. */
  | 'ai_prompt_too_long'
  /** A length longer than the tool's setting allows (AITOOLS-03). Nothing is held. */
  | 'ai_length_too_long'
  /** A file bigger than `ai.input_max_bytes` (AITOOLS-04). Nothing is held. */
  | 'ai_file_too_large'
  /** A file whose length the Hub cannot read (AITOOLS-04). Nothing is held. */
  | 'ai_file_unreadable'
  /** A language Dubbing does not offer (AITOOLS-05), or the same language as the one spoken. Nothing is held. */
  | 'ai_language_unsupported'
  | 'ai_tool_unavailable'
  /** AITOOLS-07: "Your voice" picked before the person agreed to it for VoiceOver, or after they took it back. Nothing is held. */
  | 'own_voice_consent_required'
  /** AITOOLS-07: the person has no Voice Intro recording to make their voice from. Nothing is held. */
  | 'own_voice_recording_required'
  /** AITOOLS-07: the agreement sent is not the words the Hub served. */
  | 'own_voice_consent_line_changed'
  /** AITOOLS-07: the Hub holds no name for the person, so the agreement cannot say who agrees. */
  | 'own_voice_name_required'
  /** AITOOLS-07: a result that is not finished (or failed) cannot be saved or used. */
  | 'job_not_ready'
  /** AITOOLS-09: a shape the picture or video tool does not offer. Nothing is held. */
  | 'ai_shape_unsupported'
  /** AITOOLS-10: a video length the tool does not offer (4, 6 or 8 seconds). Nothing is held. */
  | 'ai_length_unsupported'
  /** AITOOLS-09, AITOOLS-10: a tool that needs a photo was given none. Nothing is held. */
  | 'ai_photo_required'
  /** AITOOLS-09, AITOOLS-10: a photo the Hub cannot open as a picture, or a type it does not take. Nothing is held. */
  | 'ai_photo_unreadable'
  /** AITOOLS-10: Talking photo was given no voice, or two. Nothing is held. */
  | 'ai_speech_required'
  /** AITOOLS-10: a voice the Hub cannot read the length of, or a type the tool does not take. Nothing is held. */
  | 'ai_speech_unreadable'
  /** AITOOLS-08: a result no Create format takes (a FLAC dub, an AAC clip) cannot become a piece. */
  | 'no_format'
  /** AITOOLS-11: a scene with more different voices than the provider takes. Nothing is held. */
  | 'ai_voices_too_many'
  /** AITOOLS-11: a recording too short to make a clone from. Nothing is held. */
  | 'ai_length_too_short'
  /** AITOOLS-11: the person already keeps a clone of their voice (or is making one). Nothing is held. */
  | 'clone_exists'
  | 'not_found';

export const AI_TOOL_ERROR_STATUS: Record<AiToolErrorCode, HttpStatus> = {
  idempotency_key_required: HttpStatus.BAD_REQUEST,
  idempotency_key_reused: HttpStatus.CONFLICT,
  quote_changed: HttpStatus.CONFLICT,
  ai_voice_unknown: HttpStatus.BAD_REQUEST,
  ai_text_empty: HttpStatus.BAD_REQUEST,
  ai_prompt_empty: HttpStatus.BAD_REQUEST,
  ai_prompt_too_long: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_length_too_long: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_file_too_large: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_file_unreadable: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_language_unsupported: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_tool_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  own_voice_consent_required: HttpStatus.CONFLICT,
  own_voice_recording_required: HttpStatus.CONFLICT,
  own_voice_consent_line_changed: HttpStatus.CONFLICT,
  own_voice_name_required: HttpStatus.CONFLICT,
  job_not_ready: HttpStatus.CONFLICT,
  ai_shape_unsupported: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_length_unsupported: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_photo_required: HttpStatus.BAD_REQUEST,
  ai_photo_unreadable: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_speech_required: HttpStatus.BAD_REQUEST,
  ai_speech_unreadable: HttpStatus.UNPROCESSABLE_ENTITY,
  no_format: HttpStatus.CONFLICT,
  ai_voices_too_many: HttpStatus.UNPROCESSABLE_ENTITY,
  ai_length_too_short: HttpStatus.UNPROCESSABLE_ENTITY,
  clone_exists: HttpStatus.CONFLICT,
  not_found: HttpStatus.NOT_FOUND,
};

export interface AiToolErrorDetail {
  /** `quote_changed`: what the job costs now, in points. */
  costPoints?: number;
  /** `ai_prompt_too_long`, `ai_length_too_long`, `ai_file_too_large`: which limit stopped the job (`prompt_characters`, `length_seconds` or `file_bytes`). */
  cap?: string;
  /** The limit's size, in the unit it counts. */
  capLimit?: number;
  /** What the limit counts (`characters`, `seconds` or `bytes`). */
  capUnit?: string;
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
export const PROMPT_EMPTY_MESSAGE = 'Describe what you want to hear.';
export const UNAVAILABLE_MESSAGE =
  'AI voice tools are not available right now. No points were taken.';
export const JOB_NOT_FOUND_MESSAGE = "We couldn't find that job.";
/** What a person reads when a job failed. PT2c. */
export const JOB_FAILED_MESSAGE =
  "That didn't work. No points were taken. Try again.";

/** AITOOLS-07. No message names the provider (R-68) or holds a long dash (R-5). */
export const OWN_VOICE_CONSENT_REQUIRED_MESSAGE =
  'Agree to use your own voice here first. No points were taken.';
export const OWN_VOICE_RECORDING_REQUIRED_MESSAGE =
  'Record your Voice Intro first, then your voice can read your VoiceOver. No points were taken.';
export const OWN_VOICE_LINE_CHANGED_MESSAGE =
  'Those are not the words we showed you. Read them again and agree.';
export const OWN_VOICE_NAME_REQUIRED_MESSAGE =
  'Add your name to your profile first, so we can say who agrees.';
export const JOB_NOT_READY_MESSAGE =
  'Only a finished result can be saved or used.';

/** AITOOLS-08: a description box for a picture or video tool with nothing in it. */
export const PROMPT_EMPTY_MEDIA_MESSAGE = 'Describe what you want to see.';
/** AITOOLS-08: a result no Create format takes. No price, no provider (R-68). */
export const NO_FORMAT_MESSAGE =
  'That result cannot become a piece. Save it or download it instead.';

/** AITOOLS-11. No message names the provider (R-68) or holds a long dash (R-5). */
export const CLONE_EXISTS_MESSAGE =
  'You already keep a copy of your voice. Remove it first to make a new one. No points were taken.';
export const CLONE_FULL_MESSAGE =
  "Saving a voice isn't available right now. No points were taken.";
export const CLONE_NAME_REQUIRED_MESSAGE =
  'Give your voice a name first. No points were taken.';
/** AITOOLS-12: the provider's plan does not cover the route (a 403 `Subscription required`). */
export const UNAVAILABLE_NOW_MESSAGE =
  "This isn't available right now. No points were taken.";
