import { applyDecorators, GoneException } from '@nestjs/common';
import { ApiExtension, ApiGoneResponse } from '@nestjs/swagger';

/**
 * WAWU Shop is retired (DECISIONS R-2, owner, 1 Oct 2026; task OPS-08).
 *
 * What still answers, and why:
 *   - a buyer's orders (`GET /shop/orders`, `GET /shop/orders/:orderId`), so a
 *     past order stays readable wherever purchases are listed;
 *   - `POST /shop/orders/:orderId/verify`, and the Flutterwave webhook that
 *     calls the same service method, so a charge opened before the shop
 *     closed still settles into a paid order instead of leaving a buyer
 *     charged with nothing to show for it;
 *   - the admin order queue and fulfilment, because a paid order is still a
 *     box somebody is owed;
 *   - the admin product list and detail, because order lines point at those
 *     rows.
 *
 * Everything that browses, fills a cart, opens a checkout or changes the
 * catalogue answers 410 Gone in the backend's one error shape
 * (docs/contract/CONVENTIONS.md section 3): `{ statusCode, message, data:
 * null, reason: { code: 'shop_retired', message } }`. A client switches on
 * `reason.code`, never on the sentence. The guards stay on each route, so a
 * caller with no token still gets the same 401 it always did before it
 * reaches the 410.
 */
export const SHOP_RETIRED_CODE = 'shop_retired';

export const SHOP_RETIRED_MESSAGE =
  'WAWU Shop has closed and no longer takes orders. Orders you already placed are still in your purchases.';

export const SHOP_CATALOGUE_RETIRED_MESSAGE =
  'WAWU Shop has closed, so products can no longer be added or changed. Orders already placed can still be read and dispatched.';

/** The 410 a retired buyer-facing Shop route answers. */
export function shopRetired(): GoneException {
  return gone(SHOP_RETIRED_MESSAGE);
}

/** The 410 a retired admin catalogue write answers. */
export function shopCatalogueRetired(): GoneException {
  return gone(SHOP_CATALOGUE_RETIRED_MESSAGE);
}

function gone(message: string): GoneException {
  return new GoneException({
    message,
    reason: { code: SHOP_RETIRED_CODE, message },
  });
}

/**
 * Marks a retired route in the contract: it answers 410 with
 * `reason.code: shop_retired`, and `x-wawu-retired-by` names the task that
 * retired it. The emitter still lists a default 200/201 with an empty body
 * beside it; `x-wawu-retired-by` is what says that one never happens.
 */
export function ShopRetiredRoute(message: string): MethodDecorator {
  return applyDecorators(
    ApiGoneResponse({
      description: `reason.code: ${SHOP_RETIRED_CODE}. ${message}`,
      schema: {
        type: 'object',
        required: ['statusCode', 'message', 'data', 'reason'],
        properties: {
          statusCode: { type: 'number', enum: [410] },
          message: { type: 'string' },
          data: { type: 'null' },
          reason: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', enum: [SHOP_RETIRED_CODE] },
              message: { type: 'string' },
            },
          },
        },
      },
    }),
    ApiExtension('x-wawu-retired-by', 'OPS-08'),
  );
}
