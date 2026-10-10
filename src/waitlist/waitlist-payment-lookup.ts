import { Injectable, Logger } from '@nestjs/common';
import { shouldUseMockFlutterwave } from '../common/flutterwave/require-payment-config';
import type { FlutterwaveVerifyResult } from '../content-piece/flutterwave-client.interface';

const FLUTTERWAVE_API_BASE = 'https://api.flutterwave.com/v3';
const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Finds a payment by the reference the registration was opened with (JOIN-01).
 *
 * This is the "payer never came back" half of the check: a browser that
 * closed after paying never posts its transaction id, so the sweep asks
 * Flutterwave what became of the reference instead. Null means Flutterwave
 * knows no transaction for it (yet). The same checks as a browser verify are
 * applied to whatever it returns (WaitlistService).
 */
export interface WaitlistPaymentLookup {
  findByReference(txRef: string): Promise<FlutterwaveVerifyResult | null>;
}

/** DI token. Specs stand in a scripted lookup; nothing else reads it. */
export const WAITLIST_PAYMENT_LOOKUP = Symbol('WAITLIST_PAYMENT_LOOKUP');

interface ByReferenceResponse {
  status?: string;
  data?: {
    id?: number | string;
    tx_ref?: string;
    status?: string;
    amount?: number;
    currency?: string;
  };
}

/**
 * Flutterwave's verify-by-reference. Like every payment module here it does
 * not call Flutterwave when the mock is in use (no key, or NODE_ENV=test),
 * and `shouldUseMockFlutterwave()` still refuses a production boot with no
 * real key.
 */
@Injectable()
export class FlutterwaveReferenceLookup implements WaitlistPaymentLookup {
  private readonly logger = new Logger(FlutterwaveReferenceLookup.name);

  async findByReference(
    txRef: string,
  ): Promise<FlutterwaveVerifyResult | null> {
    const key = process.env.FLUTTERWAVE_SECRET_KEY;
    if (shouldUseMockFlutterwave() || !key) return null;

    const res = await fetch(
      `${FLUTTERWAVE_API_BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    // No transaction for this reference yet: Flutterwave answers 4xx.
    if (res.status >= 400 && res.status < 500) return null;
    if (!res.ok) {
      this.logger.warn(`Reference lookup answered ${res.status}`);
      throw new Error(`Flutterwave answered ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as ByReferenceResponse;
    const data = body.data;
    if (body.status !== 'success' || !data || data.id === undefined)
      return null;
    return {
      status: data.status === 'successful' ? 'successful' : 'failed',
      amount: typeof data.amount === 'number' ? data.amount : 0,
      currency: data.currency ?? '',
      // Never fall back to the asked-for reference: the check compares this
      // with the registration's own.
      txRef: data.tx_ref ?? '',
      transactionId: String(data.id),
    };
  }
}
