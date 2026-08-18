import { BadGatewayException, Injectable, Logger } from '@nestjs/common';

export interface HealthPlan {
  planName: string;
  planCode: string;
  price: number;
  dependants?: number;
  numberOfMonths?: number;
  paymentPlan?: string;
  planBenefits?: string[];
  planDescription?: string;
}

export interface EnrolResult {
  policyNumber?: string;
  subscriptionCode?: string;
  reference?: string;
  [key: string]: unknown;
}

/**
 * WellaHealth (Zoi) — the first WAWUCare partner.
 *
 * Auth is HTTP Basic over a client id/secret pair, with the partner code sent
 * alongside. Base URL and credentials come from the environment: the staging
 * pair WellaHealth issued is not committed anywhere, and pointing this at
 * production is a config change, not a code change.
 */
@Injectable()
export class WellaHealthClient {
  private readonly logger = new Logger(WellaHealthClient.name);

  private config() {
    const baseUrl = process.env.WELLAHEALTH_BASE_URL;
    const clientId = process.env.WELLAHEALTH_CLIENT_ID;
    const clientSecret = process.env.WELLAHEALTH_CLIENT_SECRET;
    const partnerCode = process.env.WELLAHEALTH_PARTNER_CODE;
    if (!baseUrl || !clientId || !clientSecret) {
      throw new BadGatewayException('WAWUCare is not configured on this server.');
    }
    return { baseUrl, clientId, clientSecret, partnerCode };
  }

  private async call<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const { baseUrl, clientId, clientSecret, partnerCode } = this.config();
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(partnerCode ? { partnerCode } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      this.logger.error(`WellaHealth request failed: ${String(e)}`);
      throw new BadGatewayException('Could not reach our health partner.');
    }

    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`WellaHealth ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      throw new BadGatewayException(
        res.status === 400
          ? 'Our health partner rejected those details.'
          : 'Our health partner is unavailable right now.',
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** The health-only plans (WAWUCare sells these, not the data bundles). */
  listHealthPlans(): Promise<HealthPlan[]> {
    return this.call<HealthPlan[]>('/v1/zoi/plans/health');
  }

  /**
   * Enrols the buyer once their payment has been verified. `amountPaid` is
   * what we actually collected, which WellaHealth reconciles against the plan
   * price on their side.
   */
  subscribe(payload: {
    firstName: string;
    lastName: string;
    phoneNumber: string;
    amountPaid: number;
    gender: string;
    dateOfBirth: string;
    planCode: string;
    email?: string;
    paymentReference?: string;
    location?: string;
  }): Promise<EnrolResult> {
    return this.call<EnrolResult>('/v1/zoi/subscriptions', {
      method: 'POST',
      body: payload,
    });
  }

  findByPhone(phoneNumber: string): Promise<unknown> {
    return this.call(`/v1/zoi/subscriptions/${encodeURIComponent(phoneNumber)}`);
  }

  /** Pharmacies the plan can be used at, filtered by state. */
  pharmacies(state: string): Promise<unknown> {
    return this.call(`/public/v1/Pharmacy/${encodeURIComponent(state)}`);
  }
}
