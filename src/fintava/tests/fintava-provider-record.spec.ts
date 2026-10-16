import {
  fintavaKindOf,
  fromFintavaTransaction,
} from '../fintava-wallet-provider';
import type { FintavaTransaction } from '../fintava.interface';

/**
 * What the Fintava adapter tells the seam about a transaction record beyond
 * its references (task MONEY-16): the kind of movement, and what the full
 * record shows paid to WAWU as its charge (`merchantComm`).
 */
function record(over: Partial<FintavaTransaction> = {}): FintavaTransaction {
  return {
    id: 'tx-1',
    createdAt: '2026-10-02T09:40:58.764Z',
    updatedAt: '2026-10-02T09:40:58.777Z',
    amountKobo: 1_000,
    transType: 'AATRANSFER',
    entry: 'DEBIT',
    status: 'SUCCESS',
    customerReference: 'ours-1',
    fintavaReference: 'fintava-1',
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
    meterToken: null,
    meterNumber: null,
    discoRef: null,
    ...over,
  };
}

describe('what the seam is told about a Fintava record', () => {
  it.each([
    ['AATRANSFER', 'transfer'],
    ['aatransfer', 'transfer'],
    ['BVNCHARGE', 'charge'],
    ['SELFIECHARGE', 'charge'],
    ['AIRTIME', 'other'],
    ['', 'other'],
  ])('reads the type %s as %s', (transType, kind) => {
    expect(fintavaKindOf(transType)).toBe(kind);
    expect(fromFintavaTransaction(record({ transType })).kind).toBe(kind);
  });

  it('carries the charge the full record shows paid to WAWU, in kobo', () => {
    expect(
      fromFintavaTransaction(record({ merchantCommKobo: 1_000 }))
        .merchantChargeKobo,
    ).toBe(1_000n);
    expect(
      fromFintavaTransaction(record({ merchantCommKobo: 0 }))
        .merchantChargeKobo,
    ).toBe(0n);
  });

  it('says nothing, not zero, when the record does not show it', () => {
    expect(
      fromFintavaTransaction(record({ merchantCommKobo: null }))
        .merchantChargeKobo,
    ).toBeNull();
  });

  it('keeps the references and the outcome as before', () => {
    const t = fromFintavaTransaction(record({ status: 'FAILURE' }));
    expect(t).toMatchObject({
      id: 'tx-1',
      amountKobo: 1_000n,
      outcome: 'failed',
      ourReference: 'ours-1',
      providerReference: 'fintava-1',
      secondaryReference: null,
    });
  });
});
