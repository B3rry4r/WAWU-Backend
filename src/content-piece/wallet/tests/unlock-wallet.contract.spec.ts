import { randomUUID } from 'node:crypto';
import {
  bootPayApp,
  PAY_PIN,
  type PayHarness,
  type PayPerson,
  STAND_IN_FEE_KOBO,
} from '../../../../test/payments/wallet-pay-harness';
import { body, until } from '../../../../test/payments/poll-helpers';
import { UnlockWalletModule } from '../unlock-wallet.module';
import type {
  UnlockWalletQuoteView,
  UnlockWalletView,
} from '../unlock-wallet-view.type';

/**
 * HOME-15 on the wallet provider seam with NUVION stood in: a piece unlocked
 * from the wallet with the PIN, access given once the debit settles, the
 * creator's 85% landing in their wallet by itself (R-11), and the attacks a
 * money path has to survive. After each, the ledger agrees with the stand-in.
 * No Nuvion, Fintava or wawuafrica.com host is called.
 */

jest.setTimeout(180_000);

const PRICE_NAIRA = 2500;
const PRICE = PRICE_NAIRA * 100;
const SHARE = 212_500; // 85% of ₦2,500 (R-5)
const FEE = STAND_IN_FEE_KOBO;
const RICH = 5_000_000;

describe('Unlock content from the wallet (HOME-15), Nuvion stood in', () => {
  let h: PayHarness;
  const pieces: string[] = [];

  beforeAll(async () => {
    h = await bootPayApp('h15', {
      modules: [UnlockWalletModule],
      cleanup: async (prisma, users) => {
        await prisma.notification.deleteMany({
          where: { userWawuId: { in: users } },
        });
        await prisma.purchase.deleteMany({
          where: {
            OR: [
              { buyerWawuId: { in: users } },
              { creatorWawuId: { in: users } },
            ],
          },
        });
        await prisma.contentPiece.deleteMany({ where: { id: { in: pieces } } });
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.nuvion.mode = 'successful';
  });

  async function piece(
    creator: PayPerson,
    o: { accessType?: 'free' | 'paid'; status?: 'live' | 'removed' } = {},
  ): Promise<string> {
    const id = randomUUID();
    await h.prisma.contentPiece.create({
      data: {
        id,
        slug: `unlock-${id}`,
        creatorWawuId: creator.id,
        contentType: 'video',
        title: 'How I light a night shoot',
        description: 'A lesson',
        category: 'Film',
        accessType: o.accessType ?? 'paid',
        price: PRICE_NAIRA,
        previewAssetUrl: 'https://example.invalid/preview.mp4',
        fullAssetUrl: null,
        status: o.status ?? 'live',
      },
    });
    pieces.push(id);
    return id;
  }

  async function quoted(
    p: PayPerson,
    contentId: string,
  ): Promise<UnlockWalletQuoteView> {
    const res = await h.get(p, `/content/${contentId}/unlock/wallet/quote`);
    expect(res.status).toBe(200);
    return body<UnlockWalletQuoteView>(res).data!;
  }
  const request = (q: UnlockWalletQuoteView) => ({
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  const unlockUrl = (contentId: string) => `/content/${contentId}/unlock/wallet`;
  const grants = (contentId: string) =>
    h.prisma.purchase.findMany({ where: { contentId, type: 'content' } });
  const balance = (p: PayPerson) =>
    h.nuvion.accounts.get(p.account!.accountId)!.availableKobo;
  const code = (res: { body: unknown }) =>
    (res.body as { reason?: { code?: string } }).reason?.code;

  it('H14 to H18: ₦2,500 costs ₦2,500 plus the charge once, gives access, and the creator gets 85%', async () => {
    const payer = await h.person(RICH);
    const creator = await h.person(0);
    const id = await piece(creator);
    const q = await quoted(payer, id);
    expect(q).toMatchObject({
      contentId: id,
      priceKobo: PRICE,
      payment: {
        kind: 'content_unlock',
        priceKobo: PRICE,
        totalKobo: PRICE + FEE,
        fee: { providerFeeKobo: FEE, wawuFeeKobo: 0 },
        willBeHeld: false,
      },
    });
    const operationalBefore = h.nuvion.operational.availableKobo;
    const res = await h.post(payer, unlockUrl(id), request(q));
    expect(res.status).toBe(201);
    const unlock = body<UnlockWalletView>(res).data!;
    expect(unlock).toMatchObject({
      status: 'paid',
      purchased: true,
      contentId: id,
      priceKobo: PRICE,
      payment: { kind: 'content_unlock', status: 'completed', delivered: true },
    });
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(balance(payer)).toBe(BigInt(RICH - PRICE - FEE));
    const rows = await grants(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buyerWawuId: payer.id,
      creatorWawuId: creator.id,
      amount: PRICE_NAIRA,
      status: 'completed',
      flutterwaveTxRef: `wallet:${unlock.id}`,
    });

    await until(async () => {
      await h.pass();
      return balance(creator) === BigInt(SHARE);
    }, "the creator's 85% to land");
    expect(h.nuvion.operational.availableKobo - operationalBefore).toBe(
      BigInt(PRICE - SHARE - FEE),
    );
    await h.expectLedgerEqualsStandIn([payer, creator]);
    expect(h.fintavaHits).toEqual([]);

    // Owning it, the piece cannot be bought again.
    const again = await h.get(payer, `${unlockUrl(id)}/quote`);
    expect(again.status).toBe(409);
    expect(code(again)).toBe('target_not_payable');
  });

  it('the same request twice debits once and answers the first result again', async () => {
    const payer = await h.person(RICH);
    const creator = await h.person(0);
    const id = await piece(creator);
    const q = await quoted(payer, id);
    const key = randomUUID();
    const first = await h.post(payer, unlockUrl(id), request(q), { key });
    expect(first.status).toBe(201);
    const second = await h.post(payer, unlockUrl(id), request(q), {
      key,
      pin: '0000',
    });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(await grants(id)).toHaveLength(1);
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('twice in parallel, with one key or two, takes the money once', async () => {
    const creator = await h.person(0);
    const id = await piece(creator);

    const payer = await h.person(RICH);
    const q = await quoted(payer, id);
    const key = randomUUID();
    const both = await Promise.all([
      h.post(payer, unlockUrl(id), request(q), { key }),
      h.post(payer, unlockUrl(id), request(q), { key }),
    ]);
    expect(both.some((r) => r.status === 201)).toBe(true);
    expect(both.every((r) => r.status < 500)).toBe(true);
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(await grants(id)).toHaveLength(1);
    await h.expectLedgerEqualsStandIn([payer]);

    const payer2 = await h.person(RICH);
    const q2 = await quoted(payer2, id);
    h.nuvion.mode = 'pending';
    const two = await Promise.all([
      h.post(payer2, unlockUrl(id), request(q2)),
      h.post(payer2, unlockUrl(id), request(q2)),
    ]);
    expect(h.sendsFrom(payer2)).toHaveLength(1);
    expect(two.filter((r) => r.status === 201)).toHaveLength(1);
    expect(two.map(code).filter((c) => c === 'payment_in_progress')).toHaveLength(1);
    h.nuvion.settle(h.sendsFrom(payer2)[0].request.unique_reference, 'successful');
    await until(async () => {
      await h.pass();
      return (await grants(id)).length === 2;
    }, 'the second buyer to get access');
    await h.expectLedgerEqualsStandIn([payer, payer2]);
  });

  it('a wrong PIN moves nothing and gives nothing', async () => {
    const payer = await h.person(RICH);
    const creator = await h.person(0);
    const id = await piece(creator);
    const q = await quoted(payer, id);
    const res = await h.post(payer, unlockUrl(id), request(q), { pin: '1111' });
    expect(res.status).toBe(403);
    expect(code(res)).toBe('pin_incorrect');
    expect(h.sendsFrom(payer)).toHaveLength(0);
    expect(await grants(id)).toHaveLength(0);
    expect(balance(payer)).toBe(BigInt(RICH));
    const ok = await h.post(payer, unlockUrl(id), request(q), { pin: PAY_PIN });
    expect(ok.status).toBe(201);
    expect(await grants(id)).toHaveLength(1);
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('a short balance is refused with the shortfall and moves nothing', async () => {
    const payer = await h.person(200_000);
    const creator = await h.person(0);
    const id = await piece(creator);
    const q = await quoted(payer, id);
    expect(q.payment.shortfallKobo).toBe(PRICE + FEE - 200_000);
    const res = await h.post(payer, unlockUrl(id), request(q));
    expect(res.status).toBe(402);
    expect(code(res)).toBe('insufficient_funds');
    expect(h.sendsFrom(payer)).toHaveLength(0);
    expect(await grants(id)).toHaveLength(0);
    expect(balance(payer)).toBe(200_000n);
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('a lost provider answer, then a retry, takes the money once and gives access once', async () => {
    const payer = await h.person(RICH);
    const creator = await h.person(0);
    const id = await piece(creator);
    const q = await quoted(payer, id);
    const key = randomUUID();
    h.nuvion.mode = 'timeout';
    const first = await h.post(payer, unlockUrl(id), request(q), { key });
    expect(first.status).toBe(201);
    const pending = body<UnlockWalletView>(first).data!;
    expect(pending).toMatchObject({ status: 'pending', purchased: false });
    expect(await grants(id)).toHaveLength(0);

    h.nuvion.mode = 'successful';
    const retry = await h.post(payer, unlockUrl(id), request(q), {
      key,
      pin: '0000',
    });
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(h.sendsFrom(payer)).toHaveLength(1);

    h.nuvion.settle(h.sendsFrom(payer)[0].request.unique_reference, 'successful');
    await until(async () => {
      await h.pass();
      return (await grants(id)).length === 1;
    }, 'access to be given');
    await h.pass();
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(await grants(id)).toHaveLength(1);
    const read = body<UnlockWalletView>(
      await h.get(payer, `${unlockUrl(id)}/${pending.id}`),
    ).data!;
    expect(read).toMatchObject({ status: 'paid', purchased: true });
    expect(balance(payer)).toBe(BigInt(RICH - PRICE - FEE));
    await h.expectLedgerEqualsStandIn([payer, creator]);
  });

  it('an unlock that cannot be granted is paid back: the price returns, the charge does not, no access and no earning', async () => {
    const payer = await h.person(RICH);
    const creator = await h.person(0);
    const id = await piece(creator);
    const q = await quoted(payer, id);
    h.nuvion.mode = 'pending';
    const res = await h.post(payer, unlockUrl(id), request(q));
    const pending = body<UnlockWalletView>(res).data!;
    expect(pending.status).toBe('pending');
    // The piece is taken down before the debit is confirmed.
    await h.prisma.contentPiece.update({
      where: { id },
      data: { status: 'removed' },
    });
    h.nuvion.settle(h.sendsFrom(payer)[0].request.unique_reference, 'successful');
    h.nuvion.mode = 'successful';
    await until(async () => {
      await h.pass();
      const hold = await h.prisma.walletHold.findUnique({
        where: { paymentId: pending.id },
      });
      return hold?.status === 'refunded';
    }, 'the unlock to be paid back');
    await h.pass();

    expect(await grants(id)).toHaveLength(0);
    expect(
      await h.prisma.earningSettlement.count({ where: { paymentId: pending.id } }),
    ).toBe(0);
    expect(balance(payer)).toBe(BigInt(RICH - FEE));
    expect(balance(creator)).toBe(0n);
    const read = body<UnlockWalletView>(
      await h.get(payer, `${unlockUrl(id)}/${pending.id}`),
    ).data!;
    expect(read).toMatchObject({ status: 'refunded', purchased: false });
    await h.expectLedgerEqualsStandIn([payer, creator]);
  });

  it('refuses a free piece, your own, one that is gone, and one only another person can pay for', async () => {
    const payer = await h.person(RICH);
    const creator = await h.person(0);
    const free = await piece(creator, { accessType: 'free' });
    expect((await h.get(payer, `${unlockUrl(free)}/quote`)).status).toBe(409);
    const mine = await piece(payer);
    expect((await h.get(payer, `${unlockUrl(mine)}/quote`)).status).toBe(409);
    const gone = await piece(creator, { status: 'removed' });
    expect((await h.get(payer, `${unlockUrl(gone)}/quote`)).status).toBe(404);
    expect(
      (await h.get(payer, `${unlockUrl(randomUUID())}/quote`)).status,
    ).toBe(404);
    const live = await piece(creator);
    const other = await h.person(RICH);
    const q = await quoted(other, live);
    const ok = await h.post(other, unlockUrl(live), request(q));
    const unlock = body<UnlockWalletView>(ok).data!;
    // Someone else's purchase is not readable.
    expect((await h.get(payer, `${unlockUrl(live)}/${unlock.id}`)).status).toBe(404);
  });
});
