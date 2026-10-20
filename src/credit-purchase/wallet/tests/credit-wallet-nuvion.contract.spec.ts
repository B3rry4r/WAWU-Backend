import { randomUUID } from 'node:crypto';
import {
  bootCreditApp,
  type CreditHarness,
  creditApi,
} from '../../../../test/credits/credit-wallet-harness';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import { body, until } from '../../../../test/payments/poll-helpers';
import type { Person } from '../../../../test/plans/tier-purchase-harness';
import type { CreditsState } from '../../../common/types';
import type {
  CreditWalletPurchaseView,
  CreditWalletQuoteView,
} from '../credit-wallet-view.type';

/**
 * INBOX-16 on the wallet provider seam with NUVION stood in: the same pack,
 * paid as a book transfer into WAWU's operational account, with Nuvion's
 * documented first answer (`pending`, settled later). Nothing here names a
 * provider: the credit module reaches the wallet only through MONEY-17. No
 * Nuvion, Fintava or wawuafrica.com host is called. NUVION_FEE is a spec
 * value, not a fact about Nuvion; the owner fills the real settings (NUV-10).
 */

jest.setTimeout(120_000);

const NUVION_FEE = 2325;
const RICH = 50_000_000;

describe('Buy WAWU Credits from the wallet (INBOX-16), Nuvion stood in', () => {
  const nuvion = new NuvionSeamStandIn();
  let h: CreditHarness;
  let call: ReturnType<typeof creditApi>;

  beforeAll(async () => {
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    h = await bootCreditApp('i16n', { nuvion, nuvionFeeKobo: NUVION_FEE });
    call = creditApi(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    nuvion.mode = 'successful';
  });

  async function quoted(
    p: Person,
    pack: string,
  ): Promise<CreditWalletQuoteView> {
    const res = await call.quote(p, pack);
    expect(res.status).toBe(200);
    return body<CreditWalletQuoteView>(res).data!;
  }
  const request = (pack: string, q: CreditWalletQuoteView) => ({
    pack,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account!.accountId);
  const countOf = async (p: Person) =>
    body<CreditsState>(await call.credits(p)).data!.creditBalance;
  const lotsOf = (p: Person) =>
    h.prisma.creditLot.count({ where: { userWawuId: p.id } });

  it('buys a pack as one book transfer of its price into the operational account, and adds the credits', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p, 'popular');
    expect(q.payment).toMatchObject({
      priceKobo: 100_000,
      totalKobo: 100_000 + NUVION_FEE,
      fee: { providerFeeKobo: NUVION_FEE, wawuFeeKobo: 0 },
    });
    const res = await call.buy(p, request('popular', q));
    expect(res.status).toBe(201);
    expect(body<CreditWalletPurchaseView>(res).data!).toMatchObject({
      status: 'paid',
      credits: 120,
      creditBalance: 120,
      payment: { kind: 'credit_pack', status: 'completed', delivered: true },
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0]).toMatchObject({
      amountKobo: 100_000n,
      feeKobo: BigInt(NUVION_FEE),
      toAccountId: nuvion.operational.accountId,
    });
    expect(p.account!.availableKobo).toBe(BigInt(RICH - 100_000 - NUVION_FEE));
    expect(await countOf(p)).toBe(120);
    expect(await lotsOf(p)).toBe(1);
  });

  it('the same request twice debits once; a payment Nuvion first calls pending adds no credits until it is successful, then once', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p, 'popular');
    nuvion.mode = 'pending';
    const key = randomUUID();
    const first = await call.buy(p, request('popular', q), { key });
    expect(first.status).toBe(201);
    const pending = body<CreditWalletPurchaseView>(first).data!;
    expect(pending).toMatchObject({ status: 'pending', creditBalance: null });
    expect(await countOf(p)).toBe(0);

    const second = await call.buy(p, request('popular', q), {
      key,
      pin: '0000',
    });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(sendsFrom(p)).toHaveLength(1);

    nuvion.settle(pending.payment.reference, 'successful');
    await until(async () => {
      await h.sweepLater();
      return (await lotsOf(p)) === 1;
    }, 'the credits to be added');
    await h.sweepLater();
    const paid = body<CreditWalletPurchaseView>(
      await call.read(p, pending.id),
    ).data!;
    expect(paid).toMatchObject({
      status: 'paid',
      creditBalance: 120,
      payment: { delivered: true },
    });
    expect(await countOf(p)).toBe(120);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('a payment Nuvion later fails or reverses adds no credits', async () => {
    for (const word of ['failed', 'reversed'] as const) {
      const p = await h.buyer(RICH);
      const q = await quoted(p, 'starter');
      nuvion.mode = 'pending';
      const res = await call.buy(p, request('starter', q));
      const pending = body<CreditWalletPurchaseView>(res).data!;
      nuvion.settle(pending.payment.reference, word);
      await until(async () => {
        await h.sweepLater();
        return (
          body<CreditWalletPurchaseView>(await call.read(p, pending.id)).data!
            .status === word
        );
      }, `the purchase to read ${word}`);
      expect(await countOf(p)).toBe(0);
      expect(await lotsOf(p)).toBe(0);
    }
  });
});
