import { randomUUID } from 'crypto';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import type {
  FlutterwaveChargeInit,
  FlutterwaveClient,
  FlutterwaveVerifyResult,
  InitChargeParams,
  VerifyChargeParams,
} from './flutterwave-client.interface';

const FLUTTERWAVE_API_BASE = 'https://api.flutterwave.com/v3';

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
 * conventions.md § Local test environment). PurchaseModule only wires this
 * in when `FLUTTERWAVE_SECRET_KEY` is actually present and NODE_ENV !== 'test'.
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
      txRef: data.tx_ref ?? params.txRef,
      transactionId:
        data.id !== undefined ? String(data.id) : params.transactionId,
    };
  }
}
