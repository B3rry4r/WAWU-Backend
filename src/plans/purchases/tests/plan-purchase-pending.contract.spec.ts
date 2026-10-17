import request from 'supertest';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { loadPlansConfig, priceIn } from '../../plans-config';
import type {
  PendingPlanPurchaseView,
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from '../plan-purchase-view.type';

/**
 * ME-13 (M15): the purchase still going through, read after the app is opened
 * again. `GET /plans/purchases/pending` answers the same view the id route
 * answers while a payment is still confirming, and `purchase: null` when
 * nothing is going through (nothing bought, or the plan was granted). It is
 * the caller's own: nobody reads another person's.
 */

jest.setTimeout(120_000);

const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const RICH = 100 * priceIn(byPrice[byPrice.length - 1].price, 'NGN');

describe('The purchase still going through (ME-13, M15)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootTierApp('me13p');
    call = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  const pendingOf = (p: Person): Promise<Response> =>
    request(h.app.getHttpServer())
      .get('/api/hub/plans/purchases/pending')
      .set('Authorization', p.auth);

  /** Pays for the smallest tier while the provider does not answer: the payment stays `pending`. */
  const payUnconfirmed = async (p: Person): Promise<PlanPurchaseView> => {
    const q = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'tier', tierId: small.id }),
    ).data!;
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, {
      kind: 'tier',
      tierId: small.id,
      method: 'wallet',
      expectedTotalKobo: q.payment.totalKobo,
      quoteToken: q.payment.quoteToken,
    });
    h.wallets.mode = 'live';
    return body<PlanPurchaseView>(res).data!;
  };

  it('is null for a person who has bought nothing', async () => {
    const p = await h.buyer(RICH);
    const res = await pendingOf(p);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(body<PendingPlanPurchaseView>(res).data).toEqual({ purchase: null });
  });

  it('is refused without a sign-in', async () => {
    const res = await request(h.app.getHttpServer()).get(
      '/api/hub/plans/purchases/pending',
    );
    expect(res.status).toBe(401);
  });

  it('names the payment that is still confirming, the same one the id route reads, and is null once the plan is granted', async () => {
    const p = await h.buyer(RICH);
    const bought = await payUnconfirmed(p);
    expect(bought.status).toBe('pending');

    const open = body<PendingPlanPurchaseView>(await pendingOf(p)).data!;
    expect(open.purchase).not.toBeNull();
    expect(open.purchase).toMatchObject({
      id: bought.id,
      kind: 'tier',
      tierId: small.id,
      status: 'pending',
      grant: null,
      paidAt: null,
    });
    const same = body<PlanPurchaseView>(await call.read(p, bought.id)).data!;
    expect(open.purchase).toEqual(same);

    await h.sweepLater();
    const done = body<PlanPurchaseView>(await call.read(p, bought.id)).data!;
    expect(done.status).toBe('paid');
    expect(body<PendingPlanPurchaseView>(await pendingOf(p)).data).toEqual({
      purchase: null,
    });
  });

  it('never shows another person a payment that is not theirs', async () => {
    const buyer = await h.buyer(RICH);
    const other = await h.buyer(RICH);
    const bought = await payUnconfirmed(buyer);
    expect(bought.status).toBe('pending');
    expect(body<PendingPlanPurchaseView>(await pendingOf(other)).data).toEqual({
      purchase: null,
    });
    expect(
      body<PendingPlanPurchaseView>(await pendingOf(buyer)).data!.purchase?.id,
    ).toBe(bought.id);
  });
});
