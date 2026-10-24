import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { WalletProviderCapitalError } from '../../wallet-provider/wallet-provider-capital';
import { nuvionWalletId } from '../areas/accounts';
import {
  NuvionCapitalArea,
  plainDescription,
  readCapitalOrder,
  readCapitalProduct,
} from '../areas/capital';
import { NuvionClient } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';

/**
 * NUV-12 without a database: the capital readers and the capital area
 * against the Nuvion stand-in over a real socket, answering as Nuvion's dev
 * did on 24 Oct 2026 (mobile docs/nuvion/DEV-RESULTS.md, "Capital"): a
 * product list with a kind the docs do not name, an order reserved,
 * confirmed (a second confirm answered 400), read, previewed and withdrawn.
 * No Nuvion host is reached (outbound-guard.ts).
 */

const ENTITY = '01M5CHILDENTITY00000000AA';
const ACCOUNT = '01M5CHILDACCOUNT00000000A';
const WALLET = { walletId: nuvionWalletId(ENTITY, ACCOUNT) };
const FR = '01KZV6JWN834F6VN585G0K1C4B';
const ORDER = '01M5PXZS9NNCB3FY0YCNSEGJ4S';

const frProduct = {
  id: FR,
  capital_product_type: 'FIXED_RETURN',
  is_external: false,
  name: '90 Days Treasury Bills',
  description:
    '<p>A government issued &amp; backed instrument</p><ul><li>90 days</li></ul>',
  currency: 'NGN',
  start_date: null,
  end_date: null,
  config: {
    principal: { min: 5000, max: 100000000, bands: [] },
    documents: [
      {
        name: 'Terms & Conditions.pdf',
        url: 'https://cdn.example.test/terms.pdf',
      },
    ],
    tenor: { tenor_days: 90 },
    rates: {
      interest: { primary: 0.3, bands: [] },
      deductibles: [
        {
          name: 'Withholding Tax',
          value: 0.1,
          value_type: 'percentage',
          applicable_to: 'interest',
        },
      ],
    },
    orders: { liquidation: { allow_early_withdrawal: true } },
  },
};

const soProduct = {
  id: '01M2N7JHTD727DGZ5D8CDVC6JX',
  capital_product_type: 'SHARE_OFFERING',
  is_external: false,
  name: 'Dangote IPO SPV',
  description: '<p>Shares</p>',
  currency: 'NGN',
  start_date: 1789516800000,
  end_date: 1792886400000,
  config: {
    principal: { min: 200, max: 1000000000000, bands: [] },
    share_offering: {
      issuer_name: 'Dangote Refinery',
      offer_price: 100,
      lock_period_days: 0,
      prospectus_url: 'app.nuvion.co',
      offer_stage: 'ipo',
    },
    rates: {
      deductibles: [
        {
          name: 'Cross-Deal Fee',
          value: 0.01,
          value_type: 'percentage',
          applicable_to: 'principal',
        },
      ],
    },
  },
  availability: {
    status: 'available',
    quantity: null,
    orderable: false,
    reason: 'sale_window_closed',
  },
};

const privateEquity = {
  id: '01M0BQJQ1MGWNY6M86087DA4NH',
  capital_product_type: 'PRIVATE_EQUITY',
  name: 'Expiry Test Product',
  currency: 'NGN',
  config: {},
};

const usd = { ...frProduct, id: '01KY7C9R29S2YCSXDV255TM0ZG', currency: 'USD' };

const account = {
  id: '01M5PY0BFBJKQY489N64K4HZD1',
  product_order_id: ORDER,
  product_id: FR,
  product_type: 'FIXED_RETURN',
  currency: 'NGN',
  account_number: '0011874002',
  principal: 5000,
  locked_rate: 0.3,
  day_count: 365,
  tenor_days: 90,
  start_date: 1792844769231,
  maturity_date: 1800594000000,
  early_action_date: 1792844769231,
  accrued_interest: 0,
  due_interest: 333,
  expected_net_payout: 5333,
  total_deductions: 36,
  gross_interest: 369,
  expected_gross_payout: 5369,
  net_payout: null,
  settlement_date: null,
  lifecycle: { status: 'ACTIVE', payout_status: null },
};

const order = (status: string, acct: unknown = null) => ({
  id: ORDER,
  entity_id: ENTITY,
  reference: '01M5PXZS7ECVDPRFKTRYCQAV8V',
  product_id: FR,
  funding_account_id: ACCOUNT,
  product_type: 'FIXED_RETURN',
  currency: 'NGN',
  amount: 5000,
  reserved_quantity: null,
  status,
  status_reason: null,
  expires_at: 1792845652180,
  confirmed_at: acct ? 1792844769231 : null,
  created: 1792844752181,
  capital_account: acct,
  agreements: [
    {
      document: {
        name: 'Terms & Conditions.pdf',
        url: 'https://cdn.example.test/terms.pdf',
        content: null,
      },
      affirmations: [
        { action_type: 'affirmation', actioned_at: 1792844751830 },
      ],
    },
  ],
});

const ok = (data: unknown) => ({
  status: 200,
  body: { status: 'success', message: 'ok', data },
});
const err = (status: number, type: string) => ({
  status,
  body: { status: 'error', message: 'No.', type },
});

describe('NUV-12: the Capital area', () => {
  const standin = new NuvionStandin();
  let guard: OutboundGuard;
  let area: NuvionCapitalArea;

  beforeAll(async () => {
    guard = guardOutbound();
    await standin.start();
    const client = new NuvionClient(
      standin.settings(),
      'nv_test_sk_NUV12capitalKEY0000000000',
    );
    area = new NuvionCapitalArea(client);
  });
  afterAll(async () => {
    await standin.stop();
    guard.restore();
  });
  afterEach(() => {
    expect(guard.violations).toEqual([]);
  });

  it('reads a product with its terms, strips the markup, and leaves out a kind it does not serve', () => {
    const p = readCapitalProduct(frProduct)!;
    expect(p).toMatchObject({
      type: 'FIXED_RETURN',
      minMinor: 5000,
      maxMinor: 100000000,
      tenorDays: 90,
      annualRate: 0.3,
      allowEarlyWithdrawal: true,
    });
    expect(p.description).toBe(
      'A government issued & backed instrument\n- 90 days',
    );
    expect(p.documents).toEqual([
      {
        name: 'Terms & Conditions.pdf',
        url: 'https://cdn.example.test/terms.pdf',
      },
    ]);
    expect(p.deductibles[0]).toMatchObject({
      name: 'Withholding Tax',
      value: 0.1,
    });
    expect(readCapitalProduct(privateEquity)).toBeNull();
    const so = readCapitalProduct(soProduct)!;
    expect(so.share).toMatchObject({
      issuerName: 'Dangote Refinery',
      offerPriceMinor: 100,
    });
    expect(so.availability).toMatchObject({
      orderable: false,
      reason: 'sale_window_closed',
    });
    expect(plainDescription(null)).toBe('');
  });

  it('lists only naira products and passes the filters on', async () => {
    standin.on('GET', '/products', (req) => {
      expect(req.query.entity_id).toBe(ENTITY);
      expect(req.query.currency).toBe('NGN');
      return ok({
        data: [frProduct, usd, privateEquity, soProduct],
        meta: {
          pagination: {
            has_next: true,
            next_cursor: '01CURSOR0000000000000000AB',
            limit: 25,
          },
        },
      });
    });
    const page = await area.listProducts(WALLET, {});
    expect(page.items.map((p) => p.id)).toEqual([FR, soProduct.id]);
    expect(page.nextCursor).toBe('01CURSOR0000000000000000AB');
    const none = await area.listProducts(WALLET, { currency: 'USD' });
    expect(none.items).toEqual([]);
  });

  it('reserves with every document affirmed by its exact name, and reads the quote', async () => {
    standin.on('GET', `/products/${FR}`, ok(frProduct));
    standin.on('POST', '/product-orders', (req) => {
      expect(req.body).toMatchObject({
        product_id: FR,
        account_id: ACCOUNT,
        entity_id: ENTITY,
        principal: 5000,
        lock_investment: false,
        agreement_acceptances: [
          {
            document_name: 'Terms & Conditions.pdf',
            action_type: 'affirmation',
          },
        ],
      });
      expect(req.body).not.toHaveProperty('amount');
      return {
        status: 201,
        body: {
          status: 'success',
          message: 'ok',
          data: {
            id: ORDER,
            entity_id: ENTITY,
            status: 'RESERVED',
            expires_at: 1792845652180,
            currency: 'NGN',
            quote: {
              product_id: FR,
              product_type: 'FIXED_RETURN',
              currency: 'NGN',
              principal: 5000,
              total_debit: 5000,
              tenor_days: 90,
              locked_rate: 0.3,
              rate_source: 'primary',
              day_count: 365,
              is_locked: false,
              allow_early_withdrawal: true,
              earliest_withdrawal_days: null,
              penalty: { primary: 0.15 },
              deductibles: frProduct.config.rates.deductibles,
            },
          },
        },
      };
    });
    const r = await area.reserve(WALLET, {
      productId: FR,
      type: 'FIXED_RETURN',
      amountMinor: 5000,
      lockInvestment: false,
    });
    expect(r.orderId).toBe(ORDER);
    expect(r.quote).toMatchObject({
      totalDebitMinor: 5000,
      lockedRate: 0.3,
      penaltyRate: 0.15,
    });
    expect(r.expiresAt).toBe(new Date(1792845652180).toISOString());
  });

  it('a second confirm and a withdrawal of a closed holding come back as refusals in the seam words', async () => {
    standin.on(
      'POST',
      `/product-orders/${ORDER}/confirm`,
      err(400, 'error_operation_invalid_for_state'),
    );
    await expect(area.confirm(WALLET, ORDER)).rejects.toMatchObject({
      refusal: 'reservation_expired',
    });
    standin.on(
      'POST',
      `/product-orders/${ORDER}/withdrawal`,
      err(400, 'error_operation_invalid_for_state'),
    );
    await expect(area.withdraw(WALLET, ORDER)).rejects.toBeInstanceOf(
      WalletProviderCapitalError,
    );
    standin.on(
      'POST',
      `/product-orders/${ORDER}/confirm`,
      err(410, 'error_resource_expired'),
    );
    await expect(area.confirm(WALLET, ORDER)).rejects.toMatchObject({
      refusal: 'reservation_expired',
    });
    standin.on(
      'POST',
      `/product-orders/${ORDER}/confirm`,
      err(409, 'error_transfer_already_processing'),
    );
    await expect(area.confirm(WALLET, ORDER)).rejects.toMatchObject({
      refusal: 'already_processing',
      kind: 'outcome_unknown',
    });
    standin.on(
      'POST',
      `/product-orders/${ORDER}/confirm`,
      err(400, 'error_transfer_insufficient_funds'),
    );
    await expect(area.confirm(WALLET, ORDER)).rejects.toMatchObject({
      kind: 'insufficient_funds',
    });
  });

  it('confirms, then reads the order with its holding and the last four digits of its number only', async () => {
    standin.on(
      'POST',
      `/product-orders/${ORDER}/confirm`,
      ok({
        id: ORDER,
        entity_id: ENTITY,
        status: 'APPROVED',
        capital_account_id: account.id,
        user_capital_account_id: '01M5PY0AG25FT6T2XGFE0HTN97',
        transfer_reference: `capital-fixed-return:${ORDER}`,
      }),
    );
    const c = await area.confirm(WALLET, ORDER);
    expect(c).toMatchObject({
      status: 'APPROVED',
      capitalAccountId: account.id,
    });
    standin.on(
      'GET',
      `/product-orders/${ORDER}`,
      ok(order('APPROVED', account)),
    );
    const o = (await area.getOrder(WALLET, ORDER))!;
    expect(o.status).toBe('APPROVED');
    expect(o.account).toMatchObject({
      lifecycle: 'ACTIVE',
      numberLast4: '4002',
      lockedRate: 0.3,
      expectedNetPayoutMinor: 5333,
    });
    expect(JSON.stringify(o)).not.toContain('0011874002');
    expect(
      readCapitalOrder({
        ...order('APPROVED'),
        product_type: 'PRIVATE_EQUITY',
      }),
    ).toBeNull();
  });

  it('reads the portfolio, the transactions, the preview and the withdrawal as dev answered', async () => {
    standin.on(
      'GET',
      '/capital-portfolio',
      ok({
        currencies: [
          {
            currency: 'NGN',
            totals: {
              investment: {
                amount_invested: 5000,
                total_return: 0,
                current_value: 5000,
              },
            },
          },
          {
            currency: 'USD',
            totals: {
              investment: {
                amount_invested: 100,
                total_return: null,
                current_value: null,
              },
            },
          },
        ],
      }),
    );
    const lines = await area.portfolio(WALLET);
    expect(lines).toEqual([
      {
        currency: 'NGN',
        investedMinor: 5000,
        returnMinor: 0,
        valueMinor: 5000,
      },
      {
        currency: 'USD',
        investedMinor: 100,
        returnMinor: null,
        valueMinor: null,
      },
    ]);

    standin.on('GET', '/capital-transactions', (req) => {
      expect(req.query.capital_id).toBe(account.id);
      return ok({
        data: [
          {
            id: '01M5PY0BJNBANJ2SE8WWCV4GAH',
            event_type: 'PURCHASE',
            amount: 5000,
            accrual_date: null,
            created: 1792844770901,
          },
        ],
        meta: { pagination: { has_next: false, next_cursor: null } },
      });
    });
    const tx = await area.transactions(WALLET, account.id, {});
    expect(tx.items[0]).toMatchObject({
      eventType: 'PURCHASE',
      amountMinor: 5000,
    });
    expect(tx.nextCursor).toBeNull();

    standin.on(
      'GET',
      `/product-orders/${ORDER}/withdrawal/preview`,
      ok({
        id: account.id,
        gross_interest: 0,
        penalty_rate: 0.15,
        penalty_amount: 0,
        total_deductions: 0,
        net_payout: 5000,
        days_elapsed: 0,
      }),
    );
    expect(await area.withdrawalPreview(WALLET, ORDER)).toMatchObject({
      penaltyRate: 0.15,
      netPayoutMinor: 5000,
    });

    standin.on(
      'POST',
      `/product-orders/${ORDER}/withdrawal`,
      ok(
        order('APPROVED', {
          ...account,
          net_payout: 5000,
          lifecycle: { status: 'EARLY_LIQUIDATING', payout_status: 'pending' },
        }),
      ),
    );
    const w = await area.withdraw(WALLET, ORDER);
    expect(w.account).toMatchObject({
      lifecycle: 'EARLY_LIQUIDATING',
      payoutStatus: 'pending',
      netPayoutMinor: 5000,
    });
  });

  it('a preview before the order is confirmed is "not available", and an unknown product is null', async () => {
    standin.on(
      'GET',
      `/product-orders/${ORDER}/withdrawal/preview`,
      err(404, 'error_resource_not_found'),
    );
    await expect(area.withdrawalPreview(WALLET, ORDER)).rejects.toMatchObject({
      refusal: 'withdrawal_not_available',
    });
    standin.on('GET', `/products/${FR}`, err(404, 'error_resource_not_found'));
    expect(await area.getProduct(WALLET, FR)).toBeNull();
    await expect(
      area.getProduct({ walletId: 'not-a-nuvion-wallet' }, FR),
    ).rejects.toBeInstanceOf(NuvionError);
  });
});
