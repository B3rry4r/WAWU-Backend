import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Why a movie route refused (FLIX-01). Same body as every other refusal:
 * `{ statusCode, message, data: null, reason: { code, message } }`
 * (docs/contract/CONVENTIONS.md section 3). No message names the partner's
 * technology or holds a long dash (R-5).
 */
export type MoviesErrorCode =
  | 'movies_off'
  | 'movie_not_found'
  | 'terms_not_agreed'
  | 'movie_not_premiered'
  | 'account_closing'
  | 'email_required'
  | 'movies_unavailable';

export const MOVIES_ERROR_STATUS: Record<MoviesErrorCode, HttpStatus> = {
  movies_off: HttpStatus.NOT_FOUND,
  movie_not_found: HttpStatus.NOT_FOUND,
  terms_not_agreed: HttpStatus.CONFLICT,
  movie_not_premiered: HttpStatus.CONFLICT,
  account_closing: HttpStatus.CONFLICT,
  email_required: HttpStatus.CONFLICT,
  movies_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
};

export class MoviesError extends HttpException {
  readonly code: MoviesErrorCode;

  constructor(code: MoviesErrorCode, message: string) {
    super({ message, reason: { code, message } }, MOVIES_ERROR_STATUS[code]);
    this.code = code;
  }
}

export const MOVIES_OFF_MESSAGE = 'Movies are not available.';
export const MOVIE_NOT_FOUND_MESSAGE = 'That movie is not available.';
export const TERMS_NOT_AGREED_MESSAGE =
  'Agree to the terms before you continue.';
export const MOVIE_NOT_PREMIERED_MESSAGE =
  'This movie has not premiered yet. You can watch it once it does.';
export const MOVIES_UNAVAILABLE_MESSAGE =
  "We couldn't open movies just now. Try again in a moment.";
export const ACCOUNT_CLOSING_MESSAGE =
  'Your account is being deleted, so Flixora cannot be opened.';
export const EMAIL_REQUIRED_MESSAGE =
  'Add your email address to your profile to open Flixora.';
