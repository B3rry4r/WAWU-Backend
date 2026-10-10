import { applyDecorators } from '@nestjs/common';
import { ApiExtension, ApiHeader, ApiResponse } from '@nestjs/swagger';
import type { MoneyErrorCode } from './dto/money-enums';
import {
  MoneyErrorEnvelope,
  MoneyPlainErrorEnvelope,
} from './dto/money-error.dto';

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
  // Default (agent), owner may override: 409, the list is full until one goes.
  beneficiary_limit_reached: 409,
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
  selfie_required: 409,
  identity_has_wallet: 409,
  account_not_opened: 422,
  // Default (agent), owner may override: 409, as identity_has_wallet.
  phone_held_by_other_identity: 409,
  reset_codes_exhausted: 429,
  // Never 401 (that signs the person out) and never a PIN code: a refused
  // biometric approval uses up no PIN try (R-26).
  device_approval_refused: 403,
  // Default (lead), owner may override: a payment for this item is still
  // being confirmed, so a second one is not taken (MONEY-17).
  payment_in_progress: 409,
  // Default (agent/lead), owner may override: a period with too many rows
  // for one file is the caller's to shorten, so a 400 (WALLET-27).
  statement_too_large: 400,
  // The per-person statement limit and the two-at-once cap (WALLET-27 round 3).
  statement_rate_limited: 429,
  statement_busy: 503,
  recipient_search_rate_limited: 429,
  // NUV-07 (R-42): the running provider's fees are settings not filled in
  // yet; nothing is quoted or moved until they are. Not a provider failure.
  fees_not_set: 503,
  // Default (agent), owner may override: 403, as daily_limit_exceeded. The
  // request is understood; this person may not move that much now.
  limit_reached: 403,
  // NUV-02. Default (agent), owner may override: 409, as wallet_opening. The
  // request is understood; the person waits for the review to end.
  identity_under_review: 409,
  // NUV-02 round 2, U3. Default (agent), owner may override: 409, as
  // wallet_already_open. The request is understood; this wallet is opened
  // another way, so asking again changes nothing.
  step_not_used: 409,
  // NUV-02 round 3. Default (lead), owner may override: 429, as
  // identity_checks_exhausted, with retryAfterSeconds.
  open_address_limited: 429,
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
  // NUV-07: fees not set (R-42), and WAWU's or the provider's own limit.
  'fees_not_set',
  'limit_reached',
];

/** The task that serves this route, written into the contract as `x-wawu-built-by`. */
export function BuiltBy(task: string): MethodDecorator {
  return ApiExtension('x-wawu-built-by', task);
}

/**
 * The most items a list route answers with, written into the contract as
 * `x-wawu-max-items` and as `maxItems` on the 200 array
 * (scripts/enrich-contract.js). Short lists carry a stated maximum
 * (CONVENTIONS.md section 6).
 */
export function MaxItems(max: number): MethodDecorator {
  return ApiExtension('x-wawu-max-items', max);
}

/**
 * Documents the plain 400 of a malformed field: no `reason`, just the
 * envelope (CONVENTIONS.md section 3).
 */
export function PlainBadRequest(description: string): MethodDecorator {
  return ApiResponse({
    status: 400,
    description,
    type: MoneyPlainErrorEnvelope,
  });
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
 * The two ways to approve, documented together on a route that takes either
 * (MONEY-14; CONVENTIONS.md section 5, "Approving with a fingerprint or a
 * face"): the PIN, or a biometric approval from the registered phone. Each
 * is optional on its own; the route refuses a request with neither
 * (`403 pin_required`).
 */
export function ApprovalHeaders(): MethodDecorator {
  return applyDecorators(
    ApiHeader({
      name: 'X-Transaction-Pin',
      required: false,
      description:
        'The four-digit transaction PIN, unless X-Device-Approval is sent. Only ever in this header: never in a URL, a body or a log.',
      schema: { type: 'string', pattern: '^[0-9]{4}$' },
    }),
    DeviceApprovalHeader(),
  );
}

/** A biometric approval from the registered phone, in place of the PIN (MONEY-14). */
function DeviceApprovalHeader(): MethodDecorator {
  return ApiHeader({
    name: 'X-Device-Approval',
    required: false,
    description:
      "Instead of X-Transaction-Pin: `v1.<challengeId>.<signature>`, the registered phone key's P-256 signature (DER, base64url) over the challenge and this exact request. Send this or X-Transaction-Pin, not both.",
    schema: {
      type: 'string',
      pattern: '^v1\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{8,200}$',
    },
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
