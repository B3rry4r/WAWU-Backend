import { BadGatewayException, Injectable, Logger } from '@nestjs/common';

const BASE = 'https://api.flutterwave.com/v3';

export interface BillCategory {
  id: number;
  name: string;
  /** e.g. AIRTIME, DATA_BUNDLE, POWER, CABLEBILLS. */
  code?: string;
  biller_code?: string;
  item_code?: string;
  country?: string;
}

export interface Biller {
  id: number;
  name: string;
  biller_code: string;
  country_code?: string;
}

export interface BillItem {
  id: number;
  biller_code: string;
  name: string;
  item_code: string;
  short_name?: string;
  amount: number;
  fee?: number;
  category_name?: string;
  /** "SmartCard Number", "Meter Number", "Phone Number" — used as the input label. */
  label_name?: string;
}

export interface ValidatedCustomer {
  name?: string;
  biller_code?: string;
  customer?: string;
  product_code?: string;
  fee?: number;
  maximum?: number;
  minimum?: number;
  response_code?: string;
  response_message?: string;
}

export interface BillPaymentResult {
  reference?: string;
  tx_ref?: string;
  network?: string;
  amount?: number;
  fee?: number;
  code?: string;
}

interface FlwEnvelope<T> {
  status?: string;
  message?: string;
  data?: T;
}

/**
 * Flutterwave Bills API (v3).
 *
 * Two different money movements are involved in a bill and they must not be
 * confused: the customer pays WAWU through Flutterwave *checkout*, and WAWU
 * then pays the biller from its Flutterwave *balance* through this client.
 * This class only does the second. Nothing here should ever run before the
 * customer's own payment has been verified.
 */
@Injectable()
export class FlutterwaveBillsClient {
  private readonly logger = new Logger(FlutterwaveBillsClient.name);

  private secret(): string {
    const key = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!key) {
      throw new BadGatewayException('Bill payments are not configured on this server.');
    }
    return key;
  }

  private async call<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.secret()}`,
          'Content-Type': 'application/json',
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      this.logger.error(`Flutterwave bills request failed: ${String(e)}`);
      throw new BadGatewayException('Could not reach the bill payment provider.');
    }

    const payload = (await res.json().catch(() => ({}))) as FlwEnvelope<T>;
    if (!res.ok || payload.status !== 'success') {
      const message = payload.message ?? `Bill provider returned ${res.status}`;
      this.logger.warn(`Flutterwave bills ${path}: ${message}`);
      throw new BadGatewayException(message);
    }
    return payload.data as T;
  }

  listCategories(country = 'NG'): Promise<BillCategory[]> {
    return this.call<BillCategory[]>(
      `/top-bill-categories?country=${encodeURIComponent(country)}`,
    );
  }

  listBillers(category: string, country = 'NG'): Promise<Biller[]> {
    return this.call<Biller[]>(
      `/bills/${encodeURIComponent(category)}/billers?country=${encodeURIComponent(country)}`,
    );
  }

  listItems(billerCode: string): Promise<BillItem[]> {
    return this.call<BillItem[]>(`/billers/${encodeURIComponent(billerCode)}/items`);
  }

  /**
   * Confirms the meter/smartcard/phone actually exists and returns the name on
   * the account, so the payer can check it before spending money on a typo.
   */
  validateCustomer(itemCode: string, customer: string): Promise<ValidatedCustomer> {
    return this.call<ValidatedCustomer>(
      `/bill-items/${encodeURIComponent(itemCode)}/validate?customer=${encodeURIComponent(customer)}`,
    );
  }

  payBill(params: {
    billerCode: string;
    itemCode: string;
    customerId: string;
    amount: number;
    reference: string;
    country?: string;
  }): Promise<BillPaymentResult> {
    return this.call<BillPaymentResult>(
      `/billers/${encodeURIComponent(params.billerCode)}/items/${encodeURIComponent(params.itemCode)}/payment`,
      {
        method: 'POST',
        body: {
          country: params.country ?? 'NG',
          customer_id: params.customerId,
          amount: params.amount,
          reference: params.reference,
        },
      },
    );
  }

  billStatus(reference: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>(
      `/bills/${encodeURIComponent(reference)}?verbose=1`,
    );
  }
}
