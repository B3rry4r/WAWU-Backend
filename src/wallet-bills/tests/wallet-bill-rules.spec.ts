import { FintavaError } from '../../fintava/fintava-error';
import type { FintavaTransaction } from '../../fintava/fintava.interface';
import {
  boughtNothing,
  newBillReference,
  progressOf,
  purchaseInputOf,
  readHistory,
  tokenOf,
  unitsOf,
} from '../wallet-bill-rules';

const bill = {
  category: 'electricity' as const,
  billerCode: 'AEDC',
  planType: 'prepaid' as const,
  productCode: null,
  accountNumber: '04123456789',
  amountKobo: 1_000_000,
  billChargeKobo: 10_000,
};

function row(over: Partial<FintavaTransaction>): FintavaTransaction {
  return {
    id: 'r1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    amountKobo: 1_000_000,
    transType: 'ELECTRICITY',
    entry: 'DEBIT',
    status: 'SUCCESS',
    customerReference: null,
    fintavaReference: 'f1',
    tagapayTransRef: null,
    narration: null,
    senderDetails: null,
    recipientDetails: null,
    senderBank: null,
    receiverBank: null,
    sessionId: null,
    customerId: null,
    platformCommKobo: null,
    merchantCommKobo: null,
    lomaChargeKobo: null,
    meterToken: '1234',
    meterNumber: '04123456789',
    discoRef: null,
    ...over,
  };
}

describe('wallet bill rules (BILLS-04)', () => {
  it('makes a reference a person can read out: WAW-BIL- and eight characters with no 0, O, 1, I or L', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const ref = newBillReference();
      expect(ref).toMatch(/^WAW-BIL-[A-HJ-NP-Z2-9]{8}$/);
      seen.add(ref);
    }
    expect(seen.size).toBe(200);
  });

  it('tells the app a draft is awaiting payment and a bought bill is processing', () => {
    expect(progressOf('draft')).toBe('awaiting_payment');
    expect(progressOf('buying')).toBe('processing');
    expect(progressOf('delivered')).toBe('delivered');
    expect(progressOf('failed')).toBe('failed');
  });

  describe('purchaseInputOf', () => {
    it('maps each category to Fintava call inputs from the row alone', () => {
      expect(purchaseInputOf(bill)).toEqual({
        category: 'electricity',
        input: {
          meterNumber: '04123456789',
          disco: 'AEDC',
          planType: 'prepaid',
          amountKobo: 1_000_000,
        },
      });
      expect(
        purchaseInputOf({
          ...bill,
          category: 'airtime',
          billerCode: 'MTN',
          planType: null,
          accountNumber: '08031234567',
          amountKobo: 50_000,
        }),
      ).toEqual({
        category: 'airtime',
        input: { network: 'MTN', phone: '08031234567', amountKobo: 50_000 },
      });
      expect(
        purchaseInputOf({
          ...bill,
          category: 'data',
          billerCode: 'GLO',
          planType: null,
          productCode: '30',
          accountNumber: '08031234567',
        }),
      ).toEqual({
        category: 'data',
        input: { network: 'GLO', phone: '08031234567', bundleCode: '30' },
      });
      expect(
        purchaseInputOf({
          ...bill,
          category: 'cable',
          billerCode: 'DSTV',
          planType: null,
          productCode: 'COMPACT',
          accountNumber: '7012345678',
        }),
      ).toEqual({
        category: 'cable',
        input: {
          provider: 'DSTV',
          smartcardNumber: '7012345678',
          planCode: 'COMPACT',
        },
      });
    });

    it('throws, and so sends nothing, for a row that cannot be bought', () => {
      expect(() => purchaseInputOf({ ...bill, accountNumber: null })).toThrow();
      expect(() => purchaseInputOf({ ...bill, planType: null })).toThrow();
      expect(() =>
        purchaseInputOf({ ...bill, category: 'data', productCode: null }),
      ).toThrow();
      expect(() =>
        purchaseInputOf({ ...bill, category: 'cable', productCode: null }),
      ).toThrow();
    });
  });

  describe('token and units', () => {
    const receipt = (
      meterToken: string | null,
      details: Record<string, string | number | boolean | null>,
    ) => ({
      transactionId: 't',
      fintavaReference: 'f',
      amountKobo: null,
      meterToken,
      details,
    });

    it('reads the token the client found, else a token field, and nothing otherwise', () => {
      expect(tokenOf(receipt('4821 0937', {}))).toBe('4821 0937');
      expect(tokenOf(receipt(null, { Token: 99887766 }))).toBe('99887766');
      expect(tokenOf(receipt(null, { message: 'ok' }))).toBeNull();
      expect(tokenOf(receipt('x'.repeat(65), {}))).toBeNull();
    });

    it('reads the units from the names an electricity answer would use, and invents none', () => {
      expect(unitsOf({ units: '45.2' })).toBe('45.2');
      expect(unitsOf({ Units_Purchased: 45.2 })).toBe('45.2');
      expect(unitsOf({ kWh: 12 })).toBe('12');
      expect(unitsOf({ amount: 10000, message: 'ok' })).toBeNull();
      expect(unitsOf({ units: null })).toBeNull();
      expect(unitsOf({ units: true })).toBeNull();
    });
  });

  describe('boughtNothing', () => {
    const err = (
      kind: ConstructorParameters<typeof FintavaError>[0]['kind'],
      messages: string[] = [],
    ) => new FintavaError({ kind, operation: 'buy electricity', messages });

    it('is true for a refusal that left no record and for a service that is off', () => {
      expect(
        boughtNothing(err('payouts_blocked', ['Unable to find customers'])),
      ).toBe(true);
      expect(boughtNothing(err('refused'))).toBe(true);
      expect(boughtNothing(err('below_minimum'))).toBe(true);
      expect(
        boughtNothing(
          err('not_confirmed', ['service not currently available']),
        ),
      ).toBe(true);
    });

    it('is false for anything that may hide a purchase', () => {
      expect(boughtNothing(err('outcome_unknown'))).toBe(false);
      expect(boughtNothing(err('not_confirmed', ['something else']))).toBe(
        false,
      );
      expect(boughtNothing(err('duplicate_reference'))).toBe(false);
    });
  });

  describe('readHistory', () => {
    const sentAt = new Date();
    const read = (
      rows: FintavaTransaction[],
      b: Parameters<typeof readHistory>[0] = bill,
    ) => readHistory(b, sentAt, rows);

    it('decides on one record for the same meter and amount after the purchase was handed over', () => {
      expect(read([row({})]).state).toBe('delivered');
      expect(read([row({ status: 'FAILURE' })]).state).toBe('failed');
      expect(read([row({ status: 'CANCELLED' })]).state).toBe('failed');
      expect(read([row({ status: 'PENDING' })]).state).toBe('unknown');
    });

    it('takes the amount with the bill charge too', () => {
      expect(read([row({ amountKobo: 1_010_000 })]).state).toBe('delivered');
    });

    it('is none when nothing matches: absence is not proof', () => {
      expect(read([]).state).toBe('none');
      expect(read([row({ meterNumber: '999' })]).state).toBe('none');
      expect(read([row({ amountKobo: 5 })]).state).toBe('none');
      expect(
        read([
          row({
            createdAt: new Date(sentAt.getTime() - 3 * 60_000).toISOString(),
          }),
        ]).state,
      ).toBe('none');
    });

    it('is unknown, never a guess, when two records match', () => {
      expect(read([row({ id: 'a' }), row({ id: 'b' })]).state).toBe('unknown');
    });

    it('matches airtime, data and cable on the number in the recipient or narration', () => {
      const airtime = {
        ...bill,
        category: 'airtime' as const,
        billerCode: 'MTN',
        planType: null,
        accountNumber: '08031234567',
        amountKobo: 50_000,
      };
      const hit = row({
        amountKobo: 50_000,
        meterNumber: null,
        recipientDetails: 'MTN 08031234567',
      });
      expect(read([hit], airtime).state).toBe('delivered');
      expect(
        read([{ ...hit, recipientDetails: 'MTN 08039999999' }], airtime).state,
      ).toBe('none');
      expect(read([{ ...hit, recipientDetails: null }], airtime).state).toBe(
        'none',
      );
    });
  });
});
