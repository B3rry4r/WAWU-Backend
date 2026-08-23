import { randomUUID } from 'crypto';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import type {
  FlutterwaveChargeInit,
  FlutterwaveClient,
  FlutterwaveRefundResult,
  FlutterwaveVerifyResult,
  InitChargeParams,
  RefundChargeParams,
  VerifyChargeParams,
} from './flutterwave-client.interface';

const FLUTTERWAVE_API_BASE = 'https://api.flutterwave.com/v3';

interface FlutterwaveRefundApiResponse {
  status?: string;
  message?: string;
  data?: {
    id?: number | string;
    status?: string;
    amount_refunded?: number;
  };
}

interface FlutterwaveVerifyApiResponse {
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
 * Real Flutterwave v3 REST integration (conventions.md § Third-party
 * integrations › Flutterwave). Not exercised against live Flutterwave in
 * this sandbox — no test-mode credentials available here (documented gap,
 * conventions.md § Local test environment). Mirrors
 * src/purchase/real-flutterwave.adapter.ts's precedent exactly.
 * DirectMessageModule only wires this in when `FLUTTERWAVE_SECRET_KEY` is
 * actually present and NODE_ENV !== 'test'.
 */
@Injectable()
export class RealFlutterwaveAdapter implements FlutterwaveClient {
  private readonly logger = new Logger(RealFlutterwaveAdapter.name);

  initCharge(params: InitChargeParams): FlutterwaveChargeInit {
    // Client-charge pattern (conventions.md): no Flutterwave network call at
    // init time. Server only generates the tx_ref and hands the client's
    // inline SDK what it needs; Flutterwave's own hosted inline flow moves
    // the money client-side.
    const txRef = `wawu-${params.purpose}-${randomUUID()}`;
    return {
      txRef,
      amount: params.amount,
      currency: 'NGN',
      publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
    };
  }

  async verifyCharge(
    params: VerifyChargeParams,
  ): Promise<FlutterwaveVerifyResult> {
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secretKey) {
      throw new BadGatewayException(
        'Flutterwave is not configured on this server',
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${FLUTTERWAVE_API_BASE}/transactions/${encodeURIComponent(params.transactionId)}/verify`,
        { headers: { Authorization: `Bearer ${secretKey}` } },
      );
    } catch (error) {
      this.logger.error(
        'Flutterwave verify call failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadGatewayException('Unable to reach Flutterwave');
    }

    if (!response.ok) {
      throw new BadGatewayException('Flutterwave verify call failed');
    }

    const body = (await response.json()) as FlutterwaveVerifyApiResponse;
    const data = body.data ?? {};

    return {
      status: data.status === 'successful' ? 'successful' : 'failed',
      amount: typeof data.amount === 'number' ? data.amount : 0,
      currency: data.currency ?? '',
      // NEVER fall back to the caller's own txRef here. Every module's
      // replay defence is `result.txRef === purchase.flutterwaveTxRef`; if a
      // Flutterwave response omitted tx_ref, that fallback turned the check
      // into a tautology comparing client input with itself. An empty string
      // fails the comparison, which is the safe direction.
      txRef: data.tx_ref ?? '',
      transactionId:
        data.id !== undefined ? String(data.id) : params.transactionId,
    };
  }

  /**
   * POST /v3/transactions/:id/refund.
   *
   * Two things this deliberately does NOT do.
   *
   * It does not treat a non-2xx as a plain retryable failure. Flutterwave
   * answers 400 for "this transaction has already been refunded", and
   * retrying that forever would keep a settled row in the queue reporting an
   * error that is not one. Those are marked `permanent` so the caller stops
   * and escalates instead of looping.
   *
   * It does not report `settled` on a 200 alone. Their refund is
   * asynchronous; `data.status` is what says whether the money has actually
   * moved. Anything else that succeeded is `submitted`, and the webhook
   * settles it later. Telling a payer their refund landed when it has only
   * been queued is the failure this whole change exists to remove.
   */
  async refundCharge(
    params: RefundChargeParams,
  ): Promise<FlutterwaveRefundResult> {
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secretKey) {
      throw new BadGatewayException(
        'Flutterwave is not configured on this server',
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${FLUTTERWAVE_API_BASE}/transactions/${encodeURIComponent(params.transactionId)}/refund`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ amount: params.amount }),
        },
      );
    } catch (error) {
      // Network-level: nothing was decided, so this is always worth retrying.
      this.logger.error(
        'Flutterwave refund call failed',
        error instanceof Error ? error.stack : String(error),
      );
      return {
        status: 'failed',
        reference: null,
        message: 'Unable to reach Flutterwave',
        permanent: false,
      };
    }

    let body: FlutterwaveRefundApiResponse = {};
    try {
      body = (await response.json()) as FlutterwaveRefundApiResponse;
    } catch {
      // A 2xx we cannot parse is genuinely ambiguous — the refund may well
      // have been accepted. Retrying a refund that already succeeded is the
      // one mistake with real money attached, so this escalates to a human
      // rather than trying again.
      if (response.ok) {
        return {
          status: 'failed',
          reference: null,
          message:
            'Flutterwave returned an unreadable response to a refund that may have succeeded — check their dashboard before retrying',
          permanent: true,
        };
      }
    }

    if (!response.ok) {
      const message = body.message ?? `Flutterwave refund failed (HTTP ${response.status})`;
      // 4xx is Flutterwave rejecting the request itself: already refunded,
      // not refundable, unknown transaction. None of those improve on a
      // second attempt. 5xx is theirs and may.
      const permanent = response.status >= 400 && response.status < 500;
      return { status: 'failed', reference: null, message, permanent };
    }

    const data = body.data ?? {};
    const reference = data.id !== undefined ? String(data.id) : null;
    const settled = data.status === 'completed' || data.status === 'successful';

    return {
      status: settled ? 'settled' : 'submitted',
      reference,
      message: body.message ?? null,
      permanent: false,
    };
  }
}
