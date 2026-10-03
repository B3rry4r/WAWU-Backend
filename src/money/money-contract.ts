import { applyDecorators } from '@nestjs/common';
import { ApiExtension, ApiHeader, ApiResponse } from '@nestjs/swagger';
import type { MoneyErrorCode } from './dto/money-enums';
import { MoneyErrorEnvelope } from './dto/money-error.dto';

/**
 * Helpers the Naira wallet contract controllers are declared with (task
 * MONEY-04). docs/contract/CONVENTIONS.md is the prose version of every
 * rule encoded here.
 *
 * The controllers in this folder are a contract, not a service: they sit in
 * MoneyContractModule, which AppModule does not import, so no request can
 * reach them. src/openapi/emit-openapi.ts adds them to contract/openapi.json
 * marked `x-wawu-served: false`, and each operation names the task that
 * serves it (`x-wawu-built-by`). That task writes the handler in a
 * controller a mounted module owns and deletes the declaration here; the
 * emitter refuses a route that is declared here and served as well.
 */

/** The HTTP status each money error code is answered with. One code, one status. */
export const MONEY_ERROR_STATUS: Record<MoneyErrorCode, number> = {
  wallet_not_open: 409,
  wallet_opening: 409,
  wallet_frozen: 423,
  provider_unreachable: 503,
  idempotency_key_required: 400,
  idempotency_key_reused: 409,
  idempotency_in_progress: 409,
  pin_required: 403,
  pin_not_set: 409,
  pin_already_set: 409,
  pin_incorrect: 403,
  pin_locked: 423,
  pin_mismatch: 400,
  reset_code_invalid: 400,
  insufficient_funds: 402,
  daily_limit_exceeded: 403,
  amount_out_of_range: 400,
  quote_changed: 409,
  name_check_failed: 422,
  recipient_not_found: 404,
  recipient_has_no_wallet: 409,
  recipient_blocked: 403,
  self_transfer: 400,
  bank_transfers_blocked: 403,
  target_not_found: 404,
  target_not_payable: 409,
  not_found: 404,
  bvn_not_confirmed: 422,
  bvn_phone_mismatch: 422,
  phone_not_nigerian: 422,
  identity_checks_exhausted: 429,
  bvn_not_checked: 409,
  wallet_already_open: 409,
  selfie_not_matched: 422,
  selfie_checks_exhausted: 429,
  selfie_already_matched: 409,
};

/** Every route that reads or moves a wallet can answer these (MONEY-13, MONEY-11). */
export const WALLET_GATE_ERRORS: MoneyErrorCode[] = [
  'wallet_not_open',
  'wallet_opening',
  'wallet_frozen',
];

/** What a debit can answer before any money moves. */
export const DEBIT_GATE_ERRORS: MoneyErrorCode[] = [
  ...WALLET_GATE_ERRORS,
  'idempotency_key_required',
  'idempotency_key_reused',
  'idempotency_in_progress',
  'pin_required',
  'pin_not_set',
  'pin_incorrect',
  'pin_locked',
  'insufficient_funds',
  'amount_out_of_range',
  'quote_changed',
  'provider_unreachable',
];

/** The task that serves this route, written into the contract as `x-wawu-built-by`. */
export function BuiltBy(task: string): MethodDecorator {
  return ApiExtension('x-wawu-built-by', task);
}

/**
 * Documents the refusals a route can answer with: one response per HTTP
 * status, its description listing the `reason.code` values, its body the
 * one error envelope.
 */
export function MoneyErrors(...codes: MoneyErrorCode[]): MethodDecorator {
  const byStatus = new Map<number, MoneyErrorCode[]>();
  for (const code of new Set(codes)) {
    const status = MONEY_ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const decorators = [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, list]) =>
      ApiResponse({
        status,
        description: `reason.code: ${list.join(', ')}`,
        type: MoneyErrorEnvelope,
      }),
    );
  return applyDecorators(...decorators);
}

/**
 * Required on every request that moves money. Same key and same body
 * answers the first result again; same key with a different body is
 * `idempotency_key_reused` (CONVENTIONS.md, "Idempotency").
 */
export function IdempotencyKeyHeader(): MethodDecorator {
  return ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'One value per payment intent, made by the app when the person first taps (a UUID). Sent again unchanged on every retry of that intent.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  });
}

/** The transaction PIN, only in this header (CONVENTIONS.md, "The transaction PIN"). */
export function TransactionPinHeader(): MethodDecorator {
  return ApiHeader({
    name: 'X-Transaction-Pin',
    required: true,
    description:
      'The four-digit transaction PIN. Only ever in this header: never in a URL, a body or a log.',
    schema: { type: 'string', pattern: '^[0-9]{4}$' },
  });
}

/**
 * The body of every declared handler. The module these controllers sit in
 * is not mounted, so this line never runs inside the app; it exists so a
 * declared route type-checks against its response type, and it fails loudly
 * if somebody mounts a controller before its task has filled the handler in.
 */
export function declaredOnly(task: string, ...inputs: unknown[]): never {
  throw new Error(
    `This money route is declared by MONEY-04 and served by ${task}; it was called with ${inputs.length} input(s) while its handler is still the declaration.`,
  );
}
