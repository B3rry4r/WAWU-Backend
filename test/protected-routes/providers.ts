/**
 * Canned third-party answers for the protected route suite (MONEY-01, round 2).
 *
 * A test double for the providers this backend calls over `fetch`, so routes
 * that only work when Flutterwave, WellaHealth or Gemini answer can be locked
 * on their SUCCESS shape instead of on a 502. It is served from the suite's
 * own fetch interception (harness.ts `sealNetwork`); nothing here is product
 * code and nothing in `src/` knows it exists.
 *
 * Each answer is shaped like the provider's real response, as the code that
 * reads it reads it:
 *
 *   Flutterwave  src/common/flutterwave/checkout-verifier.ts, the five
 *                real-flutterwave adapters, src/bill-payment/flutterwave-bills
 *                .client.ts, src/wallet/flutterwave-wallet.client.ts,
 *                src/payment-link/payment-link.service.ts. Envelope
 *                `{ status: 'success', message, data }`.
 *   WellaHealth  src/health-plan/wellahealth.client.ts. Bare JSON bodies.
 *   Gemini       src/common/ai/real-gemini.adapter.ts. `candidates[0].content
 *                .parts[0].text`, which for a brief is itself JSON.
 *
 * Two deliberate failure switches, so the operator queues have rows in them:
 *   - a bill for customer FAILING_CUSTOMER is refused by the biller;
 *   - a WAWUCare enrolment for phone FAILING_PHONE is refused by WellaHealth.
 *
 * Transaction ids. A real verify call asks Flutterwave about a transaction id
 * the browser got from the checkout modal; there is no modal here. Probes
 * send `flwtx-<amount>-<txRef>` and the fake answers that the transaction was
 * successful for that amount and reference, which is exactly what the
 * verifier then checks against what the server stored. Any other id is
 * "not found", like the real API.
 */

export const FLUTTERWAVE_HOST = 'api.flutterwave.com';
export const WELLAHEALTH_BASE = 'https://wellahealth.protected-suite.test';
export const GEMINI_HOST = 'generativelanguage.googleapis.com';

export const FAILING_CUSTOMER = '08000000000';
export const FAILING_PHONE = '08000000000';

export const PLAN = {
  planName: 'WAWUCare Basic',
  planCode: 'WAWU-BASIC',
  price: 2500,
  dependants: 0,
  numberOfMonths: 1,
  paymentPlan: 'Monthly',
  planBenefits: ['Telemedicine', 'Pharmacy discounts'],
  planDescription: 'Basic monthly cover.',
};

let sequence = 7_000_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ok = (data: unknown, message = 'Request successful') =>
  json(200, { status: 'success', message, data });
const refused = (status: number, message: string) =>
  json(status, { status: 'error', message, data: null });

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  try {
    return typeof init?.body === 'string'
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function flutterwave(url: URL, init: RequestInit | undefined): Response {
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname.replace(/^\/v3/, '');
  const body = bodyOf(init);
  let m: RegExpExecArray | null;

  if (
    (m = /^\/transactions\/([^/]+)\/verify$/.exec(path)) &&
    method === 'GET'
  ) {
    const encoded = /^flwtx-(\d+)-(.+)$/.exec(decodeURIComponent(m[1]));
    if (!encoded) return refused(404, 'No transaction was found for this id');
    return ok(
      {
        id: (sequence += 1),
        tx_ref: encoded[2],
        flw_ref: `FLW-MOCK-${sequence}`,
        amount: Number(encoded[1]),
        charged_amount: Number(encoded[1]),
        currency: 'NGN',
        status: 'successful',
        payment_type: 'card',
      },
      'Transaction fetched successfully',
    );
  }
  if (
    (m = /^\/transactions\/([^/]+)\/refund$/.exec(path)) &&
    method === 'POST'
  ) {
    return ok(
      {
        id: (sequence += 1),
        status: 'completed',
        amount_refunded: body.amount ?? 0,
      },
      'Transaction refund initiated',
    );
  }
  if (path === '/payments' && method === 'POST') {
    return ok(
      {
        link: `https://checkout.flutterwave.com/v3/hosted/pay/${typeof body.tx_ref === 'string' ? body.tx_ref : 'x'}`,
      },
      'Hosted Link',
    );
  }
  if (path === '/balances/NGN') {
    return ok({
      currency: 'NGN',
      available_balance: 5_000_000,
      ledger_balance: 5_000_000,
    });
  }
  if (path === '/top-bill-categories') {
    return ok([
      {
        id: 1,
        name: 'Airtime',
        code: 'AIRTIME',
        description: 'Airtime top-up',
        country: 'NG',
      },
      {
        id: 2,
        name: 'Electricity',
        code: 'UTILITYBILLS',
        description: 'Prepaid and postpaid power',
        country: 'NG',
      },
    ]);
  }
  if ((m = /^\/bills\/([^/]+)\/billers$/.exec(path))) {
    return ok([
      {
        id: 11,
        name: 'MTN Nigeria',
        biller_code: 'BIL099',
        country_code: 'NG',
        logo: null,
        description: 'MTN airtime',
      },
    ]);
  }
  if ((m = /^\/billers\/([^/]+)\/items$/.exec(path)) && method === 'GET') {
    return ok([
      {
        id: 21,
        biller_code: m[1],
        name: 'MTN VTU',
        item_code: 'AT099',
        short_name: 'MTN',
        amount: 0,
        fee: 0,
        category_name: 'Airtime',
        label_name: 'Mobile Number',
      },
    ]);
  }
  if ((m = /^\/bill-items\/([^/]+)\/validate$/.exec(path))) {
    return ok(
      {
        response_code: '00',
        response_message: 'Successful',
        name: 'MTN VTU',
        biller_code: 'BIL099',
        customer: url.searchParams.get('customer') ?? '',
        product_code: m[1],
        fee: 0,
        minimum: 50,
        maximum: 50000,
      },
      'Item validated successfully',
    );
  }
  if (
    (m = /^\/billers\/([^/]+)\/items\/([^/]+)\/payment$/.exec(path)) &&
    method === 'POST'
  ) {
    if (body.customer_id === FAILING_CUSTOMER)
      return refused(400, 'The biller is unavailable for this customer.');
    return ok(
      {
        phone_number: body.customer_id,
        amount: body.amount,
        network: 'MTN',
        code: '200',
        tx_ref: `CF-FLYAPI-${(sequence += 1)}`,
        reference: body.reference,
        fee: 0,
      },
      'Bill payment successful',
    );
  }
  if ((m = /^\/bills\/([^/]+)$/.exec(path))) {
    return ok({ status: 'successful', tx_ref: m[1], amount: 0 });
  }
  if (path === '/payout-subaccounts' && method === 'POST') {
    const n = (sequence += 1);
    return ok(
      {
        account_reference: `PSA${n}`,
        barter_id: `${n}`,
        nuban: `90${String(n).padStart(8, '0')}`,
        bank_name: 'Flutterwave MFB',
        bank_code: '090',
        status: 'ACTIVE',
      },
      'Payout subaccount created',
    );
  }
  if ((m = /^\/payout-subaccounts\/([^/]+)\/balances$/.exec(path))) {
    return ok({
      currency: 'NGN',
      available_balance: 25_000,
      ledger_balance: 25_000,
    });
  }
  if (path === '/transfers' && method === 'POST') {
    return ok(
      {
        id: (sequence += 1),
        status: 'NEW',
        reference: body.reference,
        amount: body.amount,
      },
      'Transfer Queued Successfully',
    );
  }
  if (path === '/transfers' && method === 'GET') {
    return ok([
      {
        id: sequence,
        status: 'SUCCESSFUL',
        reference: url.searchParams.get('reference'),
        complete_message: 'Successful',
      },
    ]);
  }
  if (path === '/accounts/resolve' && method === 'POST') {
    return ok(
      {
        account_number: body.account_number,
        account_name: 'BOLA PROTECTED BUYER',
      },
      'Account details fetched',
    );
  }
  if (path === '/banks/NG') {
    return ok(
      [
        { id: 1, code: '058', name: 'Guaranty Trust Bank' },
        { id: 2, code: '044', name: 'Access Bank' },
      ],
      'Banks fetched successfully',
    );
  }
  return refused(
    404,
    `The protected route suite has no canned Flutterwave answer for ${method} ${path}`,
  );
}

function wellahealth(url: URL, init: RequestInit | undefined): Response {
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = bodyOf(init);
  if (url.pathname === '/v1/zoi/plans/health') return json(200, [PLAN]);
  if (url.pathname === '/v1/zoi/subscriptions' && method === 'POST') {
    if (body.phoneNumber === FAILING_PHONE)
      return json(400, {
        message: 'An enrollee with this phone number is already active.',
      });
    const n = (sequence += 1);
    return json(200, {
      policyNumber: `WH-${n}`,
      subscriptionCode: `SUB-${n}`,
      reference: `WHREF-${n}`,
    });
  }
  return json(404, {
    message: `No canned WellaHealth answer for ${method} ${url.pathname}`,
  });
}

function gemini(): Response {
  const brief = {
    summary:
      'A supplier contract for studio equipment that the client wants reviewed before signing.',
    keyIssues: ['Payment terms', 'Delivery and acceptance'],
    questionsToClarify: ['Who bears the risk in transit?'],
    risks: ['Late delivery has no remedy in the draft.'],
  };
  return json(200, {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(brief) }], role: 'model' },
        finishReason: 'STOP',
      },
    ],
  });
}

/** The canned answer for `url`, or null when no provider double covers it. */
export function fakeProvider(
  url: URL,
  init: RequestInit | undefined,
): Response | null {
  if (url.hostname === FLUTTERWAVE_HOST) return flutterwave(url, init);
  if (url.origin === WELLAHEALTH_BASE) return wellahealth(url, init);
  if (url.hostname === GEMINI_HOST) return gemini();
  return null;
}
