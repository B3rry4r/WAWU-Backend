// WALK4-FIX L-2 and the words of M-2 (no database). The credit a swap into naira writes must not be told as money from a
// person called "Swap U.", and the "ready" notice of a foreign account names its currency.

import {
  composeNotification,
  type NotificationEvent,
} from '../../../notification/notification-event';
import { creditSourceOf } from '../money-in-sources';

/** An em-dash or an en-dash, written as escapes so this file has none. */
const DASHES = new RegExp('[\\u2014\\u2013]');

type In = Extract<NotificationEvent, { kind: 'money_in' }>;

const swapRow = (name: string) => ({
  category: 'transfer',
  linkKind: null,
  counterpartyKind: 'wawu' as const,
  counterpartyName: name,
  counterpartyAccountNumber: null,
  counterpartyBankName: null,
});

const told = (o: Partial<In> = {}) =>
  composeNotification({
    kind: 'money_in',
    userWawuId: 'u',
    amountKobo: 92_080n,
    ...o,
  });

describe('L-2: the credit of a swap into naira is told as a swap, not as a person', () => {
  it('reads the ledger row the swap writes ("Swap from USD") as a swap', () => {
    expect(creditSourceOf(swapRow('Swap from USD'))).toMatchObject({
      source: 'swap',
      senderName: null,
    });
    expect(creditSourceOf(swapRow('Swap from USDT'))).toMatchObject({
      source: 'swap',
    });
  });

  it('says "Swap" and the amount added to the wallet, and names nobody', () => {
    const draft = told({
      ...creditSourceOf(swapRow('Swap from USD')),
    });
    expect(draft.title).toBe('Swap complete');
    expect(draft.body).toBe('Swap: ₦920.80 added to your wallet.');
    expect(`${draft.title} ${draft.body}`).not.toMatch(/from Swap|Swap U/);
    expect(JSON.stringify(draft)).not.toMatch(DASHES);
    expect(draft.tone).toBe('success');
  });

  it('keeps a whole-naira swap credit in the amount column, as any credit', () => {
    const draft = told({
      amountKobo: 150_000n,
      ...creditSourceOf(swapRow('Swap from EUR')),
    });
    expect(draft.amount).toBe(1500);
    expect(draft.body).toBe('Swap: ₦1,500 added to your wallet.');
  });

  it('corrects it in the same words when the ledger takes the credit back', () => {
    const draft = composeNotification({
      kind: 'money_in_reversed',
      userWawuId: 'u',
      amountKobo: 92_080n,
      ...creditSourceOf(swapRow('Swap from USD')),
    });
    expect(draft.body).toContain('swap');
    expect(draft.body).toContain('₦920.80');
    expect(draft.body).not.toMatch(/Swap U/);
    expect(JSON.stringify(draft)).not.toMatch(DASHES);
  });

  it('leaves a person who is really called that, and every other transfer, as they were', () => {
    // Not a WAWU-side counterparty: a bank account row is a bank transfer in.
    expect(
      creditSourceOf({
        ...swapRow('Swap from USD'),
        counterpartyKind: 'bank_account',
      }).source,
    ).toBe('bank');
    // A person-to-person send keeps its name.
    expect(creditSourceOf(swapRow('Tolu Bakare'))).toMatchObject({
      source: 'transfer',
      senderName: 'Tolu Bakare',
    });
    // The debit side's words are not a credit's: only "Swap from <code>" is a swap credit.
    expect(creditSourceOf(swapRow('Swap to USD')).source).toBe('transfer');
    expect(creditSourceOf(swapRow('Swap from my friend')).source).toBe(
      'transfer',
    );
  });
});

describe('M-2: the "ready" notice of a foreign account names its currency', () => {
  it('says "Your USD account is ready" for a dollar account', () => {
    const draft = composeNotification({
      kind: 'wallet_ready',
      userWawuId: 'u',
      currency: 'USD',
    });
    expect(draft.title).toBe('Your USD account is ready');
    expect(draft.kind).toBe('wallet_ready');
    expect(JSON.stringify(draft)).not.toMatch(DASHES);
    expect(JSON.stringify(draft)).not.toMatch(/\d{6,}/);
  });

  it('keeps the naira words when no currency is named', () => {
    const draft = composeNotification({
      kind: 'wallet_ready',
      userWawuId: 'u',
    });
    expect(draft.title).toBe('Your account number is ready');
  });
});
