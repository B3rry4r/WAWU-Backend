import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Why a voice route refused (VOICE-01). Same body as every other refusal:
 * `{ statusCode, message, data: null, reason: { code, message } }`
 * (docs/contract/CONVENTIONS.md section 3). Points refusals are `PointsError`,
 * passed through as POINTS-03 sends them. No message names the voice provider
 * (R-68) or holds a long dash (R-5).
 */
export type VoiceErrorCode =
  | 'idempotency_key_required'
  | 'voice_unavailable'
  | 'voice_text_required'
  | 'voice_text_empty'
  | 'voice_text_too_long'
  | 'voice_consent_required'
  | 'voice_consent_line_changed'
  | 'voice_sample_required'
  | 'voice_sample_unusable'
  | 'voice_intro_busy'
  | 'voice_preview_limit';

export const VOICE_ERROR_STATUS: Record<VoiceErrorCode, HttpStatus> = {
  idempotency_key_required: HttpStatus.BAD_REQUEST,
  voice_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  voice_text_required: HttpStatus.CONFLICT,
  voice_text_empty: HttpStatus.BAD_REQUEST,
  voice_text_too_long: HttpStatus.BAD_REQUEST,
  voice_consent_required: HttpStatus.CONFLICT,
  voice_consent_line_changed: HttpStatus.CONFLICT,
  voice_sample_required: HttpStatus.CONFLICT,
  voice_sample_unusable: HttpStatus.BAD_REQUEST,
  voice_intro_busy: HttpStatus.CONFLICT,
  voice_preview_limit: HttpStatus.TOO_MANY_REQUESTS,
};

export class VoiceError extends HttpException {
  readonly code: VoiceErrorCode;

  constructor(
    code: VoiceErrorCode,
    message: string,
    detail: { maxCharacters?: number } = {},
  ) {
    super(
      { message, reason: { code, message, ...detail } },
      VOICE_ERROR_STATUS[code],
    );
    this.code = code;
  }
}

export const KEY_REQUIRED_MESSAGE =
  'Send an Idempotency-Key of 8 to 128 letters, digits, - or _ with this request.';
export const UNAVAILABLE_MESSAGE =
  'Voices are not available right now. No points were taken.';
export const PREVIEW_UNAVAILABLE_MESSAGE =
  "We couldn't say that just now. Try again in a moment.";
export const TEXT_EMPTY_MESSAGE = 'Write what your Voice Intro should say.';
export const TEXT_REQUIRED_MESSAGE =
  'Write what your Voice Intro should say first.';
export const CONSENT_REQUIRED_MESSAGE =
  'Agree that this is your own voice before you go on.';
export const CONSENT_CHANGED_MESSAGE =
  'The words you agree to have changed. Read them again and agree.';
export const RECORDING_REQUIRED_MESSAGE = 'Record your 30 second sample first.';
export const RECORDING_UNUSABLE_MESSAGE =
  'That recording could not be used. Record it again.';
export const BUSY_MESSAGE =
  'Your Voice Intro is still being made. Wait for it to finish.';
export const PREVIEW_LIMIT_MESSAGE =
  'You have heard your name a lot in the last hour. Try again a little later.';
/** What a person reads when a run failed. */
export const RUN_FAILED_MESSAGE =
  "That didn't work. No points were taken. Try again.";
export const tooLongMessage = (max: number) =>
  `Your Voice Intro can have up to ${max} characters.`;
