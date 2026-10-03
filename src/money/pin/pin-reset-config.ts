import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PIN_MAX_TRIES } from './transaction-pin.service';

/**
 * Settings for resetting the PIN by a code to the phone, and for biometric
 * approval (task MONEY-14). Each is read once at boot; a value that is set
 * but not a whole number in its range stops the app rather than run with a
 * number nobody chose.
 */
export const PIN_RESET_CONFIG_KEYS = {
  codeSeconds: 'PIN_RESET_CODE_SECONDS',
  resendSeconds: 'PIN_RESET_RESEND_SECONDS',
  textsPerDay: 'PIN_RESET_TEXTS_PER_DAY',
  approvalSeconds: 'DEVICE_APPROVAL_SECONDS',
} as const;

/** Digits in a reset code. A million codes, against the PIN's ten thousand. */
export const RESET_CODE_DIGITS = 6;

/**
 * Wrong codes one reset code takes before it stops working: the PIN's own
 * five (MONEY-09), so a code never gets more guesses than the PIN it
 * replaces.
 */
export const RESET_TRIES_PER_CODE = PIN_MAX_TRIES;

/** The window the daily text limit counts over: a rolling 24 hours. */
export const RESET_WINDOW_MS = 24 * 60 * 60_000;

/**
 * PROVISIONAL(PIN-RESET-LIMITS, owner=YOU, why=no ruling names a reset code's life, its resend gap or a daily text limit; each text costs 7 naira)
 *
 * The code lives 300 s and Resend opens after 60 s: the values sign-up's
 * phone code uses (AUTH-03, wawu-id `phone-verification.config.ts`, also
 * provisional there). At most 5 texts in any 24 hours per person and per
 * phone, the same daily figure sign-up allows a number: 35 naira a day at
 * most (`docs/fintava/fees.md`, 7 naira a text). With 5 tries a code, that
 * is at most 25 guesses a day at a 6-digit code (25 in a million), against
 * the PIN's 5 tries every lock (240 a day at the default 30 minutes, 240 in
 * ten thousand): a reset is never the easier way in. Overridable in config.
 */
export const PIN_RESET_DEFAULTS = {
  codeSeconds: 300,
  resendSeconds: 60,
  textsPerDay: 5,
} as const;

/**
 * PROVISIONAL(DEVICE-APPROVAL-SECONDS, owner=YOU, why=no ruling names how long a biometric approval's challenge lives)
 *
 * How long a challenge for a biometric approval can be signed and used:
 * 120 s covers the biometric prompt and one slow request, and a challenge
 * works once whatever its age. Overridable with DEVICE_APPROVAL_SECONDS.
 */
export const DEFAULT_DEVICE_APPROVAL_SECONDS = 120;

/** A whole number from `min` to `max`, or the default when unset or empty. */
export function wholeSetting(
  key: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

@Injectable()
export class PinResetSettings {
  readonly codeMs: number;
  readonly resendMs: number;
  readonly textsPerDay: number;
  readonly approvalMs: number;

  constructor(config: ConfigService) {
    const get = (key: string) => config.get<string>(key);
    const k = PIN_RESET_CONFIG_KEYS;
    const codeSeconds = wholeSetting(
      k.codeSeconds,
      get(k.codeSeconds),
      PIN_RESET_DEFAULTS.codeSeconds,
      60,
      3600,
    );
    const resendSeconds = wholeSetting(
      k.resendSeconds,
      get(k.resendSeconds),
      PIN_RESET_DEFAULTS.resendSeconds,
      30,
      3600,
    );
    if (resendSeconds > codeSeconds) {
      throw new Error(
        `${k.resendSeconds} must not be longer than ${k.codeSeconds}: a code would die before Resend opens.`,
      );
    }
    this.codeMs = codeSeconds * 1000;
    this.resendMs = resendSeconds * 1000;
    this.textsPerDay = wholeSetting(
      k.textsPerDay,
      get(k.textsPerDay),
      PIN_RESET_DEFAULTS.textsPerDay,
      1,
      20,
    );
    this.approvalMs =
      wholeSetting(
        k.approvalSeconds,
        get(k.approvalSeconds),
        DEFAULT_DEVICE_APPROVAL_SECONDS,
        30,
        600,
      ) * 1000;
  }
}
