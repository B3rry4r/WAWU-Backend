// WALLET-39 (R-54): the decisions that need no database. What the notice for
// each kind of credit says, what its correction says, that neither prints an
// account number or a dash, where each ledger category is read from, which
// switch mutes what, and what a phone is sent.

import {
  composeNotification,
  moneyInShortName,
  NOTIFICATION_CATEGORY,
  type NotificationEvent,
} from '../../../notification/notification-event';
import { SETTINGS_GATE } from '../../../notification/notification.service';
import { buildMessage } from '../../../push/push-message';
import { PUSH_RULE, pushGateFor } from '../../../push/push-policy';
import { MONEY_IN_CATEGORIES } from '../money-in-notice-config';
import { creditedRows, reversedCredits } from '../money-in-notice.service';
import { creditSourceOf } from '../money-in-sources';

/** An em-dash or an en-dash, written as escapes so this file has none. */
const DASHES = new RegExp('[\\u2014\\u2013]');
/** Six or more digits in a row: nothing that long may reach a lock screen. */
const LONG_NUMBER = /\d{6,}/;

type In = Extract<NotificationEvent, { kind: 'money_in' }>;
type Reversed = Extract<NotificationEvent, { kind: 'money_in_reversed' }>;

const told = (o: Partial<In> = {}) =>
  composeNotification({
    kind: 'money_in',
    userWawuId: 'u',
    amountKobo: 500_000n,
    ...o,
  });
const taken = (o: Partial<Reversed> = {}) =>
  composeNotification({
    kind: 'money_in_reversed',
    userWawuId: 'u',
    amountKobo: 500_000n,
    ...o,
  });

describe('a person who sent money is "Tolu B."', () => {
  it('writes the first word and the last word as an initial', () => {
    expect(moneyInShortName('Tolu Bakare')).toBe('Tolu B.');
    expect(moneyInShortName('  Ada   Obi Nwosu ')).toBe('Ada N.');
    expect(moneyInShortName('Tolu B.')).toBe('Tolu B.');
  });
  it('keeps one word, and is null for nothing', () => {
    expect(moneyInShortName('Tolu')).toBe('Tolu');
    expect(moneyInShortName('  ')).toBeNull();
    expect(moneyInShortName(null)).toBeNull();
    expect(moneyInShortName(undefined)).toBeNull();
  });
  it('takes a dash out of the name, and never spells a surname', () => {
    expect(moneyInShortName('Ada\u2014Obi Nwosu-Eze')).toBe('Ada-Obi N.');
    expect(moneyInShortName('Ngozi Eze')).toBe('Ngozi E.');
  });
  it('keeps a letter from the second half of a pair whole', () => {
    expect(moneyInShortName('Tolu \u{1F600}ade')).toBe('Tolu \u{1F600}.');
  });
});

describe('what each notice says (R-54)', () => {
  it.each([
    [
      'a bank transfer with a named sender',
      {
        source: 'bank',
        senderName: 'Ada Obi',
        senderAccountNumber: '0865231291',
      },
      'Money received',
      'You received ₦5,000 from Ada Obi (****1291).',
      'The ₦5,000 you received from Ada Obi (****1291) was reversed.',
    ],
    [
      'a bank transfer with no name',
      { source: 'bank', senderAccountNumber: '0865231291' },
      'Money received',
      'You received ₦5,000 by bank transfer.',
      'The ₦5,000 bank transfer was reversed.',
    ],
    [
      'a bank transfer with a bank and a number but no person',
      {
        source: 'bank',
        senderBankName: 'GTBank',
        senderAccountNumber: '0123450921',
      },
      'Money received',
      'You received ₦5,000 from GTBank ****0921.',
      'The ₦5,000 you received from GTBank ****0921 was reversed.',
    ],
    [
      'a bank with no number',
      { source: 'bank', senderBankName: 'GTBank' },
      'Money received',
      'You received ₦5,000 from GTBank.',
      'The ₦5,000 you received from GTBank was reversed.',
    ],
    [
      'money from another person',
      {
        source: 'transfer',
        senderName: 'Tolu Bakare',
        senderAccountNumber: '8012345678',
      },
      'Money received',
      'You received ₦5,000 from Tolu B.',
      'The ₦5,000 you received from Tolu B. was reversed.',
    ],
    [
      'money from a person with no name on record',
      { source: 'transfer' },
      'Money received',
      'You received ₦5,000 from a WAWU user.',
      'The ₦5,000 you received from a WAWU user was reversed.',
    ],
    [
      'earnings',
      { source: 'earning', senderName: 'A Buyer' },
      'Earnings received',
      'You received ₦5,000 in earnings.',
      'The ₦5,000 in earnings was reversed.',
    ],
    [
      'a points cash-out',
      { source: 'points' },
      'Money received',
      'You received ₦5,000 from your points.',
      'The ₦5,000 from your points was reversed.',
    ],
    [
      'a refund',
      { source: 'refund' },
      'Refund received',
      'You received a refund of ₦5,000.',
      'The ₦5,000 refund was reversed.',
    ],
  ] as const)('%s', (_name, o, title, received, reversed) => {
    const a = told(o);
    expect(a).toMatchObject({
      kind: 'money_in',
      title,
      body: received,
      tone: 'success',
      amount: 5000,
    });
    const b = taken(o);
    expect(b).toMatchObject({
      kind: 'money_in_reversed',
      title: 'Money reversed',
      body: reversed,
      tone: 'warning',
      amount: null,
    });
    for (const d of [a, b]) {
      expect(`${d.title} ${d.body}`).not.toMatch(DASHES);
      expect(`${d.title} ${d.body}`).not.toMatch(LONG_NUMBER);
      expect(`${d.title} ${d.body}`).not.toMatch(
        /wallet|balance|withdraw|cash out|payout/i,
      );
    }
  });

  it('is exactly the WALLET-10 words when no source is given', () => {
    expect(
      told({ senderName: 'John Doe', senderAccountNumber: '0865231291' }).body,
    ).toBe('You received ₦5,000 from John Doe (****1291).');
    expect(told().body).toBe('You received ₦5,000 by bank transfer.');
  });

  it('says the kobo in the words and leaves the column empty', () => {
    const d = told({ source: 'refund', amountKobo: 125_050n });
    expect(d.body).toBe('You received a refund of ₦1,250.50.');
    expect(d.amount).toBeNull();
  });

  it('never prints a number beside a person from inside WAWU', () => {
    const d = told({
      source: 'transfer',
      senderName: 'Tolu Bakare',
      senderAccountNumber: '8012345678',
    });
    expect(d.body).not.toContain('8012345678');
    expect(d.body).not.toContain('5678');
  });

  it('has no dash however a name was written', () => {
    for (const name of [
      'Ada\u2014Obi',
      'Ada\u2013Obi Eze',
      'A\u2014B C\u2014D',
    ]) {
      const d = told({ source: 'transfer', senderName: name });
      expect(d.body).not.toMatch(DASHES);
      const r = taken({ source: 'transfer', senderName: name });
      expect(r.body).not.toMatch(DASHES);
    }
  });
});

describe('where a credit is read from', () => {
  const base = {
    linkKind: null,
    counterpartyKind: null,
    counterpartyName: null,
    counterpartyAccountNumber: null,
    counterpartyBankName: null,
  } as const;

  it('reads a bank transfer in with its sender, number and bank', () => {
    expect(
      creditSourceOf({
        ...base,
        category: 'top_up',
        counterpartyKind: 'bank_account',
        counterpartyName: 'Ada Obi',
        counterpartyAccountNumber: '0865231291',
        counterpartyBankName: 'GTBank',
      }),
    ).toEqual({
      source: 'bank',
      senderName: 'Ada Obi',
      senderAccountNumber: '0865231291',
      senderBankName: 'GTBank',
    });
  });

  it('reads money from another person by their name alone', () => {
    expect(
      creditSourceOf({
        ...base,
        category: 'transfer',
        counterpartyKind: 'wawu_user',
        counterpartyName: 'Tolu Bakare',
        counterpartyAccountNumber: '8012345678',
      }),
    ).toEqual({
      source: 'transfer',
      senderName: 'Tolu Bakare',
      senderAccountNumber: null,
      senderBankName: null,
    });
  });

  it('reads a transfer from a bank account as a bank transfer', () => {
    expect(
      creditSourceOf({
        ...base,
        category: 'transfer',
        counterpartyKind: 'bank_account',
        counterpartyName: 'Ada Obi',
      }).source,
    ).toBe('bank');
  });

  it('names nobody on earnings and refunds', () => {
    const buyer = {
      ...base,
      counterpartyKind: 'wawu_user',
      counterpartyName: 'A Buyer',
      counterpartyAccountNumber: '8012345678',
    } as const;
    expect(creditSourceOf({ ...buyer, category: 'earning' })).toEqual({
      source: 'earning',
      senderName: null,
      senderAccountNumber: null,
      senderBankName: null,
    });
    expect(
      creditSourceOf({
        ...buyer,
        category: 'earning',
        linkKind: 'points_cash_out',
      }).source,
    ).toBe('points');
    expect(creditSourceOf({ ...buyer, category: 'refund' })).toMatchObject({
      source: 'refund',
      senderName: null,
    });
  });
});

describe('which rows are money in', () => {
  it('are the four credit categories, on a person, from the provider that is running', () => {
    expect([...MONEY_IN_CATEGORIES]).toEqual([
      'top_up',
      'transfer',
      'earning',
      'refund',
    ]);
    const told = creditedRows('nuvion');
    expect(told).toMatchObject({
      direction: 'in',
      category: { in: ['top_up', 'transfer', 'earning', 'refund'] },
      walletKind: 'user',
      status: 'completed',
      discrepancy: null,
      moneyInNotice: null,
    });
    const undone = reversedCredits('nuvion');
    expect(undone).toMatchObject({
      direction: 'in',
      category: { in: ['top_up', 'transfer', 'earning', 'refund'] },
      walletKind: 'user',
      status: 'reversed',
      moneyInNotice: { is: { outcome: 'sent', correctedAt: null } },
    });
  });
});

describe('the switch and the phone', () => {
  it('keeps the credit under "Money in" and the Money chip', () => {
    expect(SETTINGS_GATE.money_in).toBe('moneyIn');
    expect(NOTIFICATION_CATEGORY.money_in).toBe('money');
    expect(NOTIFICATION_CATEGORY.money_in_reversed).toBe('money');
  });

  it('writes the correction to the list whatever the switch says, and mutes only its push', () => {
    expect(SETTINGS_GATE.money_in_reversed).toBeUndefined();
    expect(PUSH_RULE.money_in_reversed).toBe('send');
    expect(pushGateFor('money_in_reversed')).toBe('moneyIn');
  });

  it('hands a phone the transaction to open, for the notice and its correction', () => {
    for (const kind of ['money_in', 'money_in_reversed'] as const) {
      const d = composeNotification({
        kind,
        userWawuId: 'u',
        amountKobo: 500_000n,
        source: 'transfer',
        senderName: 'Tolu Bakare',
      });
      const message = buildMessage(
        {
          id: 'n1',
          kind: d.kind,
          title: d.title,
          body: d.body,
          actionHref: d.actionHref,
          target: { targetKind: 'transaction', targetId: 'entry-1' },
        },
        'ExponentPushToken[abc]',
      );
      expect(message.data).toEqual({
        notificationId: 'n1',
        kind,
        target: { kind: 'transaction', id: 'entry-1' },
      });
      expect(message.body).toBe(d.body);
    }
  });
});
