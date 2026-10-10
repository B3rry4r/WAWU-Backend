import { foldDigits } from '../money/receipts/receipt-document';
import {
  WALLET_PROVIDER_UNKNOWN_OUTCOMES,
  WalletProviderError,
  type WalletProviderErrorKind,
} from '../wallet-provider/wallet-provider-error';
import {
  PROVIDER_LIMIT_ERROR_TYPES,
  providerLimitError,
  type WalletProviderLimitError,
} from '../wallet-provider/wallet-provider-limit';

/**
 * Nuvion's failures in the seam's neutral words (task NUV-01).
 *
 * Every `type` on Nuvion's errors page (the lead's scratchpad
 * `nuvion/docs/errors.md`, "Error reference", every group) is mapped to
 * exactly one `WalletProviderError` kind below, so a service decides on the
 * kind alone and never reads a Nuvion type. A type Nuvion adds later, or an
 * answer without one, falls back on its HTTP status (`kindForStatus`).
 *
 * What kind of call failed decides what a lost answer means:
 * - `read`: nothing changed at Nuvion; safe to ask again;
 * - `write`: money may have moved or something was created; the outcome is
 *   unknown until it is reconciled, never retried blindly;
 * - `check`: an identity or document check; a refusal is about the person.
 */
export type NuvionCallKind = 'read' | 'write' | 'check';

/**
 * Each documented `error_*` type and its kind. Grouped as Nuvion groups
 * them. A type whose meaning depends on the call (a 5xx-class type, or one
 * that says a write may still be running) is mapped by `kindForType`.
 */
export const NUVION_ERROR_TYPE_KINDS: Readonly<
  Record<string, WalletProviderErrorKind | 'by_call'>
> = {
  // Authentication & authorization
  error_auth_credentials_invalid: 'auth',
  error_auth_credentials_revoked: 'auth',
  error_auth_permission_denied: 'auth',
  error_auth_elevated_permission_required: 'auth',
  error_auth_rate_limit_exceeded: 'rate_limited',
  error_auth_api_version_locked: 'auth',
  error_auth_api_version_not_supported: 'auth',
  error_auth_api_version_not_available: 'auth',
  error_auth_api_version_deprecated: 'auth',
  error_auth_api_version_access_denied: 'auth',
  error_auth_verification_token_not_found: 'refused',
  error_auth_verification_token_expired: 'refused',
  error_auth_verification_token_already_used: 'refused',
  error_auth_verification_token_invalid: 'refused',
  error_auth_email_verification_required: 'refused',
  error_auth_mfa_already_enrolled: 'refused',
  error_auth_mfa_enrollment_not_found: 'refused',
  error_auth_mfa_enrollment_already_completed: 'refused',
  error_auth_mfa_enrollment_inactive: 'refused',
  error_auth_mfa_permission_denied: 'refused',
  error_auth_mfa_code_invalid: 'refused',
  error_auth_mfa_verification_in_progress: 'refused',
  error_auth_mfa_verification_not_in_progress: 'refused',
  error_auth_mfa_not_enrolled: 'refused',
  // Validation
  error_validation_error: 'validation',
  error_validation_required_field_missing: 'validation',
  error_validation_invalid_format: 'validation',
  error_validation_email_invalid: 'validation',
  error_validation_phone_invalid: 'validation',
  error_validation_date_invalid: 'validation',
  error_validation_amount_invalid: 'validation',
  error_validation_value_out_of_range: 'validation',
  error_validation_invalid_id: 'validation',
  error_validation_value_not_supported: 'validation',
  error_validation_customer_location_restricted: 'refused',
  error_validation_password_reused: 'validation',
  error_validation_password_weak: 'validation',
  error_validation_mfa_medium_invalid: 'validation',
  error_validation_mfa_entity_required: 'validation',
  error_validation_date_range_month: 'validation',
  error_validation_date_range_order: 'validation',
  error_validation_payload_too_large: 'validation',
  error_validation_csv_file_structure: 'validation',
  error_validation_file_empty: 'validation',
  error_validation_file_format_array: 'validation',
  error_validation_file_no_rows: 'validation',
  // Entities
  error_entity_invite_resend_not_available: 'refused',
  error_entity_has_active_dependencies: 'refused',
  error_entity_invite_expired: 'refused',
  error_entity_invite_already_accepted: 'refused',
  error_entity_person_document_link_mismatch: 'validation',
  error_entity_user_has_no_access: 'auth',
  error_entity_user_already_has_access: 'refused',
  // "Entity requires additional verification": a review, not a refusal.
  error_entity_status_due_diligence_required: 'under_review',
  error_entity_status_not_incomplete: 'refused',
  // KYC
  error_kyc_identity_verification_failed: 'identity_refused',
  error_kyc_document_expired: 'identity_refused',
  error_kyc_document_quality_insufficient: 'identity_refused',
  error_kyc_document_type_not_accepted: 'identity_refused',
  error_kyc_documents_incomplete: 'identity_refused',
  error_kyc_application_rejected: 'identity_refused',
  // Under review (lead ruling 4): wait for Nuvion's decision, never "your
  // details failed".
  error_kyc_under_compliance_review: 'under_review',
  error_kyc_sanctions_check_failed: 'identity_refused',
  error_kyc_enhanced_due_diligence_required: 'under_review',
  // KYB (WAWU's own business entity)
  error_kyb_business_verification_failed: 'refused',
  error_kyb_tax_id_invalid: 'refused',
  error_kyb_incorporation_documents_missing: 'refused',
  error_kyb_beneficial_owners_missing: 'refused',
  error_kyb_business_type_not_supported: 'refused',
  error_kyb_application_rejected: 'refused',
  error_kyb_under_compliance_review: 'refused',
  // Accounts
  error_account_kyc_incomplete: 'refused',
  error_account_limit_reached: 'refused',
  error_account_type_unavailable: 'refused',
  error_account_already_exists: 'refused',
  error_account_already_verified: 'refused',
  error_account_access_blocked: 'wallet_inactive',
  error_account_status_prevents_action: 'wallet_inactive',
  error_account_balance_not_zero: 'refused',
  error_account_not_active: 'wallet_inactive',
  error_account_suspended: 'wallet_inactive',
  error_account_closed: 'wallet_inactive',
  // FX quotes
  error_fx_quote_unsupported_currency_pair: 'refused',
  error_fx_quote_rate_provider_unavailable: 'by_call',
  // Transfers
  error_transfer_insufficient_funds: 'insufficient_funds',
  error_transfer_daily_limit_exceeded: 'refused',
  error_transfer_transaction_limit_exceeded: 'refused',
  error_transfer_monthly_volume_exceeded: 'refused',
  error_transfer_account_not_active: 'wallet_inactive',
  error_transfer_counterparty_not_approved: 'refused',
  // "Same-day cutoff has passed; transfer will process next business day":
  // the transfer still goes, so it is never "nothing moved". Reconciled by
  // its unique_reference, never sent again (verifier defect 2).
  error_transfer_same_day_cutoff_passed: 'outcome_unknown',
  error_transfer_outside_business_hours: 'payouts_blocked',
  error_transfer_compliance_rejected: 'refused',
  error_transfer_recipient_flagged: 'refused',
  error_transfer_purpose_code_required: 'validation',
  error_transfer_beneficiary_name_too_long: 'validation',
  error_transfer_network_unavailable: 'by_call',
  // "Transfer is already being processed": the first request is still
  // running, so money may move. Never a refusal to act on.
  error_transfer_already_processing: 'outcome_unknown',
  error_transfer_recipient_account_closed: 'refused',
  // "Funds have been credited back": refused, nothing left the account.
  error_transfer_bank_returned: 'refused',
  // Counterparties
  error_counterparty_account_number_invalid: 'validation',
  error_counterparty_routing_number_invalid: 'validation',
  error_counterparty_iban_invalid: 'validation',
  error_counterparty_swift_code_invalid: 'validation',
  error_counterparty_already_exists: 'refused',
  error_counterparty_bank_details_missing: 'validation',
  error_counterparty_sanctions_check_failed: 'refused',
  error_counterparty_verification_failed: 'refused',
  // Stablecoin wallets
  error_wallet_generation_failed: 'refused',
  error_wallet_blockchain_not_supported: 'refused',
  error_wallet_already_exists: 'refused',
  error_wallet_account_not_ready: 'wallet_inactive',
  error_wallet_blockchain_unavailable: 'by_call',
  error_wallet_limit_reached: 'refused',
  // Account details resolution (the account name check)
  error_resolution_account_not_found: 'not_found',
  error_resolution_format_invalid: 'validation',
  error_resolution_bank_not_supported: 'refused',
  error_resolution_timeout: 'by_call',
  error_resolution_multiple_matches: 'refused',
  error_resolution_service_unavailable: 'by_call',
  // Card acquiring
  error_acquiring_encryption_keys_revoked: 'auth',
  error_acquiring_encryption_keys_expired: 'auth',
  error_acquiring_decryption_failed: 'validation',
  error_acquiring_payment_method_invalid: 'validation',
  error_acquiring_card_expired: 'refused',
  error_acquiring_test_token_invalid: 'validation',
  error_acquiring_payment_processing_failed: 'by_call',
  error_acquiring_payment_initialization_failed: 'by_call',
  error_acquiring_provider_response_invalid: 'by_call',
  error_acquiring_session_token_generation_failed: 'by_call',
  error_acquiring_payment_reference_invalid: 'validation',
  error_acquiring_3ds_challenge_failed: 'refused',
  error_acquiring_refund_amount_exceeds_charge: 'refused',
  error_acquiring_refund_duplicate_request: 'duplicate_reference',
  error_acquiring_refund_processing_failed: 'by_call',
  error_acquiring_payment_already_processed: 'duplicate_reference',
  error_acquiring_refund_status_invalid: 'refused',
  // Webhooks
  error_webhook_url_invalid: 'validation',
  error_webhook_delivery_failed: 'refused',
  error_webhook_signature_invalid: 'refused',
  // Resources & system
  error_resource_not_found: 'not_found',
  error_endpoint_not_found: 'by_call',
  error_duplicate_resource: 'duplicate_reference',
  error_resource_expired: 'refused',
  error_operation_invalid_for_state: 'refused',
  error_concurrent_modification_detected: 'by_call',
  error_idempotency_key_mismatch: 'duplicate_reference',
  error_idempotency_request_processing: 'outcome_unknown',
  error_system_internal_error: 'by_call',
  error_system_service_unavailable: 'by_call',
  error_system_timeout: 'by_call',
  error_system_dependency_unavailable: 'by_call',
  error_system_maintenance: 'by_call',
};

/** No answer, a 5xx, or a type that says Nuvion could not finish. */
function lostKind(call: NuvionCallKind): WalletProviderErrorKind {
  return call === 'write' ? 'outcome_unknown' : 'unavailable';
}

/**
 * The kind of a failed answer that carried no type we know: read from the
 * HTTP status alone. An answer without Nuvion's own error object (a gateway
 * page, an empty body) proves nothing about the request beyond a key or
 * rate refusal: on a write it is an unknown outcome, never a refusal to act
 * on, and a 404 like that is never `not_found`.
 */
export function kindForStatus(
  status: number,
  call: NuvionCallKind,
  nuvionBody: boolean,
): WalletProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return lostKind(call);
  if (status >= 200 && status < 300) {
    return call === 'write' ? 'not_confirmed' : 'bad_response';
  }
  if (!nuvionBody) return lostKind(call);
  if (status === 404) return 'not_found';
  if (status === 409)
    return call === 'write' ? 'duplicate_reference' : 'refused';
  if (status === 422 && call === 'check') return 'identity_refused';
  if (status === 400 || status === 422) return 'validation';
  return 'refused';
}

/**
 * The kind for a documented type, or null when Nuvion did not send one we
 * know (the status decides then).
 */
export function kindForType(
  type: string | null,
  call: NuvionCallKind,
): WalletProviderErrorKind | null {
  if (type === null) return null;
  const mapped = Object.prototype.hasOwnProperty.call(
    NUVION_ERROR_TYPE_KINDS,
    type,
  )
    ? NUVION_ERROR_TYPE_KINDS[type]
    : undefined;
  if (mapped === undefined) return null;
  if (mapped !== 'by_call') return mapped;
  // `error_endpoint_not_found` is the API saying the path is wrong: a bug
  // of ours, not a missing record. On a write nothing was created.
  if (type === 'error_endpoint_not_found') return 'refused';
  // A conflict from a concurrent change: the write did not apply, but a
  // read can simply be asked again.
  if (type === 'error_concurrent_modification_detected') {
    return call === 'write' ? 'refused' : 'unavailable';
  }
  return lostKind(call);
}

/**
 * A failed Nuvion call. A `WalletProviderError` (every service catches that
 * class and reads `kind`), plus what Nuvion support needs to trace it:
 * `requestId`, Nuvion's `X-Request-ID` (errors.md: "Every error response
 * includes an X-Request-ID header"), and Nuvion's own `type`. It carries no
 * body, no header and no key: `messages` are Nuvion's texts already masked.
 */
export class NuvionError extends WalletProviderError {
  /** Nuvion's X-Request-ID, or null when no answer came back. */
  readonly requestId: string | null;
  /** Nuvion's `error_*` type, or null when the answer carried none. */
  readonly nuvionType: string | null;

  constructor(args: {
    kind: WalletProviderErrorKind;
    operation: string;
    httpStatus?: number | null;
    messages?: string[];
    reference?: string | null;
    recordMayExist?: boolean;
    retryAfterSeconds?: number;
    requestId?: string | null;
    nuvionType?: string | null;
  }) {
    super({ ...args, provider: 'nuvion' });
    this.name = 'NuvionError';
    this.requestId = args.requestId ?? null;
    this.nuvionType = args.nuvionType ?? null;
    if (this.requestId) this.message += ` request ${this.requestId}`;
  }
}

/**
 * The types that say the record is there at Nuvion although the call
 * failed, so `recordMayExist` is true on them whatever their kind (the
 * seam's own definition; verifier defect 3 and lead ruling 4):
 * - "already exists" or "already verified" (409): a create that meets one
 *   after a lost answer or a double tap adopts what is there;
 * - "under review" (422): the application is with Nuvion's compliance
 *   team; it is never sent again while it is.
 */
export const NUVION_RECORD_EXISTS_TYPES: readonly string[] = [
  'error_account_already_exists',
  'error_account_already_verified',
  'error_counterparty_already_exists',
  'error_wallet_already_exists',
  'error_kyc_under_compliance_review',
  'error_kyc_enhanced_due_diligence_required',
  'error_entity_status_due_diligence_required',
];

/** True when a failure of this kind and type may have left a record. */
export function nuvionRecordMayExist(
  kind: WalletProviderErrorKind,
  type: string | null,
): boolean {
  return (
    WALLET_PROVIDER_UNKNOWN_OUTCOMES.includes(kind) ||
    (type !== null && NUVION_RECORD_EXISTS_TYPES.includes(type))
  );
}

/**
 * Nuvion's three limit refusals (errors.md, "Transfers"; no values are
 * published), taken from NUV-07's table so there is one list
 * (src/wallet-provider/wallet-provider-limit.ts). BACKEND_GAPS G-411.
 */
export const NUVION_LIMIT_ERROR_TYPES: readonly string[] = Object.keys(
  PROVIDER_LIMIT_ERROR_TYPES.nuvion,
);

/** What Nuvion support needs to trace a failed call. */
export interface NuvionTrace {
  /** Nuvion's X-Request-ID, or null when no answer came back. */
  readonly requestId: string | null;
  /** Nuvion's `error_*` type, or null when the answer carried none. */
  readonly nuvionType: string | null;
}

/**
 * The error a limit refusal becomes (G-411): NUV-07's
 * `providerLimitError('nuvion', type, ...)`, a `refused` with nothing
 * moved that answers `403 limit_reached`, with Nuvion's request id and type
 * kept on it. Null when `type` is not one of Nuvion's limit types, and for
 * any answer of 500 or above: a 5xx is never a refusal, whatever type it
 * carries (lead ruling 9), so the client maps it as an unknown outcome.
 */
export function nuvionLimitError(
  type: string | null,
  args: {
    operation: string;
    httpStatus?: number | null;
    messages?: string[];
    reference?: string | null;
    requestId?: string | null;
  },
): (WalletProviderLimitError & NuvionTrace) | null {
  const status = args.httpStatus ?? null;
  if (type === null || status === null || status >= 500) return null;
  const { requestId, ...limitArgs } = args;
  const limit = providerLimitError('nuvion', type, limitArgs);
  if (limit === null) return null;
  const trace: NuvionTrace = { requestId: requestId ?? null, nuvionType: type };
  const error = Object.assign(limit, trace);
  if (error.requestId) error.message += ` request ${error.requestId}`;
  return error;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Nuvion's error object (errors.md, "The error object"): `{ status: "error",
 * message, type, validations? }`. Null when the body is not one.
 */
export function readNuvionErrorBody(
  body: unknown,
): { type: string | null; messages: string[] } | null {
  if (!isRecord(body) || body.status !== 'error') return null;
  const type =
    typeof body.type === 'string' && /^error_[a-z0-9_]{1,120}$/.test(body.type)
      ? body.type
      : null;
  const messages: string[] = [];
  if (typeof body.message === 'string') messages.push(body.message);
  if (Array.isArray(body.validations)) {
    for (const v of body.validations) {
      if (!isRecord(v)) continue;
      for (const [field, detail] of Object.entries(v)) {
        if (isRecord(detail) && typeof detail.message === 'string') {
          messages.push(`${field.slice(0, 60)}: ${detail.message}`);
        }
      }
    }
  }
  return { type, messages };
}

/** Longest run of characters, from 8 up, that the text shares with a secret. */
function maskSecretRuns(text: string, secret: string): string {
  const MIN = 8;
  if (secret.length < MIN) {
    return secret.length > 0 ? text.split(secret).join('[secret]') : text;
  }
  let out = '';
  let i = 0;
  while (i < text.length) {
    let len = 0;
    const head = text.slice(i, i + MIN);
    if (head.length === MIN && secret.includes(head)) {
      len = MIN;
      while (
        i + len < text.length &&
        secret.includes(text.slice(i, i + len + 1))
      ) {
        len += 1;
      }
    }
    if (len >= MIN) {
      out += '[secret]';
      i += len;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/**
 * A number in a text, however it is written: a digit, then more digits
 * joined by up to 8 separators each time. A separator is any character that
 * is not a letter or a digit (spaces and tabs and newlines of every width,
 * punctuation, slashes, underscores, brackets, dashes of every kind,
 * zero-width and other format characters) or the letter x or X, which some
 * people write between groups ("2221x739x0137"; the receipts' number
 * reading takes the same). Run over text whose digits are already ASCII.
 */
const DIGIT_RUN = /\d(?:(?:[^\p{L}\d]|[xX]){0,8}\d)+/gu;

/** A run of 7 or more digits (every separator dropped) cut to its last 4. */
function maskDigitRun(run: string): string {
  const digits = run.replace(/\D/g, '');
  return digits.length < 7
    ? run
    : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Masks what could identify a person or open the account in a text Nuvion
 * sent, before it reaches an error, a log or a column: any run of 8 or more
 * characters of a given secret (the API key), any `Bearer` token, any run of
 * 40 or more base64 characters (a document or image echoed back), any run of
 * 7 or more digits down to their last 4 (a BVN, NIN, phone or account
 * number) after every separator is dropped from between them and every
 * Unicode decimal digit is read as 0 to 9 (NUV-02 round 3, N5: also with
 * slashes, commas, underscores, colons, brackets, any width of space, tabs,
 * newlines, zero-width characters, full-width and Arabic-Indic digits), and
 * an email down to its domain. Capped at 200 characters.
 */
export function maskNuvionText(text: string, secrets: string[] = []): string {
  let out = text.slice(0, 2000);
  for (const secret of secrets) out = maskSecretRuns(out, secret);
  return foldDigits(
    out
      .replace(/bearer\s+\S+/gi, '[credential]')
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[data]'),
  )
    .replace(DIGIT_RUN, maskDigitRun)
    .replace(/[^\s@"']+@([^\s@"']+)/g, '***@$1')
    .slice(0, 200);
}

/**
 * Classifies one failed answer: the documented type first, the status when
 * there is none. Messages are masked.
 */
export function classifyNuvionFailure(args: {
  httpStatus: number;
  body: unknown;
  call: NuvionCallKind;
  secrets?: string[];
}): {
  kind: WalletProviderErrorKind;
  type: string | null;
  messages: string[];
  recordMayExist: boolean;
} {
  const read = readNuvionErrorBody(args.body);
  const type = read?.type ?? null;
  const messages = (read?.messages ?? []).map((m) =>
    maskNuvionText(m, args.secrets),
  );
  const typed = kindForType(type, args.call);
  // A 5xx never counts as a refusal, whatever type it carries (lead ruling
  // 9): Nuvion could not finish, so a write may still have happened (an
  // unknown outcome, or the unknown-outcome kind its type names) and a read
  // or a check is simply asked again.
  const kind =
    args.httpStatus >= 500
      ? args.call === 'write' &&
        typed !== null &&
        WALLET_PROVIDER_UNKNOWN_OUTCOMES.includes(typed)
        ? typed
        : lostKind(args.call)
      : (typed ?? kindForStatus(args.httpStatus, args.call, read !== null));
  return {
    kind,
    type,
    messages,
    recordMayExist: nuvionRecordMayExist(kind, type),
  };
}
