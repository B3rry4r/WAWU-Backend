import {
  fintavaAmountToKobo,
  koboToFintavaAmount,
} from '../../../fintava/fintava-amount';
import {
  accountFunded,
  cardPayment,
  customerBankTransfer,
  debitTransferReversal,
  virtualWalletPayment,
  walletToWallet,
} from '../../../../test/fintava/fintava-webhook-payloads';
import { ledgerConfirmWindowMs } from '../ledger-config';
import {
  koboBig,
  koboNumber,
  ledgerReferences,
  LEDGER_ABSENT_FAILURE,
  LEDGER_FINTAVA_FAILURE,
  ledgerStatusMayMove,
  reversalDisagreement,
} from '../ledger.service';
import {
  ledgerStatusOf,
  readLedgerWebhook,
} from '../../../fintava/fintava-ledger-delivery';

/**
 * The ledger's pure rules (task MONEY-10): reading each documented Fintava
 * delivery (mobile repo `docs/fintava/reference/webhook-events.md`, the
 * same payloads MONEY-07's tests sign), kobo without floats, references and
 * the forward-only status.
 */

const parse = (text: string) => JSON.parse(text) as unknown;

describe('ledger: reading the documented deliveries', () => {
  it('wallet_to_wallet_transfer_v2: amounts in kobo, both account numbers per side, no status', () => {
    const r = readLedgerWebhook(
      'wallet_to_wallet_transfer_v2',
      parse(walletToWallet('u1')),
      'key-u1',
    );
    expect(r).toMatchObject({
      kind: 'movement',
      status: null,
      amountKobo: 1000,
      feeKobo: 0,
      totalKobo: 1000,
      category: 'transfer',
      trustAlone: false,
      from: {
        accountNumbers: ['0020886993', '0031886994'],
        customerId: null,
        where: 'provider_wallet',
      },
      to: {
        where: 'provider_wallet',
        accountNumbers: ['0040497763', '0032497867'],
      },
    });
    expect(r.kind === 'movement' && r.references).toEqual([
      '48VYIuIAZTSVQlZ8O900JdcUJ0imoVZ1L-u1',
      'key-u1',
    ]);
  });

  it('account_funded: money in, trusted alone (history lists no credits), status success is completed', () => {
    const r = readLedgerWebhook(
      'account_funded',
      parse(accountFunded('u2')),
      'k',
    );
    expect(r).toMatchObject({
      kind: 'movement',
      status: 'completed',
      amountKobo: 10000,
      totalKobo: 10000,
      category: 'top_up',
      trustAlone: true,
      to: {
        where: 'provider_wallet',
        customerId: 'bf61c3cf-4894-4a01-91b1-e4c5e2fa2b08',
        accountNumbers: ['0094886003'],
      },
      // The sender is at another bank: never a WAWU wallet by number.
      from: {
        where: 'bank_account',
        accountNumbers: ['0865231291'],
        bankCode: '000014',
      },
      sessionId: '000914231311144221237185422093',
    });
  });

  it('customer_bank_transfer: charges are the fee, total is amount plus charges, destination splits into account and bank', () => {
    const r = readLedgerWebhook(
      'customer_bank_transfer',
      parse(customerBankTransfer('u3', 'PENDING')),
      'k',
    );
    expect(r).toMatchObject({
      kind: 'movement',
      status: 'pending',
      amountKobo: 10000,
      feeKobo: 3075,
      totalKobo: 13075,
      from: {
        where: 'provider_wallet',
        customerId: 'e17402-0d82-4774-a020-716d819d0',
      },
      to: {
        where: 'bank_account',
        accountNumbers: ['81450'],
        bankCode: '100004',
      },
    });
  });

  it('virtual_wallet_payment (upper case, under `type`): money into the merchant wallet', () => {
    const r = readLedgerWebhook(
      'virtual_wallet_payment',
      parse(virtualWalletPayment('u4')),
      'k',
    );
    expect(r).toMatchObject({
      kind: 'movement',
      status: 'completed',
      amountKobo: 65000,
      to: { where: 'merchant' },
    });
  });

  it('debit_transfer_reversal: the references that may name the debit, and the amounts as reported', () => {
    const r = readLedgerWebhook(
      'debit_transfer_reversal',
      parse(debitTransferReversal('u5')),
      'k',
    );
    expect(r).toEqual({
      kind: 'reversal',
      status: 'completed',
      references: [
        'ref/0906205451400533/tyqwA0xLFhqDX9BWSgzGb0C-u5',
        'FIO241106308911000370001675-u5',
      ],
      reversalReference: 'r-tyqwA0xLFh2ifNhDX9BWSgzGb0C-u5',
      customerId: 'dd3d6-72d-48b9-bb45-29d78b52a',
      amountKobo: 10000000,
      chargesKobo: 1500,
      totalKobo: 10001500,
    });
  });

  it('an event the ledger does not read, a delivery without data, a missing or 3-decimal amount: unreadable, never a guess', () => {
    expect(
      readLedgerWebhook('card_payment', parse(cardPayment('u6')), 'k'),
    ).toEqual({
      kind: 'unreadable',
      why: 'the ledger does not read card_payment',
    });
    expect(readLedgerWebhook('account_funded', { event: 'x' }, 'k')).toEqual({
      kind: 'unreadable',
      why: 'the delivery has no data object',
    });
    const noAmount = parse(accountFunded('u7')) as {
      data: Record<string, unknown>;
    };
    delete noAmount.data.amount;
    expect(readLedgerWebhook('account_funded', noAmount, 'k').kind).toBe(
      'unreadable',
    );
    const threeDecimals = parse(accountFunded('u8')) as {
      data: Record<string, unknown>;
    };
    threeDecimals.data.amount = '100.005';
    expect(readLedgerWebhook('account_funded', threeDecimals, 'k')).toEqual({
      kind: 'unreadable',
      why: 'an amount is not naira with at most 2 decimals',
    });
  });

  it('a non-positive amount or total, a negative fee, a negative reversal figure, or amount plus fee past 2^53: unreadable, with the reason', () => {
    const w2w = (over: Record<string, unknown>) => {
      const b = parse(walletToWallet('neg')) as {
        data: Record<string, unknown>;
      };
      Object.assign(b.data, over);
      return readLedgerWebhook('wallet_to_wallet_transfer_v2', b, 'k');
    };
    const why = (r: ReturnType<typeof readLedgerWebhook>) =>
      r.kind === 'unreadable' ? r.why : r.kind;
    expect(why(w2w({ amount: -10, total: -10 }))).toBe(
      'the amount is not above 0',
    );
    expect(why(w2w({ amount: '-10.00', total: 10 }))).toBe(
      'the amount is not above 0',
    );
    expect(why(w2w({ amount: 0, total: 0 }))).toBe('the amount is not above 0');
    expect(why(w2w({ amount: '0.00', total: '0.00' }))).toBe(
      'the amount is not above 0',
    );
    expect(why(w2w({ transaction_fee: -1 }))).toBe('the fee is below 0');
    expect(why(w2w({ total: -10 }))).toBe('the total is not above 0');
    expect(why(w2w({ total: 0 }))).toBe('the total is not above 0');
    expect(
      why(
        w2w({ amount: '90071992547409.91', transaction_fee: 1, total: null }),
      ),
    ).toBe('amount and fee pass 2^53 kobo');
    expect(why(w2w({ amount: '90071992547410.00' }))).toBe(
      'an amount is not naira with at most 2 decimals',
    );
    const rev = (over: Record<string, unknown>) => {
      const b = parse(debitTransferReversal('neg')) as {
        data: Record<string, unknown>;
      };
      Object.assign(b.data, over);
      return why(readLedgerWebhook('debit_transfer_reversal', b, 'k'));
    };
    expect(rev({ amount: -100 })).toBe('the reversed amount is not above 0');
    expect(rev({ charges: -1 })).toBe('the reversed charges are below 0');
    expect(rev({ total: 0 })).toBe('the reversed total is not above 0');
    expect(rev({})).toBe('reversal');
  });

  it("status words: Fintava's to the ledger's; anything else is null (confirmed with Fintava)", () => {
    expect(ledgerStatusOf('success')).toBe('completed');
    expect(ledgerStatusOf('SUCCESS')).toBe('completed');
    expect(ledgerStatusOf('PAID')).toBe('completed');
    expect(ledgerStatusOf('PENDING')).toBe('pending');
    expect(ledgerStatusOf('ONGOING')).toBe('pending');
    expect(ledgerStatusOf('FAILURE')).toBe('failed');
    expect(ledgerStatusOf('CANCELLED')).toBe('failed');
    expect(ledgerStatusOf('')).toBeNull();
    expect(ledgerStatusOf('REVERSED?')).toBeNull();
    expect(ledgerStatusOf(undefined)).toBeNull();
  });
});

describe('ledger: kobo, exactly', () => {
  it('naira text to kobo, into BIGINT and back, and out to Fintava and back: every value survives exactly', () => {
    const samples = [
      '0.01',
      '0.10',
      '0.29',
      '1.15',
      '10',
      '10.00',
      '23.25',
      '15.75',
      '1023.25',
      '25065.00',
      '96820.50',
      '10000000.00',
      '99999999999.99',
    ];
    for (const naira of samples) {
      const kobo = fintavaAmountToKobo(naira);
      const stored = koboBig('amountKobo', kobo);
      expect(typeof stored).toBe('bigint');
      expect(koboNumber(stored)).toBe(kobo);
      expect(fintavaAmountToKobo(koboToFintavaAmount(kobo))).toBe(kobo);
      expect(fintavaAmountToKobo(naira)).toBe(kobo);
    }
    // 0.1 + 0.2 as a float is not money: refused, never rounded.
    expect(() => fintavaAmountToKobo(0.1 + 0.2)).toThrow();
    // Every kobo value from 0 to 100000 round-trips through Fintava's naira form.
    for (let k = 1; k <= 100_000; k += 1) {
      if (fintavaAmountToKobo(koboToFintavaAmount(k)) !== k) {
        throw new Error(`kobo ${k} did not survive`);
      }
    }
  });

  it('a float, a negative, NaN or a value past 2^53 is refused, not rounded', () => {
    expect(() => koboBig('a', 10.5)).toThrow(RangeError);
    expect(() => koboBig('a', -1)).toThrow(RangeError);
    expect(() => koboBig('a', Number.NaN)).toThrow(RangeError);
    expect(() => koboBig('a', 0, true)).toThrow(RangeError);
    expect(() => koboBig('a', 2 ** 53)).toThrow(RangeError);
    expect(() => koboNumber(2n ** 53n + 1n)).toThrow(RangeError);
    expect(koboNumber(2n ** 53n - 1n)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('ledger: references and status', () => {
  it('one row per text, the most specific kind kept, sorted, blanks and over-long ones dropped', () => {
    expect(
      ledgerReferences({
        customerReference: ' OURS-1 ',
        fintavaReference: 'f-2',
        tagapayTransRef: null,
        sessionId: '',
        delivery: ['f-2', 'OURS-1', 'Z-9', undefined, 'x'.repeat(201)],
      }),
    ).toEqual([
      { value: 'OURS-1', kind: 'ours' },
      { value: 'Z-9', kind: 'delivery' },
      { value: 'f-2', kind: 'fintava' },
    ]);
  });

  it('a status only moves forward: reversed and failed never go back, pending changes nothing', () => {
    expect(ledgerStatusMayMove('pending', 'completed')).toBe(true);
    expect(ledgerStatusMayMove('completed', 'reversed')).toBe(true);
    expect(ledgerStatusMayMove('failed', 'reversed')).toBe(true);
    expect(ledgerStatusMayMove('reversed', 'completed')).toBe(false);
    expect(ledgerStatusMayMove('completed', 'pending')).toBe(false);
    expect(ledgerStatusMayMove('failed', 'completed')).toBe(false);
    expect(ledgerStatusMayMove('completed', 'completed')).toBe(false);
    // MONEY-08 (U-1): money that left is never re-labelled failed; only a
    // reversal moves a completed row.
    expect(ledgerStatusMayMove('completed', 'failed')).toBe(false);
    expect(ledgerStatusMayMove('pending', 'failed')).toBe(true);
  });

  it('the confirm window: 72 hours unless set, whole hours from 1 to 720', () => {
    expect(ledgerConfirmWindowMs(undefined)).toBe(72 * 3_600_000);
    expect(ledgerConfirmWindowMs(' 2 ')).toBe(2 * 3_600_000);
    expect(() => ledgerConfirmWindowMs('0')).toThrow();
    expect(() => ledgerConfirmWindowMs('1.5')).toThrow();
  });
});

describe("MONEY-08 round 3: a reversal applies only with the row's figures, to a row it can follow", () => {
  const row = (
    o: Partial<Parameters<typeof reversalDisagreement>[0]> = {},
  ) => ({
    status: 'failed' as const,
    failureReason: LEDGER_FINTAVA_FAILURE,
    amountKobo: 10000n,
    feeKobo: 3075n,
    totalKobo: 13075n,
    reversalReference: null,
    ...o,
  });
  const rev = (
    o: Partial<Parameters<typeof reversalDisagreement>[1]> = {},
  ) => ({
    amountKobo: 10000,
    chargesKobo: 3075,
    totalKobo: 13075,
    reversalReference: 'r-1',
    ...o,
  });

  it('the same figures, on a failed or pending send, or the same reversal again: applied', () => {
    expect(reversalDisagreement(row(), rev())).toBeNull();
    expect(
      reversalDisagreement(
        row({ status: 'pending', failureReason: null }),
        rev(),
      ),
    ).toBeNull();
    expect(
      reversalDisagreement(
        row({ status: 'reversed', reversalReference: 'r-1' }),
        rev(),
      ),
    ).toBeNull();
  });

  it.each([
    [
      '1 kobo more',
      rev({ amountKobo: 10001, totalKobo: 13076 }),
      'amountKobo 10000 vs 10001, totalKobo 13075 vs 13076',
    ],
    [
      '1 kobo less',
      rev({ amountKobo: 9999, totalKobo: 13074 }),
      'amountKobo 10000 vs 9999, totalKobo 13075 vs 13074',
    ],
    [
      'the fee kept',
      rev({ chargesKobo: 0, totalKobo: 10000 }),
      'feeKobo 3075 vs 0, totalKobo 13075 vs 10000',
    ],
    ['the total only', rev({ totalKobo: 13076 }), 'totalKobo 13075 vs 13076'],
    [
      'a figure not reported',
      rev({ chargesKobo: null }),
      'feeKobo 3075 vs not reported',
    ],
    [
      'nothing reported',
      rev({ amountKobo: null, chargesKobo: null, totalKobo: null }),
      'amountKobo 10000 vs not reported, feeKobo 3075 vs not reported, totalKobo 13075 vs not reported',
    ],
  ])('%s: a difference', (_name, input, why) => {
    expect(reversalDisagreement(row(), input)).toBe(why);
  });

  it('a completed send, a send failed as absent, or one already reversed by another reversal: not one a reversal can follow', () => {
    expect(
      reversalDisagreement(
        row({ status: 'completed', failureReason: null }),
        rev(),
      ),
    ).toBe('the send is completed');
    expect(
      reversalDisagreement(
        row({ failureReason: LEDGER_ABSENT_FAILURE }),
        rev(),
      ),
    ).toBe('the send was failed as absent at Fintava');
    expect(
      reversalDisagreement(
        row({ status: 'reversed', reversalReference: 'r-0' }),
        rev(),
      ),
    ).toBe('already reversed by r-0');
    expect(
      reversalDisagreement(
        row({ status: 'completed', failureReason: null }),
        rev({ amountKobo: 20000 }),
      ),
    ).toBe('amountKobo 10000 vs 20000, the send is completed');
  });
});
