import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import { NUVION_DOCUMENTED_ERRORS } from '../../../test/nuvion/nuvion-errors';
import {
  envelope,
  errorBody,
  NuvionStandin,
} from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { MoneyError } from '../../money/money-error';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { WalletProviderLimitError } from '../../wallet-provider/wallet-provider-limit';
import { NuvionClient, type NuvionOp, unsafeSegment } from '../nuvion-client';
import { NUVION_API_VERSION } from '../nuvion-config';
import {
  NUVION_ERROR_TYPE_KINDS,
  NUVION_LIMIT_ERROR_TYPES,
  NuvionError,
  type NuvionTrace,
} from '../nuvion-error';

/**
 * NUV-01, the Nuvion client against the stand-in (test/nuvion/), over a
 * real socket. No Nuvion host is reached: every connection but loopback is
 * refused and recorded (outbound-guard.ts), and the last test checks none
 * was tried.
 *
 * Capability checks proved here:
 * - every request carries `Authorization: Bearer`, `Content-Type:
 *   application/json` and the pinned `X-API-Version`; a list follows
 *   `next_cursor` until `has_next` is false;
 * - each error `type` on Nuvion's errors page (all 153), plus 401, 429, 5xx,
 *   a timeout, a lost answer and an unreadable body, becomes one
 *   `WalletProviderError` kind with Nuvion's X-Request-ID kept (the table
 *   below lists every one);
 * - no spec reaches a host other than the stand-in.
 * The (key) check, `GET /bank-codes/NG` against the sandbox, is not here:
 * it runs as scripts/nuvion/bank-codes-check.ts once a lead brief allows
 * api.nuvion.dev and the sandbox key answers.
 */

const KEY = 'nv_test_sk_NUV01standinKEY0123456789abcdef';
const READ: NuvionOp = { name: 'read thing', call: 'read' };
const WRITE: NuvionOp = { name: 'make thing', call: 'write' };

/**
 * Every documented type, its documented status, and the kind a WRITE
 * (a POST that may move money) answers with. Derived by group from what
 * each type means (errors.md), not from the client's own map:
 * - a 5xx-class type, or one that says the first request is still running,
 *   is `outcome_unknown` (money may move: reconcile, never retry blindly);
 * - a reference or idempotency key already used is `duplicate_reference`;
 * - credentials, permissions and versions are `auth`; 429 `rate_limited`;
 * - field and format refusals `validation`; KYC refusals `identity_refused`;
 * - an application under review (compliance review, due diligence)
 *   `under_review`: wait, never "your details failed" (lead ruling 4);
 * - a frozen, closed or inactive account `wallet_inactive`;
 * - not enough money `insufficient_funds`; a missing record `not_found`;
 * - a business-hours refusal `payouts_blocked`; the same-day cutoff, after
 *   which the transfer still goes next business day, `outcome_unknown`
 *   (verifier defect 2);
 * - anything else that says no: `refused`.
 */
const TABLE: ReadonlyArray<[string, number, string]> = [
  ['error_auth_credentials_invalid', 401, 'auth'],
  ['error_auth_credentials_revoked', 401, 'auth'],
  ['error_auth_permission_denied', 403, 'auth'],
  ['error_auth_elevated_permission_required', 403, 'auth'],
  ['error_auth_rate_limit_exceeded', 429, 'rate_limited'],
  ['error_auth_api_version_locked', 403, 'auth'],
  ['error_auth_api_version_not_supported', 400, 'auth'],
  ['error_auth_api_version_not_available', 403, 'auth'],
  ['error_auth_api_version_deprecated', 410, 'auth'],
  ['error_auth_api_version_access_denied', 403, 'auth'],
  ['error_auth_verification_token_not_found', 404, 'refused'],
  ['error_auth_verification_token_expired', 410, 'refused'],
  ['error_auth_verification_token_already_used', 409, 'refused'],
  ['error_auth_verification_token_invalid', 401, 'refused'],
  ['error_auth_email_verification_required', 403, 'refused'],
  ['error_auth_mfa_already_enrolled', 409, 'refused'],
  ['error_auth_mfa_enrollment_not_found', 404, 'refused'],
  ['error_auth_mfa_enrollment_already_completed', 409, 'refused'],
  ['error_auth_mfa_enrollment_inactive', 400, 'refused'],
  ['error_auth_mfa_permission_denied', 403, 'refused'],
  ['error_auth_mfa_code_invalid', 401, 'refused'],
  ['error_auth_mfa_verification_in_progress', 409, 'refused'],
  ['error_auth_mfa_verification_not_in_progress', 400, 'refused'],
  ['error_auth_mfa_not_enrolled', 400, 'refused'],
  ['error_validation_error', 422, 'validation'],
  ['error_validation_required_field_missing', 400, 'validation'],
  ['error_validation_invalid_format', 400, 'validation'],
  ['error_validation_email_invalid', 422, 'validation'],
  ['error_validation_phone_invalid', 422, 'validation'],
  ['error_validation_date_invalid', 422, 'validation'],
  ['error_validation_amount_invalid', 422, 'validation'],
  ['error_validation_value_out_of_range', 400, 'validation'],
  ['error_validation_invalid_id', 400, 'validation'],
  ['error_validation_value_not_supported', 422, 'validation'],
  ['error_validation_customer_location_restricted', 422, 'refused'],
  ['error_validation_password_reused', 422, 'validation'],
  ['error_validation_password_weak', 422, 'validation'],
  ['error_validation_mfa_medium_invalid', 400, 'validation'],
  ['error_validation_mfa_entity_required', 400, 'validation'],
  ['error_validation_date_range_month', 400, 'validation'],
  ['error_validation_date_range_order', 400, 'validation'],
  ['error_validation_payload_too_large', 400, 'validation'],
  ['error_validation_csv_file_structure', 400, 'validation'],
  ['error_validation_file_empty', 400, 'validation'],
  ['error_validation_file_format_array', 400, 'validation'],
  ['error_validation_file_no_rows', 400, 'validation'],
  ['error_entity_invite_resend_not_available', 410, 'refused'],
  ['error_entity_has_active_dependencies', 400, 'refused'],
  ['error_entity_invite_expired', 410, 'refused'],
  ['error_entity_invite_already_accepted', 409, 'refused'],
  ['error_entity_person_document_link_mismatch', 422, 'validation'],
  ['error_entity_user_has_no_access', 403, 'auth'],
  ['error_entity_user_already_has_access', 409, 'refused'],
  ['error_entity_status_due_diligence_required', 422, 'under_review'],
  ['error_entity_status_not_incomplete', 400, 'refused'],
  ['error_kyc_identity_verification_failed', 422, 'identity_refused'],
  ['error_kyc_document_expired', 422, 'identity_refused'],
  ['error_kyc_document_quality_insufficient', 422, 'identity_refused'],
  ['error_kyc_document_type_not_accepted', 422, 'identity_refused'],
  ['error_kyc_documents_incomplete', 422, 'identity_refused'],
  ['error_kyc_application_rejected', 422, 'identity_refused'],
  ['error_kyc_under_compliance_review', 422, 'under_review'],
  ['error_kyc_sanctions_check_failed', 422, 'identity_refused'],
  ['error_kyc_enhanced_due_diligence_required', 422, 'under_review'],
  ['error_kyb_business_verification_failed', 422, 'refused'],
  ['error_kyb_tax_id_invalid', 422, 'refused'],
  ['error_kyb_incorporation_documents_missing', 422, 'refused'],
  ['error_kyb_beneficial_owners_missing', 422, 'refused'],
  ['error_kyb_business_type_not_supported', 422, 'refused'],
  ['error_kyb_application_rejected', 422, 'refused'],
  ['error_kyb_under_compliance_review', 422, 'refused'],
  ['error_account_kyc_incomplete', 400, 'refused'],
  ['error_account_limit_reached', 400, 'refused'],
  ['error_account_type_unavailable', 422, 'refused'],
  ['error_account_already_exists', 409, 'refused'],
  ['error_account_already_verified', 409, 'refused'],
  ['error_account_access_blocked', 403, 'wallet_inactive'],
  ['error_account_status_prevents_action', 400, 'wallet_inactive'],
  ['error_account_balance_not_zero', 400, 'refused'],
  ['error_account_not_active', 400, 'wallet_inactive'],
  ['error_account_suspended', 403, 'wallet_inactive'],
  ['error_account_closed', 400, 'wallet_inactive'],
  ['error_fx_quote_unsupported_currency_pair', 422, 'refused'],
  ['error_fx_quote_rate_provider_unavailable', 503, 'outcome_unknown'],
  ['error_transfer_insufficient_funds', 400, 'insufficient_funds'],
  ['error_transfer_daily_limit_exceeded', 400, 'refused'],
  ['error_transfer_transaction_limit_exceeded', 400, 'refused'],
  ['error_transfer_monthly_volume_exceeded', 400, 'refused'],
  ['error_transfer_account_not_active', 400, 'wallet_inactive'],
  ['error_transfer_counterparty_not_approved', 400, 'refused'],
  ['error_transfer_same_day_cutoff_passed', 400, 'outcome_unknown'],
  ['error_transfer_outside_business_hours', 400, 'payouts_blocked'],
  ['error_transfer_compliance_rejected', 422, 'refused'],
  ['error_transfer_recipient_flagged', 403, 'refused'],
  ['error_transfer_purpose_code_required', 422, 'validation'],
  ['error_transfer_beneficiary_name_too_long', 422, 'validation'],
  ['error_transfer_network_unavailable', 503, 'outcome_unknown'],
  ['error_transfer_already_processing', 409, 'outcome_unknown'],
  ['error_transfer_recipient_account_closed', 400, 'refused'],
  ['error_transfer_bank_returned', 400, 'refused'],
  ['error_counterparty_account_number_invalid', 400, 'validation'],
  ['error_counterparty_routing_number_invalid', 422, 'validation'],
  ['error_counterparty_iban_invalid', 422, 'validation'],
  ['error_counterparty_swift_code_invalid', 422, 'validation'],
  ['error_counterparty_already_exists', 409, 'refused'],
  ['error_counterparty_bank_details_missing', 422, 'validation'],
  ['error_counterparty_sanctions_check_failed', 422, 'refused'],
  ['error_counterparty_verification_failed', 422, 'refused'],
  ['error_wallet_generation_failed', 400, 'refused'],
  ['error_wallet_blockchain_not_supported', 400, 'refused'],
  ['error_wallet_already_exists', 409, 'refused'],
  ['error_wallet_account_not_ready', 400, 'wallet_inactive'],
  ['error_wallet_blockchain_unavailable', 503, 'outcome_unknown'],
  ['error_wallet_limit_reached', 400, 'refused'],
  ['error_resolution_account_not_found', 404, 'not_found'],
  ['error_resolution_format_invalid', 422, 'validation'],
  ['error_resolution_bank_not_supported', 422, 'refused'],
  ['error_resolution_timeout', 504, 'outcome_unknown'],
  ['error_resolution_multiple_matches', 400, 'refused'],
  ['error_resolution_service_unavailable', 503, 'outcome_unknown'],
  ['error_acquiring_encryption_keys_revoked', 403, 'auth'],
  ['error_acquiring_encryption_keys_expired', 403, 'auth'],
  ['error_acquiring_decryption_failed', 400, 'validation'],
  ['error_acquiring_payment_method_invalid', 422, 'validation'],
  ['error_acquiring_card_expired', 422, 'refused'],
  ['error_acquiring_test_token_invalid', 422, 'validation'],
  ['error_acquiring_payment_processing_failed', 503, 'outcome_unknown'],
  ['error_acquiring_payment_initialization_failed', 503, 'outcome_unknown'],
  ['error_acquiring_provider_response_invalid', 503, 'outcome_unknown'],
  ['error_acquiring_session_token_generation_failed', 503, 'outcome_unknown'],
  ['error_acquiring_payment_reference_invalid', 400, 'validation'],
  ['error_acquiring_3ds_challenge_failed', 422, 'refused'],
  ['error_acquiring_refund_amount_exceeds_charge', 400, 'refused'],
  ['error_acquiring_refund_duplicate_request', 409, 'duplicate_reference'],
  ['error_acquiring_refund_processing_failed', 503, 'outcome_unknown'],
  ['error_acquiring_payment_already_processed', 409, 'duplicate_reference'],
  ['error_acquiring_refund_status_invalid', 400, 'refused'],
  ['error_webhook_url_invalid', 400, 'validation'],
  ['error_webhook_delivery_failed', 422, 'refused'],
  ['error_webhook_signature_invalid', 401, 'refused'],
  ['error_resource_not_found', 404, 'not_found'],
  ['error_endpoint_not_found', 404, 'refused'],
  ['error_duplicate_resource', 409, 'duplicate_reference'],
  ['error_resource_expired', 410, 'refused'],
  ['error_operation_invalid_for_state', 400, 'refused'],
  ['error_concurrent_modification_detected', 409, 'refused'],
  ['error_idempotency_key_mismatch', 409, 'duplicate_reference'],
  ['error_idempotency_request_processing', 409, 'outcome_unknown'],
  ['error_system_internal_error', 500, 'outcome_unknown'],
  ['error_system_service_unavailable', 503, 'outcome_unknown'],
  ['error_system_timeout', 504, 'outcome_unknown'],
  ['error_system_dependency_unavailable', 503, 'outcome_unknown'],
  ['error_system_maintenance', 503, 'outcome_unknown'],
];

/**
 * The types whose words say the record is there at Nuvion (errors.md): a
 * record may exist although the call failed, whatever the kind (verifier
 * defect 3, lead ruling 4). Written out here, not read from the client.
 */
const SAYS_THE_RECORD_IS_THERE = [
  'error_account_already_exists',
  'error_account_already_verified',
  'error_counterparty_already_exists',
  'error_wallet_already_exists',
  'error_kyc_under_compliance_review',
  'error_kyc_enhanced_due_diligence_required',
  'error_entity_status_due_diligence_required',
];

describe('NUV-01: the Nuvion client against the stand-in', () => {
  const standin = new NuvionStandin();
  let guard: OutboundGuard;
  let client: NuvionClient;
  const logged: string[] = [];

  beforeAll(async () => {
    guard = guardOutbound();
    await standin.start();
    client = new NuvionClient(standin.settings(), KEY);
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args.map((a) => String(a)).join(' '));
        });
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await standin.stop();
    guard.restore();
  });
  beforeEach(() => standin.reset());

  async function failure(p: Promise<unknown>): Promise<NuvionError> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(NuvionError);
      expect(e).toBeInstanceOf(WalletProviderError);
      return e as NuvionError;
    }
    throw new Error('the call did not fail');
  }

  describe('every request carries the bearer key, JSON and the pinned version', () => {
    it.each([
      ['GET', () => client.get(READ, '/bank-codes/NG')],
      [
        'POST',
        () =>
          client.post(WRITE, '/transfers', {
            amount: 100,
            unique_reference: 'nuv01-ref-1',
          }),
      ],
      [
        'PATCH',
        () =>
          client
            .patch(WRITE, '/accounts/01HXYZACC0000000000000001', {})
            .catch(() => null),
      ],
      ['a list page', () => client.listPage(READ, '/accounts', { limit: 2 })],
    ])('%s', async (_name, call) => {
      await call();
      expect(standin.seen).toHaveLength(1);
      const h = standin.seen[0].headers;
      expect(h.authorization).toBe(`Bearer ${KEY}`);
      expect(h['content-type']).toBe('application/json');
      expect(h['x-api-version']).toBe(NUVION_API_VERSION);
      expect(NUVION_API_VERSION).toBe('2026-02-06');
    });

    it('reads the envelope: a 2xx answers `data`, and Nuvion request id', async () => {
      const banks = await client.get<Array<{ bank_code: string }>>(
        READ,
        '/bank-codes/NG',
      );
      expect(banks.httpStatus).toBe(200);
      expect(banks.data.map((b) => b.bank_code)).toEqual([
        '120001',
        '090270',
        '090260',
      ]);
      expect(banks.requestId).toMatch(/^01REQ/);
      const sent = await client.post<{
        status: string;
        unique_reference: string;
      }>(WRITE, '/transfers', {
        amount: 500,
        currency: 'NGN',
        unique_reference: 'nuv01-ref-2',
      });
      expect(sent.data).toMatchObject({
        status: 'pending',
        unique_reference: 'nuv01-ref-2',
      });
      expect(standin.seen[1].body).toEqual({
        amount: 500,
        currency: 'NGN',
        unique_reference: 'nuv01-ref-2',
      });
    });
  });

  describe('a list follows next_cursor until has_next is false', () => {
    it('seven accounts, three a page: three requests, every row once, in order', async () => {
      const all = await client.listAll<{ id: string }>(READ, '/accounts', {
        limit: 3,
        entity_id: '01HXYZ2345ABCDEFGHJKMNPQRS',
      });
      expect(all.complete).toBe(true);
      expect(all.pages).toBe(3);
      expect(all.items.map((a) => a.id)).toEqual(
        standin.accounts.map((a) => a.id),
      );
      expect(standin.seen.map((r) => r.query.cursor ?? null)).toEqual([
        null,
        standin.accounts[2].id,
        standin.accounts[5].id,
      ]);
      expect(standin.seen.every((r) => r.query.limit === '3')).toBe(true);
      expect(
        standin.seen.every(
          (r) => r.query.entity_id === '01HXYZ2345ABCDEFGHJKMNPQRS',
        ),
      ).toBe(true);
    });

    it('stops at maxPages and says the list is not complete', async () => {
      const cut = await client.listAll(
        READ,
        '/accounts',
        { limit: 2 },
        { maxPages: 2 },
      );
      expect(cut).toMatchObject({ complete: false, pages: 2 });
      expect(cut.items).toHaveLength(4);
      expect(standin.seen).toHaveLength(2);
    });

    it('a page that says more follow but gives no cursor, or the same one, is unreadable, never a loop', async () => {
      const page = (cursor: string | null) => ({
        status: 200,
        body: envelope({
          data: [{ id: 'x' }],
          meta: {
            pagination: {
              order: 'asc',
              has_next: true,
              limit: 1,
              has_previous: false,
              next_cursor: cursor,
              previous_cursor: null,
            },
          },
        }),
      });
      standin.next(page(null));
      const e1 = await failure(client.listAll(READ, '/accounts'));
      expect(e1.kind).toBe('bad_response');
      standin.reset();
      standin.next(page('C1')).next(page('C1'));
      const e2 = await failure(client.listAll(READ, '/accounts'));
      expect(e2.kind).toBe('bad_response');
      expect(standin.seen).toHaveLength(2);
      // A loop through another page (A, B, A) is caught by the cursors
      // already followed, before the third request.
      standin.reset();
      standin.next(page('A')).next(page('B')).next(page('A'));
      const e3 = await failure(client.listAll(READ, '/accounts'));
      expect(e3.kind).toBe('bad_response');
      expect(standin.seen.map((r) => r.query.cursor ?? null)).toEqual([
        null,
        'A',
        'B',
      ]);
    });

    it('limit runs 1 to 100: 100 is sent as it is, 0 and 101 are refused before sending', async () => {
      await client.listPage(READ, '/accounts', { limit: 100 });
      expect(standin.seen.map((r) => r.query.limit)).toEqual(['100']);
      for (const limit of [0, 101, 2.5]) {
        await expect(
          client.listPage(READ, '/accounts', { limit }),
        ).rejects.toThrow(RangeError);
      }
      expect(standin.seen).toHaveLength(1);
    });

    it('a 2xx that is not a list page is bad_response', async () => {
      standin.next({ status: 200, body: envelope({ items: [] }) });
      expect((await failure(client.listPage(READ, '/accounts'))).kind).toBe(
        'bad_response',
      );
    });
  });

  describe('each documented error type is one kind, with Nuvion request id kept', () => {
    it('the table covers exactly the types the client maps (153, every group on errors.md)', () => {
      expect(TABLE).toHaveLength(153);
      expect(TABLE.map(([t]) => t).sort()).toEqual(
        NUVION_DOCUMENTED_ERRORS.map(([t]) => t).sort(),
      );
      expect(Object.keys(NUVION_ERROR_TYPE_KINDS).sort()).toEqual(
        TABLE.map(([t]) => t).sort(),
      );
      for (const [t, status] of TABLE) {
        expect(NUVION_DOCUMENTED_ERRORS.find(([d]) => d === t)?.[1]).toBe(
          status,
        );
      }
    });

    // The three limit refusals have their own mapping point (G-411, NUV-07):
    // checked below, not in this table.
    const isLimit = (t: string) => NUVION_LIMIT_ERROR_TYPES.includes(t);

    it.each(TABLE.filter(([t]) => !isLimit(t)))(
      '%s (HTTP %i) on a write is %s',
      async (type, status, kind) => {
        standin.failNext(type, `Refused: ${type}`);
        const e = await failure(
          client.post(
            WRITE,
            '/transfers',
            { unique_reference: 'nuv01-t' },
            { reference: 'nuv01-t' },
          ),
        );
        expect(e.kind).toBe(kind);
        expect(e.httpStatus).toBe(status);
        expect(e.nuvionType).toBe(type);
        expect(e.requestId).toMatch(/^01REQ[0-9A-F]+$/);
        expect(e.message).toContain(`request ${e.requestId}`);
        expect(e.reference).toBe('nuv01-t');
        expect(e.provider).toBe('nuvion');
        // Money may have moved, or a record exists, exactly when the kind
        // or the type's own words say so.
        expect(e.recordMayExist).toBe(
          ['outcome_unknown', 'not_confirmed', 'duplicate_reference'].includes(
            kind,
          ) || SAYS_THE_RECORD_IS_THERE.includes(type),
        );
      },
    );

    it.each([
      ['error_transfer_transaction_limit_exceeded', 'per_transaction'],
      ['error_transfer_daily_limit_exceeded', 'daily'],
      ['error_transfer_monthly_volume_exceeded', 'monthly'],
    ])(
      '%s, a limit below 500, is NUV-07 limit refusal (G-411): 403 limit_reached %s, nothing moved, Nuvion request id kept',
      async (type, limit) => {
        expect(NUVION_LIMIT_ERROR_TYPES).toHaveLength(3);
        const status = TABLE.find(([t]) => t === type)![1];
        expect(status).toBeLessThan(500);
        standin.failNext(type, `Refused: ${type}`);
        let e: unknown = null;
        try {
          await client.post(WRITE, '/transfers', {}, { reference: 'nuv01-l' });
        } catch (err) {
          e = err;
        }
        expect(e).toBeInstanceOf(WalletProviderLimitError);
        expect(e).toBeInstanceOf(WalletProviderError);
        const l = e as WalletProviderLimitError & NuvionTrace;
        expect(l).toMatchObject({
          kind: 'refused',
          limit,
          httpStatus: status,
          provider: 'nuvion',
          reference: 'nuv01-l',
          recordMayExist: false,
          nuvionType: type,
        });
        expect(l.requestId).toMatch(/^01REQ[0-9A-F]+$/);
        expect(l.message).toContain(`request ${l.requestId}`);
        const http = l.toHttpException();
        expect(http).toBeInstanceOf(MoneyError);
        expect(http.getStatus()).toBe(403);
        expect(http.getResponse()).toMatchObject({
          reason: { code: 'limit_reached', limit },
        });
      },
    );

    it.each(NUVION_LIMIT_ERROR_TYPES.map((t) => [t]))(
      '%s carried by a 5xx is never a limit refusal: outcome_unknown on a write, unavailable on a read (lead ruling 9)',
      async (type) => {
        for (const status of [500, 503]) {
          standin.statusNext(status, errorBody(type));
          const w = await failure(
            client.post(WRITE, '/transfers', {}, { reference: 'nuv01-l5' }),
          );
          expect(w).not.toBeInstanceOf(WalletProviderLimitError);
          expect(w).toMatchObject({
            kind: 'outcome_unknown',
            recordMayExist: true,
            httpStatus: status,
            nuvionType: type,
          });
          expect(w.requestId).toMatch(/^01REQ[0-9A-F]+$/);
          standin.statusNext(status, errorBody(type));
          const r = await failure(client.get(READ, '/bank-codes/NG'));
          expect(r).not.toBeInstanceOf(WalletProviderLimitError);
          expect(r.kind).toBe('unavailable');
        }
      },
    );

    it.each([
      'error_transfer_insufficient_funds',
      'error_transfer_compliance_rejected',
      'error_validation_amount_invalid',
      'error_account_suspended',
      'error_resource_not_found',
      'error_transfer_outside_business_hours',
    ])(
      'a write answered 500 or 503 carrying %s is never a refusal: outcome_unknown, money may have moved',
      async (type) => {
        for (const status of [500, 503]) {
          standin.statusNext(status, errorBody(type));
          const w = await failure(
            client.post(WRITE, '/transfers', {}, { reference: 'nuv01-r5' }),
          );
          expect([w.kind, w.recordMayExist, w.nuvionType]).toEqual([
            'outcome_unknown',
            true,
            type,
          ]);
        }
      },
    );

    it('the same-day cutoff is a transfer that still goes: never answered as "nothing moved" (defect 2)', async () => {
      standin.failNext('error_transfer_same_day_cutoff_passed');
      const e = await failure(
        client.post(WRITE, '/transfers', {}, { reference: 'nuv01-cut' }),
      );
      expect([e.kind, e.recordMayExist, e.httpStatus]).toEqual([
        'outcome_unknown',
        true,
        400,
      ]);
      expect(e.toHttpException().getResponse()).toMatchObject({
        reason: {
          code: 'provider_unreachable',
          message:
            'We are still confirming this payment. Check your history before you try again.',
        },
      });
    });

    it.each([
      'error_account_already_exists',
      'error_account_already_verified',
      'error_counterparty_already_exists',
      'error_wallet_already_exists',
    ])(
      '%s (409) says the record is there: recordMayExist, on a write and a read (defect 3)',
      async (type) => {
        standin.failNext(type);
        const w = await failure(client.post(WRITE, '/accounts', {}));
        expect([w.kind, w.recordMayExist, w.httpStatus]).toEqual([
          'refused',
          true,
          409,
        ]);
        standin.failNext(type);
        const r = await failure(client.get(READ, '/accounts'));
        expect(r.recordMayExist).toBe(true);
      },
    );

    it.each([
      'error_kyc_under_compliance_review',
      'error_kyc_enhanced_due_diligence_required',
      'error_entity_status_due_diligence_required',
    ])(
      '%s is under_review, never identity_refused: the app hears "being reviewed" (ruling 4)',
      async (type) => {
        const CHECK: NuvionOp = { name: 'check person', call: 'check' };
        standin.failNext(type);
        const e = await failure(client.post(CHECK, '/entities', {}));
        expect([e.kind, e.recordMayExist, e.httpStatus]).toEqual([
          'under_review',
          true,
          422,
        ]);
        const http = e.toHttpException();
        expect(http.getStatus()).toBe(409);
        expect(http.message).toBe(
          'Your details are being reviewed. We will let you know when the review is done.',
        );
      },
    );

    it.each(TABLE.filter(([, status]) => status >= 500))(
      '%s (HTTP %i) on a read is unavailable: safe to ask again, nothing moved',
      async (type) => {
        standin.failNext(type);
        const e = await failure(client.get(READ, '/bank-codes/NG'));
        expect(e.kind).toBe('unavailable');
        expect(e.recordMayExist).toBe(false);
      },
    );
  });

  describe('401, 429, 5xx, a timeout, a lost answer and an unreadable body', () => {
    it('401 with Nuvion own body (a wrong or expired key) is auth, never not_found', async () => {
      standin.next({
        status: 401,
        body: errorBody(
          'error_auth_credentials_invalid',
          'Your credentials are invalid or have expired. Please check your credentials and try again',
        ),
      });
      const e = await failure(client.get(READ, '/bank-codes/NG'));
      expect([e.kind, e.httpStatus, e.nuvionType]).toEqual([
        'auth',
        401,
        'error_auth_credentials_invalid',
      ]);
    });

    it('429 is rate_limited, with Nuvion Retry-After as the wait', async () => {
      standin.rateLimitNext(7);
      const e = await failure(client.get(READ, '/bank-codes/NG'));
      expect([e.kind, e.httpStatus, e.retryAfterSeconds]).toEqual([
        'rate_limited',
        429,
        7,
      ]);
      standin.next({ status: 429, body: '' });
      const e2 = await failure(client.get(READ, '/bank-codes/NG'));
      expect([e2.kind, e2.retryAfterSeconds]).toEqual(['rate_limited', 30]);
    });

    it.each([
      [500, null],
      [502, '<html>bad gateway</html>'],
      [503, errorBody('error_system_service_unavailable')],
      [504, ''],
    ])(
      'HTTP %i: a write is outcome_unknown (reconcile), a read unavailable',
      async (status, body) => {
        standin.statusNext(
          status,
          body ?? undefined,
          typeof body === 'string' ? 'text/html' : undefined,
        );
        const w = await failure(
          client.post(WRITE, '/transfers', {}, { reference: 'nuv01-5xx' }),
        );
        expect([w.kind, w.recordMayExist, w.reference]).toEqual([
          'outcome_unknown',
          true,
          'nuv01-5xx',
        ]);
        standin.statusNext(
          status,
          body ?? undefined,
          typeof body === 'string' ? 'text/html' : undefined,
        );
        const r = await failure(client.get(READ, '/bank-codes/NG'));
        expect([r.kind, r.recordMayExist]).toEqual(['unavailable', false]);
      },
    );

    it('a timeout before the headers: outcome_unknown on a write, unavailable on a read, never waited past the deadline', async () => {
      standin.slowNext(4_000);
      const t0 = Date.now();
      const w = await failure(
        client.post(WRITE, '/transfers', {}, { reference: 'nuv01-slow' }),
      );
      expect(Date.now() - t0).toBeLessThan(3_500);
      expect([w.kind, w.httpStatus, w.recordMayExist]).toEqual([
        'outcome_unknown',
        null,
        true,
      ]);
      expect(w.messages).toEqual(['timed out']);
      standin.slowNext(4_000);
      expect((await failure(client.get(READ, '/bank-codes/NG'))).kind).toBe(
        'unavailable',
      );
    });

    it('a body that stalls after the headers is the same timeout, never a part-read answer', async () => {
      standin.stallBodyNext(4_000);
      const w = await failure(client.post(WRITE, '/transfers', {}));
      expect([w.kind, w.messages]).toEqual(['outcome_unknown', ['timed out']]);
    });

    it('a lost answer (the connection closed with no reply): outcome_unknown on a write, unavailable on a read', async () => {
      standin.loseNext();
      const w = await failure(client.post(WRITE, '/transfers', {}));
      expect([w.kind, w.recordMayExist, w.messages]).toEqual([
        'outcome_unknown',
        true,
        ['no connection'],
      ]);
      standin.loseNext();
      expect((await failure(client.get(READ, '/bank-codes/NG'))).kind).toBe(
        'unavailable',
      );
    });

    it('an unreadable 2xx body: not_confirmed on a write (it may have happened), bad_response on a read', async () => {
      standin.garbleNext();
      const w = await failure(client.post(WRITE, '/transfers', {}));
      expect([w.kind, w.recordMayExist]).toEqual(['not_confirmed', true]);
      standin.garbleNext();
      expect((await failure(client.get(READ, '/bank-codes/NG'))).kind).toBe(
        'bad_response',
      );
      // JSON, but not Nuvion success envelope.
      standin.next({ status: 200, body: { ok: true } });
      expect((await failure(client.get(READ, '/bank-codes/NG'))).kind).toBe(
        'bad_response',
      );
    });

    it('a 4xx without Nuvion error object (a gateway page) proves nothing: unknown on a write, unavailable on a read', async () => {
      standin.statusNext(400, '<html>bad request</html>', 'text/html');
      expect((await failure(client.post(WRITE, '/transfers', {}))).kind).toBe(
        'outcome_unknown',
      );
      standin.statusNext(404, '', 'text/plain');
      expect((await failure(client.get(READ, '/accounts/01X'))).kind).toBe(
        'unavailable',
      );
      // Nuvion own 404 is not_found.
      expect(
        (await failure(client.get(READ, '/accounts/01HXYZNOSUCHACCOUNT00000')))
          .kind,
      ).toBe('not_found');
    });

    it('a type Nuvion adds later falls back on the HTTP status', async () => {
      standin.next({
        status: 400,
        body: errorBody('error_transfer_something_new'),
      });
      const e = await failure(client.post(WRITE, '/transfers', {}));
      expect([e.kind, e.nuvionType]).toEqual([
        'validation',
        'error_transfer_something_new',
      ]);
    });

    it('field-level validation messages are kept, masked', async () => {
      standin.next({
        status: 422,
        body: {
          status: 'error',
          message: 'Validation failed for one or more fields',
          type: 'error_validation_error',
          validations: [
            {
              limit: {
                type: 'error_validation_value_out_of_range',
                message: "The value for 'limit' should be between 1 and 100.",
              },
            },
          ],
        },
      });
      const e = await failure(client.get(READ, '/accounts'));
      expect(e.kind).toBe('validation');
      expect(e.messages).toContain(
        "limit: The value for 'limit' should be between 1 and 100.",
      );
    });
  });

  describe('the key and personal data never leave in an error, a log or inspect', () => {
    it('masks the key, a BVN-length number and an email in Nuvion texts; inspect and JSON show no key', async () => {
      standin.next({
        status: 422,
        body: errorBody(
          'error_kyc_identity_verification_failed',
          `BVN 55512398704 for ada@example.com did not verify (key ${KEY})`,
        ),
      });
      const e = await failure(
        client.post(
          { name: 'check', call: 'check' },
          '/onboarding-submissions',
          {},
        ),
      );
      expect(e.kind).toBe('identity_refused');
      const text = `${e.message} ${e.messages.join(' ')} ${inspect(e)}`;
      expect(text).not.toContain('55512398704');
      expect(text).not.toContain('ada@example.com');
      expect(text).not.toContain(KEY.slice(8, 24));
      expect(text).toContain('*******8704');
      expect(inspect(client)).toBe("NuvionClient { environment: 'standin' }");
      expect(JSON.stringify(client)).toBe('{"environment":"standin"}');
      expect(logged.join('\n')).not.toContain(KEY.slice(0, 12));
      expect(logged.join('\n')).not.toContain('55512398704');
    });

    it('no key: nothing is sent (not_configured)', async () => {
      const bare = new NuvionClient(standin.settings(), '  ');
      const e = await failure(bare.get(READ, '/bank-codes/NG'));
      expect(e.kind).toBe('not_configured');
      expect(standin.seen).toHaveLength(0);
    });

    it('a path that is not a plain absolute path is refused before anything is sent', async () => {
      for (const p of ['bank-codes', '/a/../b', '//x', '/a?b=1', '/a#b']) {
        await expect(client.get(READ, p)).rejects.toThrow(RangeError);
      }
      expect(standin.seen).toHaveLength(0);
    });

    it('encoded traversal is refused too: %2e%2e in any case, mixed, double-encoded, an encoded slash (ruling 7)', async () => {
      for (const p of [
        '/accounts/%2e%2e/admin',
        '/accounts/%2E%2E/admin',
        '/accounts/%2e%2E/admin',
        '/accounts/.%2e/admin',
        '/accounts/%2e./admin',
        '/accounts/%2e',
        '/accounts/%252e%252e/admin',
        '/accounts/%25252E%25252e/admin',
        '/accounts/%2f..%2fadmin',
        '/accounts/x%2Fy',
        '/accounts/%5c..',
        '/accounts/%',
        '/accounts/%zz',
        // Encoded six times over: past the depth the guard reads through.
        '/accounts/%25252525252e%25252525252e',
      ]) {
        await expect(client.get(READ, p)).rejects.toThrow(RangeError);
      }
      expect(standin.seen).toHaveLength(0);
      // An id that only looks encoded, or decodes to plain text, is a path.
      for (const segment of [
        'acc_1',
        '01HXYZ',
        'a%20b',
        '%41%42',
        'a.b',
        '...',
      ]) {
        expect(unsafeSegment(segment)).toBe(false);
      }
      await client.get(READ, `/accounts/${standin.accounts[0].id}`);
      expect(standin.seen).toHaveLength(1);
    });
  });

  describe('no spec reaches a host other than the stand-in', () => {
    it('the guard refuses a connection to any other host, before a byte or a lookup leaves', async () => {
      const elsewhere = new NuvionClient(
        {
          ...standin.settings(),
          baseUrl: 'https://nuvion.invalid',
          environment: 'sandbox',
        },
        KEY,
      );
      const before = guard.violations.length;
      const e = await failure(elsewhere.get(READ, '/bank-codes/NG'));
      expect(e.kind).toBe('unavailable');
      expect(guard.violations.slice(before)).toEqual(['nuvion.invalid:443']);
      guard.violations.splice(before);
    });

    it('nothing in this file tried any host but loopback', () => {
      expect(guard.violations).toEqual([]);
    });
  });
});
