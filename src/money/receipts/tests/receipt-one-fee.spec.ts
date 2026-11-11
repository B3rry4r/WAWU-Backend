import type { TransactionView } from '../../money-view.type';
import { receiptLines } from '../receipt-document';

/**
 * FEE-01 (F3): under the fee engine a receipt shows one fee, WAWU's, and no provider line; under Fintava the
 * receipt is exactly what main drew, even when the provider's charge is 0 and WAWU's is above 0.
 */
const tx = {
  direction: 'out',
  amountKobo: 1_000_000,
  totalKobo: 1_000_050,
  reference: 'REF-1',
  kind: 'transfer',
  description: 'Transfer',
  fee: { providerFeeKobo: 0, wawuFeeKobo: 50, totalFeeKobo: 50 },
} as unknown as TransactionView;

const labels = (oneFee?: boolean) =>
  receiptLines(tx, { from: null, to: null }, 'Loma Bank', oneFee).map(
    (l) => l.label,
  );

describe('receipt lines and the fee', () => {
  it("Fintava: provider charge 0 and WAWU's fee 50 still draws the provider line, as main does", () => {
    expect(labels()).toContain("Fintava's charge");
    expect(labels()).toContain("WAWU's fee");
  });

  it('the fee engine: one fee, no provider line', () => {
    expect(labels(true)).not.toContain("Fintava's charge");
    expect(labels(true)).toContain("WAWU's fee");
  });

  it('the fee engine, but a provider charge above 0 still draws its line', () => {
    const t = {
      ...tx,
      fee: { providerFeeKobo: 20, wawuFeeKobo: 30, totalFeeKobo: 50 },
    };
    expect(
      receiptLines(t, { from: null, to: null }, 'Loma Bank', true).map(
        (l) => l.label,
      ),
    ).toContain("Fintava's charge");
  });
});
