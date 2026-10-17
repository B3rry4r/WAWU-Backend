/** The Idempotency-Key route of paying a request (its keys are its own, apart from a plain send's). */
export const MONEY_REQUEST_PAY_ROUTE = 'POST chats/money-requests/pay';

export const REQUEST_NOT_FOUND_MESSAGE = 'We could not find that request.';
export const REQUEST_NOT_YOURS_PAY_MESSAGE =
  'Only the person who was asked can pay this request.';
export const REQUEST_NOT_YOURS_DECLINE_MESSAGE =
  'Only the person who was asked can decline this request.';
export const REQUEST_NOT_YOURS_CANCEL_MESSAGE =
  'Only the person who made this request can cancel it.';
export const REQUEST_BEING_PAID_MESSAGE =
  'This request is already being paid. Check again in a moment.';

/** Why a request cannot be acted on, by the status it is in now. */
export function requestNotPendingMessage(status: string): string {
  switch (status) {
    case 'paid':
      return 'This request has already been paid.';
    case 'declined':
      return 'This request was declined.';
    case 'cancelled':
      return 'This request was cancelled.';
    default:
      return 'This request can no longer be changed.';
  }
}
