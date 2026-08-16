import { Injectable, Logger } from '@nestjs/common';
import type {
  FlutterwaveChargeInit,
  FlutterwaveClient,
  FlutterwaveVerifiedTransaction,
} from './flutterwave-client.interface';

interface FlutterwaveVerifyResponseBody {
  status: string;
  message: string;
  data?: {
    status?: string;
    amount?: number;
    currency?: string;
    tx_ref?: string;
  };
}

/**
 * Real Flutterwave v3 REST integration (conventions.md § Third-party
 * integrations / Flutterwave). `initCharge` makes no outbound call — real
 * Flutterwave inline checkout needs only a tx_ref + public key + amount +
 * currency handed to the client SDK, nothing server-initiated. `verifyCharge`
 * calls the real `GET /v3/transactions/:id/verify` endpoint.
 *
 * Selected by service-application.module.ts only when FLUTTERWAVE_SECRET_KEY
 * looks like a real (non-placeholder) key — not exercised by this sandbox's
 * contract tests (no real Flutterwave test-mode credentials available here;
 * see MockFlutterwaveAdapter and declared/flutterwave-payments.json).
 */
@Injectable()
export class RealFlutterwaveAdapter implements FlutterwaveClient {
  private readonly logger = new Logger(RealFlutterwaveAdapter.name);
  private readonly baseUrl = 'https://api.flutterwave.com/v3';

  initCharge(params: { txRef: string; amount: number; currency: string }): Promise<FlutterwaveChargeInit> {
    return Promise.resolve({
      txRef: params.txRef,
      amount: params.amount,
      currency: params.currency,
      publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
    });
  }

  async verifyCharge(params: { transactionId: string; txRef: string }): Promise<FlutterwaveVerifiedTransaction> {
    const res = await fetch(`${this.baseUrl}/transactions/${encodeURIComponent(params.transactionId)}/verify`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      this.logger.warn(`Flutterwave verify failed with HTTP ${res.status} for tx ${params.transactionId}`);
      return { status: 'failed', amount: 0, currency: 'NGN', txRef: params.txRef };
    }

    const body = (await res.json()) as FlutterwaveVerifyResponseBody;
    const data = body.data ?? {};
    return {
      status: data.status ?? 'failed',
      amount: typeof data.amount === 'number' ? data.amount : 0,
      currency: data.currency ?? 'NGN',
      txRef: data.tx_ref ?? params.txRef,
    };
  }
}
