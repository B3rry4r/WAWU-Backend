// WALLET-10: the decisions that need no database. What a money-in
// notification says (amount from kobo, who sent it, the masked number), that it
// has no dash and no wallet language, which Z3 switch mutes it, that a phone is
// sent it, and the window's reading of the environment.

import {
  composeNotification,
  formatNairaFromKobo,
  moneyInMaskedAccount,
  moneyInSenderName,
  NOTIFICATION_CATEGORY,
} from '../../../notification/notification-event';
import { SETTINGS_GATE } from '../../../notification/notification.service';
import { PUSH_RULE, pushGateFor } from '../../../push/push-policy';
import { buildMessage } from '../../../push/push-message';
import {
  MONEY_IN_NOTICE_DEFAULTS,
  moneyInNoticeWindowMs,
} from '../money-in-notice-config';

/** An em-dash or an en-dash, written as escapes so this file has none. */
const DASHES = new RegExp('[\\u2014\\u2013]');

const U = 'user-1';
const money = (
  amountKobo: bigint,
  senderName?: string | null,
  senderAccountNumber?: string | null,
) =>
  composeNotification({
    kind: 'money_in',
    userWawuId: U,
    amountKobo,
    senderName,
    senderAccountNumber,
  });

describe('naira from kobo, exactly', () => {
  it.each([
    [0n, '₦0'],
    [5n, '₦0.05'],
    [10n, '₦0.10'],
    [99n, '₦0.99'],
    [100n, '₦1'],
    [101n, '₦1.01'],
    [150n, '₦1.50'],
    [99_999n, '₦999.99'],
    [100_000n, '₦1,000'],
    [123_456_789n, '₦1,234,567.89'],
    [500_000_000n, '₦5,000,000'],
    [900_719_925_474_099_100n, '₦9,007,199,254,740,991'],
    [9_007_199_254_740_991n, '₦90,071,992,547,409.91'],
    [-250n, '-₦2.50'],
  ])('%s kobo is %s', (kobo, text) => {
    expect(formatNairaFromKobo(kobo)).toBe(text);
  });

  it('is right for every kobo from 1 to 20000 (no float, no rounding)', () => {
    for (let k = 1n; k <= 20_000n; k += 1n) {
      const text = formatNairaFromKobo(k);
      const [whole, frac] = text.slice(1).replace(/,/g, '').split('.');
      expect(BigInt(whole) * 100n + BigInt((frac ?? '0').padEnd(2, '0'))).toBe(
        k,
      );
      expect(frac === undefined || frac.length === 2).toBe(true);
    }
  });
});

describe('the sender, made safe to show', () => {
  it('keeps an ordinary name as the bank wrote it', () => {
    expect(moneyInSenderName('ADA OBI')).toBe('ADA OBI');
    expect(moneyInSenderName('  Ada   Obi  ')).toBe('Ada Obi');
  });

  it('writes a dash a bank put in a name as a hyphen', () => {
    expect(moneyInSenderName('ADE—BAYO – TRADERS')).toBe('ADE-BAYO - TRADERS');
  });

  it('drops control, format and line characters', () => {
    expect(moneyInSenderName('ADA\u0000 ‮OBI​\n\tX')).toBe('ADA OBI X');
    expect(moneyInSenderName('​\u0007 \n')).toBeNull();
  });

  it('is null for nothing, a blank or a non-string', () => {
    for (const v of [null, undefined, '', '   ', 5 as unknown as string]) {
      expect(moneyInSenderName(v)).toBeNull();
    }
  });

  it('cuts a long name at 60 characters without splitting a pair', () => {
    const long = moneyInSenderName('A'.repeat(200));
    expect(Array.from(long ?? '').length).toBe(60);
    const emoji = moneyInSenderName('\u{1F600}'.repeat(100));
    expect(Array.from(emoji ?? '').length).toBe(60);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('masks a number to its last four digits, and only a number of six digits or more', () => {
    expect(moneyInMaskedAccount('0865231291')).toBe('****1291');
    expect(moneyInMaskedAccount('08 6523-1291')).toBe('****1291');
    expect(moneyInMaskedAccount('123456')).toBe('****3456');
    expect(moneyInMaskedAccount('12345')).toBeNull();
    expect(moneyInMaskedAccount('abcd')).toBeNull();
    expect(moneyInMaskedAccount(null)).toBeNull();
    expect(moneyInMaskedAccount(undefined)).toBeNull();
  });
});

describe('what the money-in notification says', () => {
  it('names the amount in naira from kobo, the sender and the masked number', () => {
    const d = money(10_000n, 'John Doe', '0865231291');
    expect(d).toMatchObject({
      userWawuId: U,
      kind: 'money_in',
      title: 'Money received',
      body: 'You received ₦100 from John Doe (****1291).',
      tone: 'success',
      amount: 100,
      creditsCount: null,
      actionLabel: null,
      imageUrl: null,
      actionHref: null,
      campaignId: null,
    });
  });

  it('keeps the kobo in the words, and leaves the whole-naira column empty when they are not whole', () => {
    const d = money(125_050n, 'John Doe', '0865231291');
    expect(d.body).toBe('You received ₦1,250.50 from John Doe (****1291).');
    expect(d.amount).toBeNull();
    expect(money(125_000n).amount).toBe(1250);
  });

  it('leaves the column empty for a credit too big for an Int', () => {
    expect(money(2_147_483_647n * 100n).amount).toBe(2_147_483_647);
    expect(money(2_147_483_648n * 100n).amount).toBeNull();
    expect(money(2_147_483_648n * 100n).body).toBe(
      'You received ₦2,147,483,648 by bank transfer.',
    );
  });

  it('says only the amount when the provider gave no name, even if it gave a number', () => {
    const d = money(500_000n, null, '0865231291');
    expect(d.body).toBe('You received ₦5,000 by bank transfer.');
    expect(d.body).not.toContain('1291');
    expect(money(500_000n, '   ', '0865231291').body).toBe(d.body);
    expect(money(500_000n).body).toBe(d.body);
  });

  it('shows a name without a number when the number is missing or too short', () => {
    expect(money(500_000n, 'Ada Obi', null).body).toBe(
      'You received ₦5,000 from Ada Obi.',
    );
    expect(money(500_000n, 'Ada Obi', '123').body).toBe(
      'You received ₦5,000 from Ada Obi.',
    );
  });

  it('never shows more than the last four digits of the number', () => {
    const d = money(10_000n, 'John Doe', '0865231291');
    expect(d.body).not.toContain('086523');
    expect(d.body).not.toContain('5231291');
  });

  it('has no dash, however the bank wrote the name', () => {
    for (const name of ['John Doe', 'ADE—BAYO', '–', 'A — B – C']) {
      const d = money(10_000n, name, '0865231291');
      expect(d.title).not.toMatch(DASHES);
      expect(d.body).not.toMatch(DASHES);
    }
  });

  it('uses no wallet, balance or cash-out language', () => {
    const d = money(10_000n, 'John Doe', '0865231291');
    expect(`${d.title} ${d.body}`).not.toMatch(
      /wallet|balance|withdraw|cash out|payout/i,
    );
  });

  it('shows under the Money chip', () => {
    expect(NOTIFICATION_CATEGORY.money_in).toBe('money');
  });
});

describe('the switch and the phone', () => {
  it('is muted by Z3 "Money in", in the list and on a phone', () => {
    expect(SETTINGS_GATE.money_in).toBe('moneyIn');
    expect(pushGateFor('money_in')).toBe('moneyIn');
  });

  it('is pushed to a phone with its own words and no more than the notification carries', () => {
    expect(PUSH_RULE.money_in).toBe('send');
    const d = money(10_000n, 'John Doe', '0865231291');
    const message = buildMessage(
      {
        id: 'n1',
        kind: d.kind,
        title: d.title,
        body: d.body,
        actionHref: d.actionHref,
        target: null,
      },
      'ExponentPushToken[abc]',
    );
    expect(message.title).toBe('Money received');
    expect(message.body).toBe(d.body);
    expect(message.data).toEqual({ notificationId: 'n1', kind: 'money_in' });
  });
});

describe('the window', () => {
  it('is 72 hours unless set, and a whole number of hours from 1 to 720 when set', () => {
    expect(moneyInNoticeWindowMs(undefined)).toBe(72 * 3_600_000);
    expect(moneyInNoticeWindowMs('')).toBe(72 * 3_600_000);
    expect(moneyInNoticeWindowMs(' 24 ')).toBe(24 * 3_600_000);
    expect(moneyInNoticeWindowMs('720')).toBe(720 * 3_600_000);
    for (const bad of ['0', '721', '1.5', '-3', 'abc', '1e3', '24h']) {
      expect(() => moneyInNoticeWindowMs(bad)).toThrow(/MONEY_IN_NOTICE/);
    }
  });

  it("keeps a pass shorter than the push sender's own pass allows", () => {
    expect(MONEY_IN_NOTICE_DEFAULTS.sweepSeconds).toBeGreaterThanOrEqual(1);
    expect(MONEY_IN_NOTICE_DEFAULTS.batch).toBeGreaterThan(0);
    expect(MONEY_IN_NOTICE_DEFAULTS.passes).toBeGreaterThan(0);
  });
});
