import { HttpException } from '@nestjs/common';

/**
 * Every refusal the registration routes give (JOIN-01). The app and the
 * website switch on `reason.code`, never on the message. The HTTP status
 * comes from this table, never from the thrower, so a code cannot drift from
 * its status. `message` is a plain sentence a person may read as it is: no
 * em-dash, no provider name, nothing the caller sent.
 */
export const WAITLIST_ERROR_STATUS = {
  /** No offer is open now (or the offer asked for does not exist). */
  no_open_offer: 404,
  /** The offer exists but registration is closed or has not opened yet. */
  offer_closed: 409,
  /** This phone or email already paid for the offer. Nothing is charged. */
  already_registered: 409,
  /** No registration has this reference. The same answer for every miss. */
  not_found: 404,
  /** Flutterwave does not (yet) say this payment succeeded. Try the check again. */
  payment_not_confirmed: 409,
  /** The payment is not this registration's: wrong amount, currency or reference. */
  payment_mismatch: 422,
  /** This transaction id already paid for another registration. */
  transaction_already_used: 409,
  /** Flutterwave could not be reached to check the payment. Try again. */
  payment_check_unavailable: 503,
  /** Payments are not set up on this server. */
  payments_unavailable: 503,
  phone_invalid: 400,
  email_invalid: 400,
  name_invalid: 400,
  consent_required: 400,
} as const;

export type WaitlistErrorCode = keyof typeof WAITLIST_ERROR_STATUS;

export const WAITLIST_ERROR_CODES = Object.keys(
  WAITLIST_ERROR_STATUS,
) as WaitlistErrorCode[];

/**
 * `{ statusCode, message, data: null, reason: { code, message } }`: the one
 * error shape (docs/contract/CONVENTIONS.md section 3). AllExceptionsFilter
 * carries `reason` through untouched.
 */
export class WaitlistError extends HttpException {
  readonly code: WaitlistErrorCode;

  constructor(code: WaitlistErrorCode, message: string) {
    super({ message, reason: { code, message } }, WAITLIST_ERROR_STATUS[code]);
    this.code = code;
  }
}
