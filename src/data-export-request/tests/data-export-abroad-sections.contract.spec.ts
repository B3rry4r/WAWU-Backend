import { PrismaService } from '../../common/prisma/prisma.service';
import { EXPORT_SECTIONS } from '../data-export-sections';

/**
 * The person's own sends abroad are in the data export (NUV-11, R-84; as WALLET-21's money records are): a section each for the
 * recipients they saved, the quotes they were shown and the sends they made, their own rows only, written as JSON (amounts are
 * numbers, not bigint), with an outside account as its last four characters, and none of the provider's ids, references or status
 * word, our fingerprint of the account, the id of the account a send debited, or what finance keeps about a fee.
 */
const ME = 'nuv11-export-me';
const OTHER = 'nuv11-export-other';

describe('the data export carries the sends abroad (NUV-11)', () => {
  const prisma = new PrismaService();

  async function clean() {
    for (const who of [ME, OTHER]) {
      await prisma.abroadSend.deleteMany({ where: { wawuUserId: who } });
      await prisma.abroadQuote.deleteMany({ where: { wawuUserId: who } });
      await prisma.abroadRecipient.deleteMany({ where: { wawuUserId: who } });
      await prisma.abroadFreeze.deleteMany({ where: { wawuUserId: who } });
    }
  }

  beforeAll(async () => {
    await clean();
    for (const who of [ME, OTHER]) {
      const mine = who === ME;
      const recipient = await prisma.abroadRecipient.create({
        data: {
          wawuUserId: who,
          country: 'GH',
          currency: 'GHS',
          method: 'bank',
          scheme: 'bank',
          holderName: mine ? 'Ama Mensah' : 'Kofi Other',
          bankName: 'Test Bank',
          last4: '6789',
          fingerprint: `fingerprint-secret-${who}`,
          providerCounterpartyId: `counterparty-secret-${who}`,
          providerPaymentDetailId: `detail-secret-${who}`,
        },
      });
      // A recipient the person removed is still their record.
      await prisma.abroadRecipient.create({
        data: {
          wawuUserId: who,
          country: 'KE',
          currency: 'KES',
          method: 'mobile_money',
          holderName: mine ? 'Wanjiru Old' : 'Otieno Old',
          last4: '1234',
          fingerprint: `fingerprint-secret-old-${who}`,
          providerCounterpartyId: `counterparty-secret-old-${who}`,
          providerPaymentDetailId: `detail-secret-old-${who}`,
          removedAt: new Date(),
        },
      });
      const quote = await prisma.abroadQuote.create({
        data: {
          wawuUserId: who,
          recipientId: recipient.id,
          fromCurrency: 'USD',
          toCurrency: 'GHS',
          fromAccountRef: `account-secret-${who}`,
          amountFromMinor: 10_000n,
          amountToMinor: 100_361n,
          rate: '10.036105',
          providerQuoteId: `quote-secret-${who}`,
          wawuFeeKobo: 2_500n,
          providerFeeEstimateMinor: 150n,
          expiresAt: new Date(),
          usedAt: new Date(),
        },
      });
      await prisma.abroadSend.create({
        data: {
          wawuUserId: who,
          recipientId: recipient.id,
          quoteId: quote.id,
          fromCurrency: 'USD',
          toCurrency: 'GHS',
          fromAccountRef: `account-secret-${who}`,
          amountFromMinor: 10_000n,
          amountToMinor: 100_361n,
          rate: '10.036105',
          status: 'reversed',
          failureReason: 'This send was returned to your account.',
          narration: 'School fees',
          reference: `reference-secret-${who}`,
          providerTransferId: `transfer-secret-${who}`,
          providerStatus: 'provider-word-secret',
          providerFeeMinor: 150n,
          wawuFeeKobo: 2_500n,
          wawuFeeTaken: true,
          feeGivenBackAt: new Date(),
          feeBackHeldAt: new Date(),
          feeDiffers: true,
          feeSettledAt: new Date(),
          feeSettledHow: 'finance-note-secret',
        },
      });
    }
  });
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it.each([
    ['abroadRecipients', 2],
    ['abroadQuotes', 1],
    ['abroadSends', 1],
  ])(
    '%s: only my rows, as JSON, with no provider id, reference, account id or finance note',
    async (key, count) => {
      const section = EXPORT_SECTIONS.find((s) => s.key === key)!;
      const rows = (await section.load(prisma, ME)) as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(count);
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(/secret/);
      expect(text).not.toContain(OTHER);
      expect(text).not.toContain('Kofi Other');
      expect(text).not.toContain('Otieno Old');
    },
  );

  it('gives a saved recipient with the last four characters of the account, and a removed one with its time', async () => {
    const section = EXPORT_SECTIONS.find((s) => s.key === 'abroadRecipients')!;
    const rows = (await section.load(prisma, ME)) as Array<
      Record<string, unknown>
    >;
    const ama = rows.find((r) => r.holderName === 'Ama Mensah')!;
    expect(ama).toMatchObject({
      country: 'GH',
      currency: 'GHS',
      method: 'bank',
      bankName: 'Test Bank',
      accountEnd: '6789',
      removedAt: null,
    });
    expect('last4' in ama).toBe(false);
    const old = rows.find((r) => r.holderName === 'Wanjiru Old')!;
    expect(old).toMatchObject({ accountEnd: '1234' });
    expect(old.removedAt).toBeInstanceOf(Date);
  });

  it('gives amounts as numbers, the fees and whether WAWU’s fee went back, and who it went to', async () => {
    const quotes = EXPORT_SECTIONS.find((s) => s.key === 'abroadQuotes')!;
    const [q] = (await quotes.load(prisma, ME)) as Array<
      Record<string, unknown>
    >;
    expect(q).toMatchObject({
      fromCurrency: 'USD',
      toCurrency: 'GHS',
      amountFromMinor: 10_000,
      amountToMinor: 100_361,
      rate: '10.036105',
      wawuFeeKobo: 2_500,
      providerFeeEstimateMinor: 150,
    });
    expect('fromAccountRef' in q).toBe(false);
    const sends = EXPORT_SECTIONS.find((s) => s.key === 'abroadSends')!;
    const [s] = (await sends.load(prisma, ME)) as Array<
      Record<string, unknown>
    >;
    expect(s).toMatchObject({
      status: 'reversed',
      amountFromMinor: 10_000,
      amountToMinor: 100_361,
      providerFeeMinor: 150,
      wawuFeeKobo: 2_500,
      wawuFeeTaken: true,
      narration: 'School fees',
      to: {
        country: 'GH',
        method: 'bank',
        holderName: 'Ama Mensah',
        bankName: 'Test Bank',
        accountEnd: '6789',
      },
    });
    expect(s.feeGivenBackAt).toBeInstanceOf(Date);
    for (const left of [
      'reference',
      'providerTransferId',
      'providerStatus',
      'fromAccountRef',
      'feeDiffers',
      'feeBackHeldAt',
      'feeSettledAt',
      'feeSettledHow',
      'recipient',
    ]) {
      expect(left in s).toBe(false);
    }
  });

  it('a person with none gets empty lists, and the freeze stays out with its reason', async () => {
    for (const key of ['abroadRecipients', 'abroadQuotes', 'abroadSends']) {
      const section = EXPORT_SECTIONS.find((x) => x.key === key)!;
      expect(await section.load(prisma, 'nuv11-export-nobody')).toEqual([]);
    }
    const exported = EXPORT_SECTIONS.flatMap((x) => x.models);
    expect(exported).not.toContain('AbroadFreeze');
  });
});
