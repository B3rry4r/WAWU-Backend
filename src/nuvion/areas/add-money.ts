import { safeKoboNumber } from '../../wallet-provider/wallet-provider.interface';
import type {
  AddMoneyProvider,
  AddMoneyRail,
  ProviderAddMoneyAttempt,
  ProviderAddMoneyConfirm,
  ProviderAddMoneyRef,
  ProviderAddMoneyStart,
  ProviderAddMoneyState,
  ProviderAddMoneyWallet,
} from '../../wallet-provider/add-money';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';
import { NUVION_NAIRA, readNuvionWalletId } from './accounts';

const AREA = 'add money (WALLET-25, WALLET-26)';

/**
 * Adding money through Nuvion's payment rails (WALLET-25 card and Apple Pay,
 * WALLET-26 USSD and the hosted bank checkout; R-84). Nuvion facts are from
 * its docs (guides__accept-card-payment, api-reference__payment-intents,
 * guides__funding-session, api-reference__funding-session,
 * core-concepts__encryption) and from real dev answers, recorded in the
 * mobile repo's docs/nuvion/DEV-RESULTS.md (rows WALLET-25). This file is
 * WALLET-25's alone: it is reached only through the seam's `AddMoneyProvider`
 * methods (src/wallet-provider/add-money.ts).
 *
 * - **Card and Apple Pay** are a payment intent (`POST /payment-intents`)
 *   confirmed by an intent action (`POST /intent-actions`). The card arrives
 *   already encrypted by the phone (RSA-OAEP, SHA-256, Nuvion's public key):
 *   this file hands that text on as it is and never reads it. 3-D Secure and
 *   Apple Pay come back as a hosted page (`next_action.url`).
 * - **USSD** is a funding session with `funding_type` `momo` (the payer
 *   answers a USSD prompt on their phone); **the bank checkout** is a funding
 *   session with the default `open-banking` (a hosted page, `checkout_url`).
 * - The wallet is credited by the inflow Nuvion records on the account when
 *   the payment settles, not by anything read here (NUV-04's recorder, with
 *   the hook WALLET-25 adds). What is read here says where an attempt stands.
 *
 * Dev refuses naira on every one of these (`error_acquiring_currency_not_
 * supported` for a card and Apple Pay, `503 error_system_dependency_
 * unavailable` for a funding session); the refusal is `not_supported` here,
 * so a caller says so plainly. The same calls were measured on dev in USD,
 * GBP and KES (DEV-RESULTS).
 */

const NUVION_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}
function whole(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** Nuvion's own types that say "not this currency, not this rail": a refusal, not a failure of the call (a suspended service is `isServiceRefusal`'s). */
const NOT_SERVED_TYPES: readonly string[] = [
  'error_acquiring_currency_not_supported',
];

/**
 * Nuvion's refusal of the service itself, not of this payment (NUVION-FIX 1.2): card acquiring is SUSPENDED in production
 * (27 Oct 2026). Its type or its words say so on a 4xx; a person's own account being suspended (`error_account_*`) is not this.
 */
export function isServiceRefusal(e: NuvionError): boolean {
  const type = e.nuvionType ?? '';
  if (NOT_SERVED_TYPES.includes(type)) return true;
  const status = e.httpStatus ?? 0;
  if (status < 400 || status >= 500 || status === 429) return false;
  if (type.startsWith('error_account_')) return false;
  return (
    /suspend/i.test(type) ||
    /^error_acquiring_.*(not_supported|not_available)/.test(type) ||
    e.messages.some((m) => /suspend/i.test(m))
  );
}

/** The state a payment intent or its action is in, in the seam's words. */
export function intentState(
  intentStatus: string | null,
  actionStatus: string | null,
): ProviderAddMoneyState {
  if (actionStatus === 'failed') return 'failed';
  switch (intentStatus) {
    case 'completed':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'requires_action':
      return 'created';
    default:
      break;
  }
  if (actionStatus === 'completed') return 'paid';
  if (actionStatus === 'pending_user_action') return 'awaiting_user';
  return 'processing';
}

/** The state a funding session is in, in the seam's words. */
export function sessionState(status: string | null): ProviderAddMoneyState {
  switch (status) {
    case 'awaiting_user':
      return 'awaiting_user';
    case 'settled':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'processing';
  }
}

function expiry(o: Record<string, unknown>): Date | null {
  const v = o.expires_at;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    ? new Date(v)
    : null;
}

/** An intent action object, field by field. */
function readAction(
  action: Record<string, unknown>,
): Pick<
  ProviderAddMoneyAttempt,
  'actionRef' | 'nextUrl' | 'feeKobo' | 'card' | 'failure'
> & { status: string | null } {
  const next = isRecord(action.next_action) ? action.next_action : null;
  const data = isRecord(action.payment_type_data)
    ? action.payment_type_data
    : null;
  const fee = whole(action, 'applicable_fee');
  const reason = text(action, 'status_reason');
  const status = text(action, 'status');
  return {
    status,
    actionRef: text(action, 'id'),
    nextUrl: next ? text(next, 'url') : null,
    feeKobo: fee === null ? null : BigInt(fee),
    card: data
      ? {
          last4: text(data, 'last_four_digits'),
          brand: text(data, 'card_brand'),
        }
      : null,
    failure:
      status === 'failed'
        ? { code: 'payment_failed', message: reason ?? 'The payment failed.' }
        : null,
  };
}

/**
 * A payment intent answer (create, retrieve, cancel), with its nested
 * action when there is one, or an intent action answer (confirm) that names
 * its intent. Null when it is neither.
 */
export function readIntentAttempt(
  raw: unknown,
  rail: AddMoneyRail,
): ProviderAddMoneyAttempt | null {
  if (!isRecord(raw)) return null;
  const nested = isRecord(raw.intent_action) ? raw.intent_action : null;
  const isAction = text(raw, 'payment_intent_id') !== null;
  const intentId = isAction ? text(raw, 'payment_intent_id') : text(raw, 'id');
  if (!intentId || !NUVION_ID.test(intentId)) return null;
  const action = isAction ? raw : nested;
  const a = action ? readAction(action) : null;
  const intentStatus = isAction ? null : text(raw, 'status');
  const state = intentState(intentStatus, a ? a.status : null);
  const cancelledReason = !isAction ? text(raw, 'status_reason') : null;
  return {
    rail,
    providerRef: intentId,
    actionRef: a?.actionRef ?? null,
    state,
    nextUrl: state === 'awaiting_user' ? (a?.nextUrl ?? null) : null,
    feeKobo: a?.feeKobo ?? null,
    failure:
      a?.failure ??
      (intentStatus === 'failed'
        ? { code: 'payment_failed', message: 'The payment failed.' }
        : state === 'cancelled' && cancelledReason
          ? { code: 'cancelled', message: cancelledReason }
          : null),
    card: a?.card ?? null,
    expiresAt: null,
  };
}

/** A funding session answer (create answers fields flat; retrieve nests `failure`). */
export function readSessionAttempt(
  raw: unknown,
  rail: AddMoneyRail,
): ProviderAddMoneyAttempt | null {
  if (!isRecord(raw)) return null;
  const id = text(raw, 'id');
  if (!id || !NUVION_ID.test(id)) return null;
  const failure = isRecord(raw.failure) ? raw.failure : null;
  const state = sessionState(text(raw, 'status'));
  return {
    rail,
    providerRef: id,
    actionRef: null,
    state,
    nextUrl: state === 'awaiting_user' ? text(raw, 'checkout_url') : null,
    feeKobo: null,
    failure:
      failure && (state === 'failed' || state === 'expired')
        ? {
            code: (text(failure, 'code') ?? 'failed').toLowerCase(),
            message: text(failure, 'message') ?? 'The payment failed.',
          }
        : state === 'failed'
          ? { code: 'failed_at_start', message: 'The payment could not start.' }
          : null,
    card: null,
    expiresAt: expiry(raw),
  };
}

export class NuvionAddMoneyArea implements AddMoneyProvider {
  readonly addMoneyRails: readonly AddMoneyRail[] = [
    'card',
    'apple_pay',
    'ussd',
    'open_banking',
  ];

  constructor(readonly client: NuvionClient) {}

  /**
   * Makes the payment intent (card, Apple Pay) or the funding session (USSD,
   * the bank checkout). Idempotent by `reference` at Nuvion: a repeat is a
   * 409 with the original, which is found and returned.
   */
  async startAddMoney(
    input: ProviderAddMoneyStart,
  ): Promise<ProviderAddMoneyAttempt> {
    const op: NuvionOp = { name: 'start add money', call: 'write' };
    const ids = this.ids(op, input.wallet);
    const amount = safeKoboNumber(input.chargeKobo);
    try {
      if (input.rail === 'card' || input.rail === 'apple_pay') {
        const answer = await this.client.post<unknown>(
          op,
          '/payment-intents',
          {
            currency: NUVION_NAIRA,
            amount,
            account_id: ids.accountId,
            entity_id: ids.entityId,
            reference: input.reference,
            description: input.narration.slice(0, 250),
          },
          { reference: input.reference },
        );
        return this.need(op, readIntentAttempt(answer.data, input.rail));
      }
      const body: Record<string, unknown> = {
        amount,
        currency: NUVION_NAIRA,
        account_id: ids.accountId,
        entity_id: ids.entityId,
        unique_reference: input.reference,
        narration: input.narration.slice(0, 255),
      };
      if (input.rail === 'ussd') {
        if (!input.ussd) {
          throw new NuvionError({
            kind: 'validation',
            operation: op.name,
            messages: [`${AREA}: a USSD payment needs a phone and a channel`],
          });
        }
        body.funding_type = 'momo';
        body.meta = { msisdn: input.ussd.msisdn, channel: input.ussd.channel };
      } else {
        body.redirect_url = input.returnUrl;
        body.country_code = input.countryCode;
      }
      const answer = await this.client.post<unknown>(
        op,
        '/funding-sessions',
        body,
        { reference: input.reference },
      );
      return this.need(op, readSessionAttempt(answer.data, input.rail));
    } catch (e) {
      throw this.refusal(e);
    }
  }

  /** Pays an intent with a card (3-D Secure by default) or Apple Pay. */
  async confirmAddMoney(
    input: ProviderAddMoneyConfirm,
  ): Promise<ProviderAddMoneyAttempt> {
    const op: NuvionOp = { name: 'confirm add money', call: 'write' };
    const ids = this.ids(op, input.wallet);
    if (!NUVION_ID.test(input.providerRef)) {
      throw this.invalid(op, 'the payment intent id is not in Nuvion form');
    }
    const customer: Record<string, unknown> = {
      first_name: input.payer.firstName,
      last_name: input.payer.lastName,
      email: input.payer.email,
      ...(input.payer.phone ? { phone_number: input.payer.phone } : {}),
    };
    let data: Record<string, unknown>;
    if (input.rail === 'card') {
      if (!input.encryptedCard || !input.billing || !input.browser) {
        throw this.invalid(
          op,
          'a card payment needs the encrypted card, a billing address and the phone details',
        );
      }
      const b = input.browser;
      data = {
        data: input.encryptedCard,
        auth_model: '3ds_required',
        browser_info: {
          accept_header: b.acceptHeader,
          user_agent: b.userAgent,
          language: b.language,
          screen_width: b.screenWidth,
          screen_height: b.screenHeight,
          java_enabled: false,
          color_depth: b.colorDepth,
          timezone_offset: b.timezoneOffset,
          javascript_enabled: true,
          channel: 'browser',
          ip_address: b.ipAddress,
        },
        billing_address: {
          address_line_one: input.billing.line1,
          city: input.billing.city,
          state: input.billing.state,
          country: input.billing.country,
          ...(input.billing.postalCode
            ? { zip: input.billing.postalCode }
            : {}),
        },
      };
    } else {
      data = { billing_address: { country: input.countryCode } };
    }
    try {
      const answer = await this.client.post<unknown>(
        op,
        '/intent-actions',
        {
          payment_intent_id: input.providerRef,
          entity_id: ids.entityId,
          intent_action: {
            action: 'confirm',
            category: 'collections',
            payment_type: input.rail === 'card' ? 'card-acq' : 'applepay-acq',
            payment_type_data: data,
            customer,
            return_url: input.returnUrl,
          },
        },
        { reference: input.providerRef },
      );
      return this.need(op, readIntentAttempt(answer.data, input.rail));
    } catch (e) {
      throw this.refusal(e);
    }
  }

  /** Where one attempt stands now. */
  async readAddMoney(
    ref: ProviderAddMoneyRef,
  ): Promise<ProviderAddMoneyAttempt> {
    const op: NuvionOp = { name: 'read add money', call: 'read' };
    const ids = this.ids(op, ref.wallet);
    if (!NUVION_ID.test(ref.providerRef)) {
      throw this.invalid(op, 'the attempt id is not in Nuvion form');
    }
    const card = ref.rail === 'card' || ref.rail === 'apple_pay';
    const path = `${card ? '/payment-intents' : '/funding-sessions'}/${encodeURIComponent(ref.providerRef)}`;
    const answer = await this.client.get<unknown>(op, path, {
      entity_id: ids.entityId,
    });
    return this.need(
      op,
      card
        ? readIntentAttempt(answer.data, ref.rail)
        : readSessionAttempt(answer.data, ref.rail),
    );
  }

  /** An attempt found again by our reference; null when Nuvion has none. */
  async findAddMoney(
    rail: AddMoneyRail,
    wallet: ProviderAddMoneyWallet,
    reference: string,
  ): Promise<ProviderAddMoneyAttempt | null> {
    const op: NuvionOp = { name: 'find add money', call: 'read' };
    const ids = this.ids(op, wallet);
    const card = rail === 'card' || rail === 'apple_pay';
    if (card) {
      const answer = await this.client.get<unknown>(op, '/payment-intents', {
        reference,
        account_id: ids.accountId,
        entity_id: ids.entityId,
        limit: 5,
      });
      const items =
        isRecord(answer.data) && Array.isArray(answer.data.items)
          ? answer.data.items
          : [];
      for (const item of items) {
        if (isRecord(item) && text(item, 'reference') === reference) {
          return this.need(op, readIntentAttempt(item, rail));
        }
      }
      return null;
    }
    const listed = await this.client.listAll<unknown>(op, '/funding-sessions', {
      account_id: ids.accountId,
      entity_id: ids.entityId,
      limit: 100,
    });
    for (const item of listed.items) {
      if (isRecord(item) && text(item, 'unique_reference') === reference) {
        return this.need(op, readSessionAttempt(item, rail));
      }
    }
    return null;
  }

  /**
   * Cancels a payment intent that was not confirmed (`PATCH
   * /payment-intents/{id}`, only while `requires_action`). A funding session
   * has no cancel call: it ends by itself, so this does nothing for it.
   */
  async cancelAddMoney(ref: ProviderAddMoneyRef): Promise<void> {
    if (ref.rail !== 'card' && ref.rail !== 'apple_pay') return;
    const op: NuvionOp = { name: 'cancel add money', call: 'write' };
    const ids = this.ids(op, ref.wallet);
    if (!NUVION_ID.test(ref.providerRef)) {
      throw this.invalid(op, 'the payment intent id is not in Nuvion form');
    }
    await this.client.patch<unknown>(
      op,
      `/payment-intents/${encodeURIComponent(ref.providerRef)}`,
      {
        action: 'cancel',
        reason: 'Cancelled in the app',
        entity_id: ids.entityId,
      },
    );
  }

  // -------------------------------------------------------------------------

  private ids(op: NuvionOp, wallet: ProviderAddMoneyWallet) {
    const ids = readNuvionWalletId(wallet.walletId);
    if (!ids || ids.entityId !== wallet.customerId) {
      throw this.invalid(op, "the wallet is not one of Nuvion's");
    }
    return ids;
  }

  private invalid(op: NuvionOp, why: string): NuvionError {
    return new NuvionError({
      kind: 'validation',
      operation: op.name,
      messages: [`${AREA}: ${why}`],
    });
  }

  private need(
    op: NuvionOp,
    attempt: ProviderAddMoneyAttempt | null,
  ): ProviderAddMoneyAttempt {
    if (attempt) return attempt;
    throw new NuvionError({
      kind: op.call === 'write' ? 'not_confirmed' : 'bad_response',
      operation: op.name,
      messages: [`${AREA}: Nuvion's answer could not be read`],
    });
  }

  /** Nuvion's "not this currency" is a refusal of the rail (`not_supported`); every other failure is as it came. */
  private refusal(e: unknown): unknown {
    if (e instanceof NuvionError && isServiceRefusal(e)) {
      return new NuvionError({
        kind: 'not_supported',
        operation: e.operation,
        httpStatus: e.httpStatus,
        messages: [
          `${AREA}: Nuvion does not take naira on this rail (not supported, or suspended)`,
        ],
        recordMayExist: false,
        requestId: e.requestId,
        nuvionType: e.nuvionType,
      });
    }
    // Nuvion answered 503 with its own error object (dev does this for a naira funding session): it said no, and made nothing.
    // Starting again with the same reference finds whatever was made, so nothing is lost by saying so.
    if (
      e instanceof NuvionError &&
      e.nuvionType === 'error_system_dependency_unavailable' &&
      e.httpStatus === 503 &&
      e.operation === 'start add money'
    ) {
      return new NuvionError({
        kind: 'unavailable',
        operation: e.operation,
        httpStatus: e.httpStatus,
        messages: [`${AREA}: Nuvion's partner is unavailable for this payment`],
        recordMayExist: false,
        requestId: e.requestId,
        nuvionType: e.nuvionType,
      });
    }
    return e;
  }
}
