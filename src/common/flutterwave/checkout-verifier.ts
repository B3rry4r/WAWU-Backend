import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';

const BASE = 'https://api.flutterwave.com/v3';

export interface VerifiedCheckout {
  transactionId: string;
  txRef: string;
  amount: number;
  currency: string;
}

interface VerifyResponse {
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
 * Verifies a Flutterwave *checkout* transaction server-side.
 *
 * The client hands back a transaction id after the payer completes the modal,
 * but that is only a claim: anyone can POST an id. Nothing may be granted,
 * fulfilled or delivered until this has confirmed with Flutterwave directly
 * that the transaction succeeded, that it carries the tx_ref we issued, and
 * that the amount matches what we asked for. Amount matching is the part that
 * stops a ₦100 payment unlocking a ₦18,999 service.
 *
 * Shared by WAWUPay, WAWUCare and WAWU Legal — all three take money the same
 * way and must check it the same way.
 */
@Injectable()
export class FlutterwaveCheckoutVerifier {
  private readonly logger = new Logger(FlutterwaveCheckoutVerifier.name);

  async verify(params: {
    transactionId: string;
    expectedTxRef: string;
    expectedAmount: number;
    currency?: string;
  }): Promise<VerifiedCheckout> {
    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) {
      throw new BadGatewayException('Payments are not configured on this server.');
    }

    let res: Response;
    try {
      res = await fetch(
        `${BASE}/transactions/${encodeURIComponent(params.transactionId)}/verify`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
    } catch (e) {
      this.logger.error(`Flutterwave verify failed: ${String(e)}`);
      throw new BadGatewayException('Could not reach Flutterwave to confirm the payment.');
    }

    const payload = (await res.json().catch(() => ({}))) as VerifyResponse;
    const data = payload.data;

    if (!res.ok || payload.status !== 'success' || !data) {
      throw new BadRequestException('Payment could not be verified.');
    }
    if ((data.status ?? '').toLowerCase() !== 'successful') {
      throw new BadRequestException('That payment did not go through.');
    }
    if (data.tx_ref !== params.expectedTxRef) {
      // A valid transaction, but not the one this record is waiting on. Almost
      // always someone replaying another payment's id at a different resource.
      this.logger.warn(
        `tx_ref mismatch: expected ${params.expectedTxRef}, got ${data.tx_ref ?? 'none'}`,
      );
      throw new BadRequestException('That payment does not belong to this request.');
    }
    const paid = Number(data.amount ?? 0);
    if (paid < params.expectedAmount) {
      throw new BadRequestException(
        `Payment was ₦${paid.toLocaleString('en-NG')} but this costs ₦${params.expectedAmount.toLocaleString('en-NG')}.`,
      );
    }
    const currency = data.currency ?? 'NGN';
    if (currency !== (params.currency ?? 'NGN')) {
      throw new BadRequestException('That payment was made in the wrong currency.');
    }

    return {
      transactionId: String(data.id ?? params.transactionId),
      txRef: data.tx_ref ?? params.expectedTxRef,
      amount: paid,
      currency,
    };
  }
}
