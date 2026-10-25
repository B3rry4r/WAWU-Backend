import { randomUUID } from 'node:crypto';
import {
  bootPayApp,
  type PayHarness,
  type PayPerson,
} from '../../../../test/payments/wallet-pay-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { PayableRegistry } from '../../../money/payments/payable-registry';
import { NotificationModule } from '../../../notification/notification.module';
import { LegalFeeWalletModule } from '../legal-fee-wallet.module';
import { LEGAL_FEE_KIND } from '../legal-fee-wallet.service';
import type {
  LegalFeeWalletQuoteView,
  LegalFeeWalletView,
} from '../legal-fee-wallet-view.type';

/**
 * R2-MONEY2 round 2 (CHECK-3 money third pass H-01): paying the consultation
 * fee from the wallet writes ONE "consultation booked" row in the person's
 * notification list when the matter began in the app's assistant, and nothing
 * for the web's own flow or for the fee for the work. The service spec
 * (legal-matter-notice) covers the sentence; this one covers the hook in the
 * payment's own path, which is where a miss would go unseen.
 *
 * Written after the hook, not before it: the hook was read when round 1 added
 * it, so this spec was not red first by reading nothing. It is not vacuous: the
 * "web flow" and "work fee" cases fail if the row is written for them, and the
 * "assistant" case fails if no row is written.
 *
 * Round 3 (verifier F5): the "once" case that matters is the delivery run a
 * second time (the payment sweep does that when the first run was cut off
 * before it was recorded). The second run does not grant, so only the
 * `result.granted &&` guard before `consultationBooked` keeps it from writing
 * a second row; the case "delivered a second time" is red with that guard
 * removed (checked locally, never committed) and green with it.
 */

jest.setTimeout(180_000);

const CONSULT_NAIRA = 15_000;
const SERVICE_NAIRA = 50_000;
const RICH = 20_000_000;

describe('A paid consultation reaches the notification list (R2-MONEY2 round 2)', () => {
  let h: PayHarness;
  const requests: string[] = [];

  beforeAll(async () => {
    h = await bootPayApp('r2b', {
      modules: [LegalFeeWalletModule, NotificationModule],
      cleanup: async (prisma, users) => {
        await prisma.legalIntake.deleteMany({
          where: { legalRequestId: { in: requests } },
        });
        await prisma.legalRequest.deleteMany({
          where: { id: { in: requests } },
        });
        await prisma.notification.deleteMany({
          where: { userWawuId: { in: users } },
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

  async function consultation(p: PayPerson, assistant: boolean) {
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
        consultationFee: CONSULT_NAIRA,
        consultationMinutes: 30,
        scheduledFor: new Date(Date.now() + 3 * 86_400_000),
      },
    });
    requests.push(id);
    if (assistant) {
      await h.prisma.legalIntake.create({
        data: {
          wawuUserId: p.id,
          matter: 'property',
          status: 'converted',
          channel: 'assistant',
          legalRequestId: id,
        },
      });
    }
    return id;
  }

  async function signedService(p: PayPerson) {
    const id = randomUUID();
    await h.prisma.legalRequest.create({
      data: {
        id,
        wawuUserId: p.id,
        serviceCode: 'cac-business-name',
        serviceName: 'CAC business name registration',
        category: 'business',
        path: 'simple',
        status: 'contract_signed',
        quoteAmount: SERVICE_NAIRA,
        contractSignedAt: new Date(),
      },
    });
    await h.prisma.legalIntake.create({
      data: {
        wawuUserId: p.id,
        matter: 'business_registration',
        status: 'converted',
        channel: 'assistant',
        legalRequestId: id,
      },
    });
    requests.push(id);
    return id;
  }

  async function pay(p: PayPerson, id: string) {
    const url = `/legal/requests/${id}/pay/wallet`;
    const quote = body<LegalFeeWalletQuoteView>(
      await h.get(p, `${url}/quote`),
    ).data!;
    const res = await h.post(p, url, {
      expectedTotalKobo: quote.payment.totalKobo,
      quoteToken: quote.payment.quoteToken,
    });
    expect(res.status).toBe(201);
    return body<LegalFeeWalletView>(res).data!;
  }

  const rows = (p: PayPerson, kind: string) =>
    h.prisma.notification.findMany({
      where: { userWawuId: p.id, kind },
    });

  it('writes one "booked" row for a matter that began in the assistant, opening the request', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer, true);
    const paid = await pay(payer, id);
    expect(paid.requestStatus).toBe('consultation_scheduled');
    const booked = await rows(payer, 'legal_consultation_booked');
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      title: 'Your consultation is booked',
      actionLabel: 'Open request',
      read: false,
    });
    expect(booked[0].body).not.toMatch(/—/);
  });

  it('writes the row once: asking for the same payment again adds no second row', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer, true);
    await pay(payer, id);
    const again = await h.get(payer, `/legal/requests/${id}/pay/wallet/quote`);
    expect(again.status).toBe(409);
    expect(await rows(payer, 'legal_consultation_booked')).toHaveLength(1);
  });

  it('writes the row once when the same payment is delivered a second time (the sweep can run a delivery twice)', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer, true);
    const paid = await pay(payer, id);
    expect(await rows(payer, 'legal_consultation_booked')).toHaveLength(1);

    const p = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    const handler = h.app.get(PayableRegistry).get(LEGAL_FEE_KIND);
    if (!handler?.onCompleted)
      throw new Error('The legal fee kind registers no delivery.');
    // The delivery as the sweep hands it over, run again for the same payment.
    await handler.onCompleted({
      paymentId: p.id,
      payerWawuUserId: payer.id,
      kind: LEGAL_FEE_KIND,
      targetId: p.targetId,
      priceKobo: Number(p.priceKobo),
      payeeWawuUserId: p.payeeWawuUserId,
      note: p.note,
      holdId: null,
      terms: { stage: 'consultation', feeNaira: CONSULT_NAIRA },
    });

    const now = await h.prisma.legalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(now.status).toBe('consultation_scheduled');
    expect(await rows(payer, 'legal_consultation_booked')).toHaveLength(1);
  });

  it('writes nothing for the web flow, which began without the assistant', async () => {
    const payer = await h.person(RICH);
    const id = await consultation(payer, false);
    await pay(payer, id);
    expect(await rows(payer, 'legal_consultation_booked')).toHaveLength(0);
  });

  it('writes no "booked" row when the fee for the work is paid', async () => {
    const payer = await h.person(RICH);
    const id = await signedService(payer);
    const paid = await pay(payer, id);
    expect(paid.stage).toBe('service');
    expect(await rows(payer, 'legal_consultation_booked')).toHaveLength(0);
  });
});
