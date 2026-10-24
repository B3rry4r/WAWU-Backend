import {
  envelope,
  errorBody,
  NuvionStandin,
} from '../../../test/nuvion/nuvion-standin';
import { AbroadRefusal } from '../../wallet-provider/abroad-provider';
import { NuvionAbroadArea, abroadState } from '../areas/abroad';
import { nuvionWalletId } from '../areas/accounts';
import { NuvionClient } from '../nuvion-client';

/**
 * The Nuvion side of sending abroad (NUV-11) over the stand-in, answering as
 * the dev server did on 24 Oct 2026 (mobile repo docs/nuvion/DEV-RESULTS.md,
 * section NUV-11). Nothing leaves loopback.
 */

const ENTITY = '01M5JTGM06RJJMBK8H0RTFTHZZ';
const NGN = '01M5MAK33VSPQ7X86GNKA5X0B7';
const USD = '01M5PY71JBNYN9K3ZDPQB3GZ6J';
const HOLDER = {
  customerId: ENTITY,
  walletId: nuvionWalletId(ENTITY, NGN),
};

const standin = new NuvionStandin();
let area: NuvionAbroadArea;
const clock = 1_000_000;

beforeAll(async () => {
  await standin.start(8410);
  area = new NuvionAbroadArea(
    new NuvionClient(standin.settings(), 'test-key'),
    () => clock,
  );
});
afterAll(() => standin.stop());
beforeEach(() => {
  standin.reset();
  standin.seen.length = 0;
});

const quoteBody = (over: Record<string, unknown> = {}) => ({
  id: '01M5PZNJDXVKY7KT06QM97DBXD',
  from: 'USD',
  to: 'GHS',
  amount_from: 5000,
  amount_to: 50180,
  rate: 10.036105,
  quote: {
    status: 'active',
    expires_at: Date.now() + 179_000,
    valid_for: 179,
    used_at: null,
    used_in_payment_id: null,
  },
  ...over,
});

describe('the quote', () => {
  it('asks for amount_from with the account and entity, and reads the hold', async () => {
    standin.on('POST', '/fx-quotes', {
      status: 201,
      body: envelope(quoteBody()),
    });
    const q = await area.quote({
      holder: HOLDER,
      fromCurrency: 'USD',
      toCurrency: 'GHS',
      fromAccountRef: USD,
      amountMinor: 5000,
      side: 'send',
    });
    expect(standin.seen[0].body).toEqual({
      from_currency: 'USD',
      to_currency: 'GHS',
      amount_from: 5000,
      account_id: USD,
      entity_id: ENTITY,
    });
    expect(q).toMatchObject({
      quoteRef: '01M5PZNJDXVKY7KT06QM97DBXD',
      amountFromMinor: 5000,
      amountToMinor: 50180,
      rate: '10.036105',
      validForSeconds: 179,
    });
  });

  it('asks for amount_to when the recipient must get an exact sum', async () => {
    standin.on('POST', '/fx-quotes', {
      status: 201,
      body: envelope(quoteBody()),
    });
    await area.quote({
      holder: HOLDER,
      fromCurrency: 'USD',
      toCurrency: 'GHS',
      fromAccountRef: USD,
      amountMinor: 50180,
      side: 'receive',
    });
    expect(standin.seen[0].body).toMatchObject({ amount_to: 50180 });
    expect(standin.seen[0].body).not.toHaveProperty('amount_from');
  });

  it('holds a same-currency send itself and asks Nuvion for nothing', async () => {
    const q = await area.quote({
      holder: HOLDER,
      fromCurrency: 'USD',
      toCurrency: 'USD',
      fromAccountRef: USD,
      amountMinor: 5000,
      side: 'send',
    });
    expect(q).toMatchObject({
      quoteRef: null,
      rate: null,
      amountToMinor: 5000,
    });
    expect(standin.seen).toHaveLength(0);
  });

  it('says plainly that dev has no rate for naira to cedis (HTTP 500, dependency unavailable)', async () => {
    standin.on('POST', '/fx-quotes', {
      status: 500,
      body: errorBody(
        'error_system_dependency_unavailable',
        'Request failed with status code 503',
      ),
    });
    await expect(
      area.quote({
        holder: HOLDER,
        fromCurrency: 'NGN',
        toCurrency: 'GHS',
        fromAccountRef: NGN,
        amountMinor: 1_000_000,
        side: 'send',
      }),
    ).rejects.toMatchObject({ reason: 'rate_unavailable' });
  });

  it('refuses a pair Nuvion does not convert', async () => {
    standin.on('POST', '/fx-quotes', {
      status: 422,
      body: {
        status: 'error',
        type: 'error_validation_error',
        message: 'Validation failed',
        validations: [
          {
            to_currency: {
              type: 'error_validation_value_not_supported',
              message:
                "The value 'XAF' is not supported for to_currency yet. Please use a supported to_currency.",
            },
          },
        ],
      },
    });
    await expect(
      area.quote({
        holder: HOLDER,
        fromCurrency: 'NGN',
        toCurrency: 'XAF',
        fromAccountRef: NGN,
        amountMinor: 1_000_000,
        side: 'send',
      }),
    ).rejects.toMatchObject({ reason: 'corridor_not_supported' });
  });

  it('does not take a quote for other currencies than the ones asked', async () => {
    standin.on('POST', '/fx-quotes', {
      status: 201,
      body: envelope(quoteBody({ to: 'KES' })),
    });
    await expect(
      area.quote({
        holder: HOLDER,
        fromCurrency: 'USD',
        toCurrency: 'GHS',
        fromAccountRef: USD,
        amountMinor: 5000,
        side: 'send',
      }),
    ).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('the send', () => {
  const input = {
    holder: HOLDER,
    fromAccountRef: NGN,
    fromCurrency: 'NGN',
    toCurrency: 'AUD',
    amountFromMinor: 98523,
    counterpartyId: '01M5PZF2M7WYWAZS5NDZP0FD1F',
    paymentDetailId: '01M5PZKK5R97J7E3EGTSDW81ET',
    method: 'bank' as const,
    quoteRef: '01M5PZY67G5MZVD3D3JTZ238CY',
    narration: 'b23 abroad probe',
    reference: 'wawu-abroad-0000',
  };
  const accepted = {
    id: '01M5PZY8W9BKDTEBTBP6MG6RKX',
    amount: 98523,
    currency: 'NGN',
    unique_reference: 'wawu-abroad-0000',
    status: 'new',
    status_reason: 'payment_initiated',
    type: 'outflow',
    payment_type: 'bank-transfer',
    applicable_fee: 0,
  };

  it('sends the SOURCE currency with the quote, as dev needs, and reads the new state as pending', async () => {
    standin.on('POST', '/transfers', { status: 201, body: envelope(accepted) });
    const t = await area.send(input);
    expect(standin.seen[0].body).toEqual({
      account_id: NGN,
      payment_detail_id: input.paymentDetailId,
      counterparty_id: input.counterpartyId,
      amount: 98523,
      currency: 'NGN',
      narration: 'b23 abroad probe',
      payment_type: 'bank-transfer',
      unique_reference: 'wawu-abroad-0000',
      fx_quote_id: input.quoteRef,
      entity_id: ENTITY,
    });
    expect(t).toMatchObject({
      id: accepted.id,
      state: 'pending',
      providerStatus: 'new',
      feeMinor: 0,
    });
  });

  it('uses momo-transfer for mobile money and sends no quote for one currency', async () => {
    standin.on('POST', '/transfers', {
      status: 201,
      body: envelope({
        ...accepted,
        currency: 'USD',
        payment_type: 'momo-transfer',
      }),
    });
    await area.send({
      ...input,
      fromCurrency: 'USD',
      toCurrency: 'USD',
      method: 'mobile_money',
      quoteRef: null,
    });
    expect(standin.seen[0].body).toMatchObject({
      payment_type: 'momo-transfer',
      currency: 'USD',
    });
    expect(standin.seen[0].body).not.toHaveProperty('fx_quote_id');
  });

  it('refuses to send two currencies without a quote, before asking Nuvion', async () => {
    await expect(area.send({ ...input, quoteRef: null })).rejects.toMatchObject(
      {
        kind: 'validation',
      },
    );
    expect(standin.seen).toHaveLength(0);
  });

  it('names the fields a US transfer is refused without (bank address, account type)', async () => {
    standin.on('POST', '/transfers', {
      status: 422,
      body: {
        status: 'error',
        type: 'error_validation_error',
        message: 'Validation failed for one or more fields',
        validations: [
          {
            'payment_detail.account_type': {
              type: 'error_validation_required_field_missing',
              message: "The 'payment_detail.account_type' field is required.",
            },
          },
          {
            'payment_detail.bank_address.country': {
              type: 'error_validation_required_field_missing',
              message:
                "The 'payment_detail.bank_address.country' field is required.",
            },
          },
        ],
      },
    });
    const e = await area.send(input).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AbroadRefusal);
    expect(e).toMatchObject({
      reason: 'invalid_details',
      detail: { fields: ['account_type', 'bank_address_country'] },
    });
  });

  it('says not enough money when the account holds less', async () => {
    standin.on('POST', '/transfers', {
      status: 400,
      body: errorBody(
        'error_transfer_insufficient_funds',
        "You don't have enough funds for this transfer. Your available balance is 0 USD.",
      ),
    });
    await expect(area.send(input)).rejects.toMatchObject({
      reason: 'insufficient_funds',
    });
  });

  it('keeps a lost answer as an unknown outcome and never sends again', async () => {
    standin.on('POST', '/transfers', { status: 200, hangUp: true });
    await expect(area.send(input)).rejects.toMatchObject({
      recordMayExist: true,
    });
    expect(standin.seen).toHaveLength(1);
  });

  it('does not take an answer for another reference as the send', async () => {
    standin.on('POST', '/transfers', {
      status: 201,
      body: envelope({ ...accepted, unique_reference: 'someone-else' }),
    });
    await expect(area.send(input)).rejects.toMatchObject({
      kind: 'not_confirmed',
      recordMayExist: true,
    });
  });
});

describe('the recipient', () => {
  const sender = {
    person: { email: 'sender@example.com' },
    address: {
      line_1: '1 Lagos Road',
      city: 'Lagos',
      state: 'Lagos',
      postal_code: '100001',
      country_code: 'NG',
    },
    entity: { id: ENTITY },
  };
  const recipient = (over: Record<string, unknown> = {}) => ({
    holder: HOLDER,
    country: 'GH',
    currency: 'GHS',
    method: 'bank' as const,
    scheme: null,
    holderName: 'Ama Mensah',
    fields: { bank: '030100', account_number: '0123456789' },
    marker: 'marker-1',
    ...over,
  });

  beforeEach(() => {
    standin.on('GET', '/bank-codes/GH', {
      status: 200,
      body: envelope([
        {
          bank_code: '030100',
          bank_name: 'ABSA BANK OF GHANA LIMITED',
          swift_bic: 'BARCGHAC',
        },
      ]),
    });
    standin.on('GET', '/counterparties', {
      status: 200,
      body: envelope({
        data: [],
        meta: {
          pagination: {
            order: 'desc',
            has_next: false,
            limit: 100,
            has_previous: false,
            next_cursor: null,
            previous_cursor: null,
          },
        },
      }),
    });
    standin.on('GET', `/entities/${ENTITY}`, {
      status: 200,
      body: envelope(sender),
    });
    standin.on('POST', '/counterparties', {
      status: 201,
      body: envelope({ id: '01M5PZF2M7WYWAZS5NDZP0FD1F' }),
    });
    standin.on('POST', '/payment-details', {
      status: 201,
      body: envelope({ id: '01M5PZHEZJ451ZJRN9ZV9G46P3' }),
    });
  });

  it("makes the counterparty with the sender's own email and address, and the payment detail from the directory", async () => {
    const saved = await area.saveRecipient(recipient());
    expect(saved).toEqual({
      counterpartyId: '01M5PZF2M7WYWAZS5NDZP0FD1F',
      paymentDetailId: '01M5PZHEZJ451ZJRN9ZV9G46P3',
      bankName: 'ABSA BANK OF GHANA LIMITED',
    });
    const cp = standin.seen.find(
      (r) => r.method === 'POST' && r.path === '/counterparties',
    );
    expect(cp?.body).toMatchObject({
      type: 'individual',
      entity_id: ENTITY,
      profile: {
        first_name: 'Ama',
        last_name: 'Mensah',
        relationship: 'vendor',
        email: 'sender@example.com',
        address: { state_or_province: 'Lagos', postal_code: '100001' },
      },
      meta: { wawu_abroad: 'marker-1' },
    });
    const pd = standin.seen.find((r) => r.path === '/payment-details');
    expect(pd?.body).toEqual({
      payment_method: 'bank-transfer',
      currency: 'GHS',
      country: 'GH',
      account_holder_name: 'Ama Mensah',
      entity_id: ENTITY,
      counterparty_id: '01M5PZF2M7WYWAZS5NDZP0FD1F',
      bank_code: '030100',
      bank_name: 'ABSA BANK OF GHANA LIMITED',
      account_number: '0123456789',
    });
  });

  it('turns the bank address fields into the address object and sends a picked scheme', async () => {
    await area.saveRecipient(
      recipient({
        country: 'US',
        currency: 'USD',
        scheme: 'ach',
        fields: {
          bank_name: 'Bank of America',
          routing_number: '026009593',
          account_number: '987654321012',
          account_type: 'checking',
          bank_address_line1: '100 Federal Street',
          bank_address_city: 'Boston',
          bank_address_state: 'MA',
          bank_address_postal_code: '02110',
        },
      }),
    );
    const pd = standin.seen.find((r) => r.path === '/payment-details');
    expect(pd?.body).toMatchObject({
      scheme: 'ach',
      account_type: 'checking',
      bank_address: {
        line1: '100 Federal Street',
        city: 'Boston',
        state: 'MA',
        postal_code: '02110',
        country: 'US',
      },
    });
  });

  it('finds the counterparty again by its marker after a lost answer', async () => {
    standin.on('GET', '/counterparties', {
      status: 200,
      body: envelope({
        data: [
          {
            id: '01M5PZF2M7WYWAZS5NDZP0FD1F',
            meta: { wawu_abroad: 'marker-1' },
          },
        ],
        meta: {
          pagination: {
            order: 'desc',
            has_next: false,
            limit: 100,
            has_previous: false,
            next_cursor: null,
            previous_cursor: null,
          },
        },
      }),
    });
    await area.saveRecipient(recipient());
    expect(
      standin.seen.some(
        (r) => r.method === 'POST' && r.path === '/counterparties',
      ),
    ).toBe(false);
  });

  it('adopts the payment detail Nuvion already holds when an account number repeats', async () => {
    standin.on('POST', '/payment-details', {
      status: 409,
      body: errorBody(
        'error_duplicate_resource',
        'A record with this account number already exists.',
      ),
    });
    standin.on('GET', '/counterparties', {
      status: 200,
      body: envelope({
        data: [{ id: '01M5OLDCOUNTERPARTY00000001' }],
        meta: {
          pagination: {
            order: 'desc',
            has_next: false,
            limit: 100,
            has_previous: false,
            next_cursor: null,
            previous_cursor: null,
          },
        },
      }),
    });
    standin.on(
      'GET',
      '/counterparties/01M5OLDCOUNTERPARTY00000001/payment-details',
      {
        status: 200,
        body: envelope({
          data: [
            {
              id: '01M5OLDDETAIL0000000000001',
              account_number: '0123456789',
              currency: 'GHS',
            },
          ],
          meta: {
            pagination: {
              order: 'desc',
              has_next: false,
              limit: 100,
              has_previous: false,
              next_cursor: null,
              previous_cursor: null,
            },
          },
        }),
      },
    );
    const saved = await area.saveRecipient(recipient({ marker: 'marker-2' }));
    expect(saved.paymentDetailId).toBe('01M5OLDDETAIL0000000000001');
  });

  it('stops when the sender has no address on file, before any counterparty', async () => {
    standin.on('GET', `/entities/${ENTITY}`, {
      status: 200,
      body: envelope({
        person: { email: 'sender@example.com' },
        entity: { id: ENTITY },
      }),
    });
    await expect(area.saveRecipient(recipient())).rejects.toMatchObject({
      reason: 'declined',
    });
    expect(standin.seen.some((r) => r.method === 'POST')).toBe(false);
  });

  it('asks the directory once an hour', async () => {
    let now = 5_000_000;
    const fresh = new NuvionAbroadArea(
      new NuvionClient(standin.settings(), 'test-key'),
      () => now,
    );
    await fresh.banks('GH');
    await fresh.banks('GH');
    expect(
      standin.seen.filter((r) => r.path === '/bank-codes/GH'),
    ).toHaveLength(1);
    now += 61 * 60_000;
    await fresh.banks('GH');
    expect(
      standin.seen.filter((r) => r.path === '/bank-codes/GH'),
    ).toHaveLength(2);
  });
});

describe('states', () => {
  it("reads dev's own words", () => {
    expect(abroadState('new')).toBe('pending');
    expect(abroadState('PENDING')).toBe('pending');
    expect(abroadState('processing')).toBe('pending');
    expect(abroadState('successful')).toBe('completed');
    expect(abroadState('failed')).toBe('failed');
    expect(abroadState('reversed')).toBe('reversed');
    expect(abroadState('mystery')).toBeNull();
  });
});
