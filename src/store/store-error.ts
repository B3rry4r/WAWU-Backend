import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Why a store route refused (task IAP-01, R-86). The body is the contract's one
 * error shape, `{ statusCode, message, data: null, reason: { code, message } }`
 * (docs/contract/CONVENTIONS.md section 3); the app switches on `reason.code`.
 * The messages are plain sentences with no em-dash, and never carry anything
 * the store or the caller sent.
 */
export type StoreErrorCode =
  /** The Hub has no credentials for that store yet (or no root certificates). Nothing was asked of the store. */
  | 'store_not_configured'
  /** An admin has switched that store's purchases off. */
  | 'store_disabled'
  /** No active product with that id in that store. */
  | 'store_product_unknown'
  /** The request names no purchase token (Google) or no transaction id (Apple), or the room a pass is for. */
  | 'store_receipt_missing'
  /** The store does not know that purchase, or says it was cancelled, refunded or is for another app or product. */
  | 'store_purchase_invalid'
  /** The store says the purchase is still pending (a slow payment method). Nothing is granted; ask again later. */
  | 'store_purchase_pending'
  /** That store transaction was already used by another WAWU account. */
  | 'store_purchase_taken'
  /**
   * That store transaction was first given to another room (a community pass is
   * bound to the person AND the room it first granted). Buy a pass for this room.
   */
  | 'store_purchase_other_room'
  /** The store could not be reached or answered something unusable. Safe to ask again. */
  | 'store_unreachable'
  /** A pass was bought for a room that does not sell one, or that the person hosts or cannot join. */
  | 'store_pass_not_available'
  /** An admin's product body is wrong (the grant does not fit the kind, an id is taken). */
  | 'store_product_invalid'
  /** The purchase carries no account token and the cutover has passed: the app did not bind it to the person. */
  | 'store_account_token_missing'
  /** The purchase was paid but the Hub could not finish giving it (a fault on our side). Nothing is lost; asking again, or the store's own notice, tries again. */
  | 'store_grant_failed';

export const STORE_ERROR_STATUS: Record<StoreErrorCode, HttpStatus> = {
  store_not_configured: HttpStatus.SERVICE_UNAVAILABLE,
  store_disabled: HttpStatus.CONFLICT,
  store_product_unknown: HttpStatus.NOT_FOUND,
  store_receipt_missing: HttpStatus.BAD_REQUEST,
  store_purchase_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  store_purchase_pending: HttpStatus.CONFLICT,
  store_purchase_taken: HttpStatus.CONFLICT,
  store_purchase_other_room: HttpStatus.CONFLICT,
  store_unreachable: HttpStatus.SERVICE_UNAVAILABLE,
  store_pass_not_available: HttpStatus.CONFLICT,
  store_product_invalid: HttpStatus.BAD_REQUEST,
  store_account_token_missing: HttpStatus.UNPROCESSABLE_ENTITY,
  store_grant_failed: HttpStatus.INTERNAL_SERVER_ERROR,
};

export class StoreError extends HttpException {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super({ message, reason: { code, message } }, STORE_ERROR_STATUS[code]);
    this.code = code;
  }
}

export const NOT_CONFIGURED_MESSAGE =
  'Buying through the store is not switched on yet.';
export const DISABLED_MESSAGE =
  'Buying through this store is paused right now.';
export const UNREACHABLE_MESSAGE =
  'We could not reach the store to check this purchase. Please try again in a moment.';

export const OTHER_ROOM_MESSAGE =
  'That payment was already used for another room. Buy a new pass for this room.';

export const GRANT_FAILED_MESSAGE =
  'The store has your payment, but we could not finish giving it yet. Please try again in a moment.';
