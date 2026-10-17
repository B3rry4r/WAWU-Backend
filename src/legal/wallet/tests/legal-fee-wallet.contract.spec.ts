import { randomUUID } from 'node:crypto';
import {
  bootPayApp,
  PAY_PIN,
  type PayHarness,
  type PayPerson,
  STAND_IN_FEE_KOBO,
} from '../../../../test/payments/wallet-pay-harness';
import { body, until } from '../../../../test/payments/poll-helpers';
import { LegalFeeWalletModule } from '../legal-fee-wallet.module';
import type {
  LegalFeeWalletQuoteView,
  LegalFeeWalletView,
} from '../legal-fee-wallet-view.type';

/**
 * LEGAL-05 on the wallet provider seam with NUVION stood in: a consultation
 * fee and a service fee (a business name registration is one) paid from the
 * wallet with the PIN at the price on the request (R-14), and the attacks a
 * money path has to survive. After each, the ledger agrees with the stand-in.
 * No Nuvion, Fintava or wawuafrica.com host is called.
 */

jest.setTimeout(180_000);

const CONSULT_NAIRA = 15_000;
const CONSULT = CONSULT_NAIRA * 100;
const SERVICE_NAIRA = 50_000;
const SERVICE = SERVICE_NAIRA * 100;
const FEE = STAND_IN_FEE_KOBO;
const RICH = 20_000_000;

describe('Pay a legal fee from the wallet (LEGAL-05), Nuvion stood in', () => {
  let h: PayHarness;
  const requests: string[] = [];

  beforeAll(async () => {
    h = await bootPayApp('l05', {
      modules: [LegalFeeWalletModule],
      cleanup: async (prisma) => {
        await prisma.legalRequest.deleteMany({
          where: { id: { in: requests } },
        });
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.nuvion.mode = 'successful';
  });

  /** A consultation request with an hour booked and the fee recorded, awaiting payment. */
  async function consultation(
    p: PayPerson,
    o: { fee?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    await h.prisma.legalRequest.create({
      data: {
        id,
        wawuUserId: p.id,
        serviceCode: 'lawyer-consult',
        serviceName: 'Legal consultation',
        category: 'consultation',
        path: 'consultation',
        status: 'awaiting_consultation_payment',
        consultationMedium: 'zoom',
        consultationFee: o.fee ?? CONSULT_NAIRA,
        consultationMinutes: 30,
        scheduledFor: new Date(Date.now() + 3 * 86_400_000),
      },
    });
    requests.push(id);
    return id;
  }

  /** A quoted request whose engagement letter is signed (a business name registration, say). */
  async function service(p: PayPerson, signed = true): Promise<string> {
    const id = randomUUID();
    await h.prisma.legalRequest.create({
      data: {
        id,
        wawuUserId: p.id,
        serviceCode: 'cac-business-name',
        serviceName: 'CAC business name registration',
        category: 'business',
        path: 'simple',
        status: signed ? 'contract_signed' : 'quoted',
        quoteAmount: SERVICE_NAIRA,
        contractSignedAt: signed ? new Date() : null,
      },
    });
    requests.push(id);
    return id;
  }

  const url = (id: string) => `/legal/requests/${id}/pay/wallet`;
  async function quoted(
    p: PayPerson,
    id: string,
  ): Promise<LegalFeeWalletQuoteView> {
    const res = await h.get(p, `${url(id)}/quote`);
    expect(res.status).toBe(200);
    return body<LegalFeeWalletQuoteView>(res).data!;
  }
  const request = (q: LegalFeeWalletQuoteView) => ({
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  const row = (id: string) =>
    h.prisma.legalRequest.findUniqueOrThrow({ where: { id } });
  const balance = (p: PayPerson) =>
    h.nuvion.accounts.get(p.account!.accountId)!.availableKobo;
  const code = (res: { body: unknown }) =>
    (res.body as { reason?: { code?: string } }).reason?.code;

  it('S19: a consultation costs the fee on the request plus the charge once, and the request moves on', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer);
    const q = await quoted(payer, id);
    expect(q).toMatchObject({
      requestId: id,
      stage: 'consultation',
      priceKobo: CONSULT,
      payment: {
        kind: 'legal_fee',
        priceKobo: CONSULT,
        totalKobo: CONSULT + FEE,
        fee: { providerFeeKobo: FEE, wawuFeeKobo: 0 },
        willBeHeld: false,
      },
    });
    const res = await h.post(payer, url(id), request(q));
    expect(res.status).toBe(201);
    const paid = body<LegalFeeWalletView>(res).data!;
    expect(paid).toMatchObject({
      status: 'paid',
      stage: 'consultation',
      requestStatus: 'consultation_scheduled',
      payment: { kind: 'legal_fee', status: 'completed', delivered: true },
    });
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(h.sendsFrom(payer)[0]).toMatchObject({
      amountKobo: BigInt(CONSULT),
      feeKobo: BigInt(FEE),
      toAccountId: h.nuvion.operational.accountId,
    });
    expect(balance(payer)).toBe(BigInt(RICH - CONSULT - FEE));
    const r = await row(id);
    expect(r).toMatchObject({
      status: 'consultation_scheduled',
      consultationTxRef: `wallet:${paid.id}`,
    });
    expect(r.consultationPaidAt).not.toBeNull();
    // WAWU's own sale: no payee, so no earning and nothing held.
    expect(
      await h.prisma.earningSettlement.count({ where: { paymentId: paid.id } }),
    ).toBe(0);
    await h.pass();
    await h.expectLedgerEqualsStandIn([payer]);
    expect(h.fintavaHits).toEqual([]);
    // Paid, nothing more is due.
    expect((await h.get(payer, `${url(id)}/quote`)).status).toBe(409);
  });

  it('S22 and S26: the quoted fee for the work is payable only once the engagement letter is signed', async () => {
    const payer = await h.person(RICH);
    const unsigned = await service(payer, false);
    const early = await h.get(payer, `${url(unsigned)}/quote`);
    expect(early.status).toBe(409);
    expect(code(early)).toBe('target_not_payable');

    const id = await service(payer);
    const q = await quoted(payer, id);
    expect(q).toMatchObject({
      stage: 'service',
      priceKobo: SERVICE,
      payment: { priceKobo: SERVICE, totalKobo: SERVICE + FEE },
    });
    const res = await h.post(payer, url(id), request(q));
    expect(res.status).toBe(201);
    expect(body<LegalFeeWalletView>(res).data!).toMatchObject({
      status: 'paid',
      stage: 'service',
      requestStatus: 'in_progress',
    });
    const r = await row(id);
    expect(r.servicePaidAt).not.toBeNull();
    expect(r.serviceTxRef).toMatch(/^wallet:/);
    expect(balance(payer)).toBe(BigInt(RICH - SERVICE - FEE));
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('the price is the one on the request when quoted: a fee that changed since is a changed quote and charges nothing', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer);
    const q = await quoted(payer, id);
    await h.prisma.legalRequest.update({
      where: { id },
      data: { consultationFee: CONSULT_NAIRA + 5000 },
    });
    const res = await h.post(payer, url(id), request(q));
    expect(res.status).toBe(409);
    expect(code(res)).toBe('quote_changed');
    expect(h.sendsFrom(payer)).toHaveLength(0);
    expect((await row(id)).consultationPaidAt).toBeNull();
    // The new quote carries the new price.
    const again = await quoted(payer, id);
    expect(again.priceKobo).toBe((CONSULT_NAIRA + 5000) * 100);
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('the same request twice debits once and answers the first result again', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer);
    const q = await quoted(payer, id);
    const key = randomUUID();
    const first = await h.post(payer, url(id), request(q), { key });
    expect(first.status).toBe(201);
    const second = await h.post(payer, url(id), request(q), {
      key,
      pin: '0000',
    });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(balance(payer)).toBe(BigInt(RICH - CONSULT - FEE));
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('twice in parallel, with one key or two, takes the money once', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer);
    const q = await quoted(payer, id);
    const key = randomUUID();
    const both = await Promise.all([
      h.post(payer, url(id), request(q), { key }),
      h.post(payer, url(id), request(q), { key }),
    ]);
    expect(both.some((r) => r.status === 201)).toBe(true);
    expect(both.every((r) => r.status < 500)).toBe(true);
    expect(h.sendsFrom(payer)).toHaveLength(1);
    await h.expectLedgerEqualsStandIn([payer]);

    const payer2 = await h.person(RICH);
    const id2 = await consultation(payer2);
    const q2 = await quoted(payer2, id2);
    h.nuvion.mode = 'pending';
    const two = await Promise.all([
      h.post(payer2, url(id2), request(q2)),
      h.post(payer2, url(id2), request(q2)),
    ]);
    expect(h.sendsFrom(payer2)).toHaveLength(1);
    expect(two.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      two.map(code).filter((c) => c === 'payment_in_progress'),
    ).toHaveLength(1);
    h.nuvion.settle(
      h.sendsFrom(payer2)[0].request.unique_reference,
      'successful',
    );
    await until(async () => {
      await h.pass();
      return (await row(id2)).consultationPaidAt !== null;
    }, 'the consultation to be marked paid');
    await h.expectLedgerEqualsStandIn([payer, payer2]);
  });

  it('a wrong PIN moves nothing and marks nothing paid', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer);
    const q = await quoted(payer, id);
    const res = await h.post(payer, url(id), request(q), { pin: '1111' });
    expect(res.status).toBe(403);
    expect(code(res)).toBe('pin_incorrect');
    expect(h.sendsFrom(payer)).toHaveLength(0);
    expect((await row(id)).consultationPaidAt).toBeNull();
    expect(balance(payer)).toBe(BigInt(RICH));
    const ok = await h.post(payer, url(id), request(q), { pin: PAY_PIN });
    expect(ok.status).toBe(201);
    expect((await row(id)).consultationPaidAt).not.toBeNull();
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('a short balance is refused with the shortfall and moves nothing', async () => {
    const payer = await h.person(1_000_000);
    const id = await consultation(payer);
    const q = await quoted(payer, id);
    expect(q.payment.shortfallKobo).toBe(CONSULT + FEE - 1_000_000);
    const res = await h.post(payer, url(id), request(q));
    expect(res.status).toBe(402);
    expect(code(res)).toBe('insufficient_funds');
    expect(h.sendsFrom(payer)).toHaveLength(0);
    expect((await row(id)).consultationPaidAt).toBeNull();
    expect(balance(payer)).toBe(1_000_000n);
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('a lost provider answer, then a retry, takes the money once and marks the fee paid once', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer);
    const q = await quoted(payer, id);
    const key = randomUUID();
    h.nuvion.mode = 'timeout';
    const first = await h.post(payer, url(id), request(q), { key });
    expect(first.status).toBe(201);
    const pending = body<LegalFeeWalletView>(first).data!;
    expect(pending.status).toBe('pending');
    expect((await row(id)).consultationPaidAt).toBeNull();

    h.nuvion.mode = 'successful';
    const retry = await h.post(payer, url(id), request(q), {
      key,
      pin: '0000',
    });
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(h.sendsFrom(payer)).toHaveLength(1);

    h.nuvion.settle(
      h.sendsFrom(payer)[0].request.unique_reference,
      'successful',
    );
    await until(async () => {
      await h.pass();
      return (await row(id)).consultationPaidAt !== null;
    }, 'the consultation to be marked paid');
    await h.pass();
    expect(h.sendsFrom(payer)).toHaveLength(1);
    const read = body<LegalFeeWalletView>(
      await h.get(payer, `${url(id)}/${pending.id}`),
    ).data!;
    expect(read.status).toBe('paid');
    expect(balance(payer)).toBe(BigInt(RICH - CONSULT - FEE));
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('a fee that cannot be applied is paid back: the price returns, the charge does not', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer);
    const q = await quoted(payer, id);
    h.nuvion.mode = 'pending';
    const res = await h.post(payer, url(id), request(q));
    const pending = body<LegalFeeWalletView>(res).data!;
    expect(pending.status).toBe('pending');
    // The matter is closed by the legal team before the debit is confirmed.
    await h.prisma.legalRequest.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        scheduledFor: null,
      },
    });
    h.nuvion.settle(
      h.sendsFrom(payer)[0].request.unique_reference,
      'successful',
    );
    h.nuvion.mode = 'successful';
    await until(async () => {
      await h.pass();
      const hold = await h.prisma.walletHold.findUnique({
        where: { paymentId: pending.id },
      });
      return hold?.status === 'refunded';
    }, 'the fee to be paid back');
    await h.pass();

    const r = await row(id);
    expect(r.consultationPaidAt).toBeNull();
    expect(r.status).toBe('cancelled');
    expect(balance(payer)).toBe(BigInt(RICH - FEE));
    const read = body<LegalFeeWalletView>(
      await h.get(payer, `${url(id)}/${pending.id}`),
    ).data!;
    expect(read.status).toBe('refunded');
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it("refuses someone else's request, one that is gone, a cancelled one and a booking whose hold has run out", async () => {
    const payer = await h.person(RICH);
    const other = await h.person(RICH);
    const theirs = await consultation(other);
    expect((await h.get(payer, `${url(theirs)}/quote`)).status).toBe(404);
    expect((await h.get(payer, `${url(randomUUID())}/quote`)).status).toBe(404);
    const cancelled = await consultation(payer);
    await h.prisma.legalRequest.update({
      where: { id: cancelled },
      data: { status: 'cancelled' },
    });
    expect((await h.get(payer, `${url(cancelled)}/quote`)).status).toBe(409);
    const lapsed = await consultation(payer);
    await h.prisma.legalRequest.update({
      where: { id: lapsed },
      data: { scheduledFor: null },
    });
    expect((await h.get(payer, `${url(lapsed)}/quote`)).status).toBe(409);
    // Someone else's payment is not readable.
    const mine = await consultation(payer);
    const q = await quoted(payer, mine);
    const ok = await h.post(payer, url(mine), request(q));
    const paid = body<LegalFeeWalletView>(ok).data!;
    expect((await h.get(other, `${url(mine)}/${paid.id}`)).status).toBe(404);
  });
});
