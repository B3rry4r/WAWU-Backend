import { randomUUID } from 'crypto';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import type { CreatorTier } from '../../generated/prisma/enums';
import type {
  ChargeSavedCardParams,
  ChargeSavedCardResult,
  CreateOrReusePlanParams,
  FlutterwaveChargeInit,
  FlutterwaveClient,
  FlutterwavePlan,
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
    card?: { last_4digits?: string; token?: string };
    customer?: { email?: string };
  };
}

interface FlutterwavePaymentPlanApiResponse {
  status?: string;
  data?: { id?: number | string };
}

interface FlutterwaveTokenizedChargeApiResponse {
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
 * conventions.md § Local test environment, same disclaimer as
 * src/purchase/real-flutterwave.adapter.ts). CreatorSubscriptionModule only
 * wires this in when `FLUTTERWAVE_SECRET_KEY` is actually present and
 * NODE_ENV !== 'test'.
 */
@Injectable()
export class RealFlutterwaveAdapter implements FlutterwaveClient {
  private readonly logger = new Logger(RealFlutterwaveAdapter.name);

  /**
   * Process-lifetime plan cache — see flutterwave-client.interface.ts's doc
   * comment on `createOrReusePlan` for why this can't be a durable,
   * cross-restart cache given the frozen schema.
   */
  private readonly plansByTier = new Map<CreatorTier, string>();

  private secretKeyOrThrow(): string {
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secretKey) {
      throw new BadGatewayException(
        'Flutterwave is not configured on this server',
      );
    }
    return secretKey;
  }

  initCharge(params: InitChargeParams): FlutterwaveChargeInit {
    // Client-charge pattern (conventions.md): no Flutterwave network call at
    // init time. Server only generates the tx_ref and hands the client's
    // inline SDK what it needs (referencing the cached Payment Plan id via
    // `planId`); Flutterwave's own hosted inline flow moves the money
    // client-side.
    const txRef = `wawu-sub-${params.purpose}-${randomUUID()}`;
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
    const secretKey = this.secretKeyOrThrow();

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
      cardLast4: data.card?.last_4digits,
      // The reusable token, captured at the one moment Flutterwave hands it
      // over. Without this there is nothing legitimate to charge on a retry.
      cardToken: data.card?.token,
      customerEmail: data.customer?.email,
    };
  }

  async createOrReusePlan(
    params: CreateOrReusePlanParams,
  ): Promise<FlutterwavePlan> {
    const cached = this.plansByTier.get(params.tier);
    if (cached) {
      return { planId: cached };
    }

    const secretKey = this.secretKeyOrThrow();

    let response: Response;
    try {
      response = await fetch(`${FLUTTERWAVE_API_BASE}/payment-plans`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          amount: params.amount,
          name: `WAWUAfrica Creator — ${params.tier}`,
          interval: 'yearly',
          currency: 'NGN',
        }),
      });
    } catch (error) {
      this.logger.error(
        'Flutterwave payment-plan creation failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadGatewayException('Unable to reach Flutterwave');
    }

    if (!response.ok) {
      throw new BadGatewayException('Flutterwave payment-plan creation failed');
    }

    const body = (await response.json()) as FlutterwavePaymentPlanApiResponse;
    const planId = body.data?.id !== undefined ? String(body.data.id) : null;
    if (!planId) {
      throw new BadGatewayException(
        'Flutterwave payment-plan creation returned no plan id',
      );
    }

    this.plansByTier.set(params.tier, planId);
    return { planId };
  }

  async chargeSavedCard(
    params: ChargeSavedCardParams,
  ): Promise<ChargeSavedCardResult> {
    const secretKey = this.secretKeyOrThrow();
    if (!params.flutterwaveCustomerRef) {
      throw new BadGatewayException(
        'No saved card on file to retry this charge against',
      );
    }

    if (!params.email) {
      throw new BadGatewayException(
        'Flutterwave requires the cardholder email to charge a saved card',
      );
    }

    // Flutterwave tokenized-charge: `POST /v3/tokenized-charges` with the
    // token, email and amount in the BODY.
    //
    // This previously POSTed to `/tokenized-charges/{ref}` with the ref in
    // the path and no email, and the ref itself was a locally invented
    // `flw-cust-<wawuUserId>` string. Both were wrong: the path form is not
    // an endpoint Flutterwave exposes, and a token Flutterwave never issued
    // cannot resolve to a card. The retry path could therefore never have
    // succeeded in production.
    let response: Response;
    try {
      response = await fetch(`${FLUTTERWAVE_API_BASE}/tokenized-charges`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          token: params.flutterwaveCustomerRef,
          email: params.email,
          amount: params.amount,
          currency: 'NGN',
          country: 'NG',
          tx_ref: `wawu-sub-${params.purpose}-${randomUUID()}`,
        }),
      });
    } catch (error) {
      this.logger.error(
        'Flutterwave tokenized-charge call failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadGatewayException('Unable to reach Flutterwave');
    }

    if (!response.ok) {
      throw new BadGatewayException('Flutterwave tokenized-charge call failed');
    }

    const body =
      (await response.json()) as FlutterwaveTokenizedChargeApiResponse;
    const data = body.data ?? {};

    return {
      status: data.status === 'successful' ? 'successful' : 'failed',
      txRef: data.tx_ref ?? '',
      transactionId: data.id !== undefined ? String(data.id) : '',
      amount: typeof data.amount === 'number' ? data.amount : 0,
      currency: data.currency ?? 'NGN',
      publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
    };
  }
}
