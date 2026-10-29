/* eslint-disable @typescript-eslint/require-await -- stand-ins for async services */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  CONTRACT_FIELDS,
  WawuIdNoticeDouble,
} from '../../../test/money/wawu-id-notice-double';
import type { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  cleanNoticeData,
  NOTICE_FIELDS,
  NOTICE_KINDS,
  type NoticeKind,
} from '../notice-kinds';
import { MONEY_EMAILS_SWITCH, NoticeMailer, noticeKey } from '../notice-mailer';

/**
 * The mailer for money and account notices (EMAIL-02), against a stand-in for
 * WAWU ID's `POST /internal/mail/notice`: what leaves the Hub, the retry rule,
 * the switch, the after-commit scope, and that no address or markup goes out.
 */

const double = new WawuIdNoticeDouble();
let env: Record<string, string | undefined> = {};
let switchValue: number | Error = 1;
let errors: string[] = [];

const config = { get: (k: string) => env[k] } as unknown as ConfigService;
const settings = {
  number: (k: string) => {
    if (k !== MONEY_EMAILS_SWITCH) throw new Error('unknown setting');
    if (switchValue instanceof Error) throw switchValue;
    return switchValue;
  },
} as unknown as PlanSettingsService;

const mailer = () => new NoticeMailer(config, settings);

const MONEY_IN = {
  amountMinor: 500_000,
  currency: 'NGN',
  senderName: 'Ada Obi',
};

beforeAll(async () => {
  await double.start();
  jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((m: unknown) => void errors.push(String(m)));
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await double.stop();
});
beforeEach(() => {
  double.reset();
  errors = [];
  switchValue = 1;
  env = {
    WAWU_ID_BASE_URL: double.baseUrl,
    WAWU_ID_INTERNAL_SERVICE_KEY: double.serviceKey,
    NOTICE_MAIL_RETRY_MS: '5',
  };
});

describe('what leaves the Hub', () => {
  it('is the person, the kind, the facts and the key, and nothing else', async () => {
    const m = mailer();
    m.notify(
      'wawu-person-1',
      'money_in',
      MONEY_IN,
      noticeKey('money_in', 'row1'),
    );
    await m.settled();
    expect(double.requests).toHaveLength(1);
    const r = double.requests[0];
    expect(r.serviceKey).toBe(double.serviceKey);
    expect(Object.keys(r.body).sort()).toEqual([
      'data',
      'idempotencyKey',
      'kind',
      'wawuId',
    ]);
    expect(r.body).toEqual({
      wawuId: 'wawu-person-1',
      kind: 'money_in',
      data: MONEY_IN,
      idempotencyKey: 'money_in-row1',
    });
    expect(double.sent).toHaveLength(1);
  });

  it('keeps the Hub field lists equal to the contract for every kind', () => {
    for (const kind of NOTICE_KINDS) {
      expect(Object.keys(NOTICE_FIELDS[kind]).sort()).toEqual(
        [...CONTRACT_FIELDS[kind]].sort(),
      );
    }
    expect(Object.keys(CONTRACT_FIELDS).sort()).toEqual(
      [...NOTICE_KINDS].sort(),
    );
  });

  it('removes markup characters and refuses text that is an email address', () => {
    const cleaned = cleanNoticeData('money_in', {
      ...MONEY_IN,
      senderName: '<b>Ada</b>\n  Obi',
    });
    expect(cleaned?.senderName).toBe('b Ada /b Obi');
    expect(JSON.stringify(cleaned)).not.toMatch(/[<>]/);
    expect(
      cleanNoticeData('money_in', {
        ...MONEY_IN,
        senderName: 'ada@example.com',
      }),
    ).toBeNull();
  });

  it('refuses facts that do not fit the kind: an extra field, a missing one, a non-integer amount, a bad time', async () => {
    expect(
      cleanNoticeData('money_in', { ...MONEY_IN, email: 'a@b.co' }),
    ).toBeNull();
    expect(cleanNoticeData('money_in', { currency: 'NGN' })).toBeNull();
    expect(
      cleanNoticeData('money_in', { ...MONEY_IN, amountMinor: 10.5 }),
    ).toBeNull();
    expect(
      cleanNoticeData('money_in', { ...MONEY_IN, amountMinor: -1 }),
    ).toBeNull();
    expect(cleanNoticeData('pin_changed', { at: 'yesterday' })).toBeNull();
    expect(cleanNoticeData('account_deleted', {})).toEqual({});
    const m = mailer();
    m.notify(
      'p1-person',
      'money_in',
      { ...MONEY_IN, amountMinor: 1.5 },
      'money_in-bad1',
    );
    await m.settled();
    expect(double.requests).toHaveLength(0);
    expect(errors.join(' ')).toContain('money_in money_in-bad1');
  });

  it('accepts the sample of every kind the double accepts', async () => {
    const at = '2026-10-29T10:00:00.000Z';
    const samples: Record<NoticeKind, Record<string, unknown>> = {
      pin_changed: { at },
      account_deletion_started: { deleteOn: at },
      account_deleted: {},
      money_in: MONEY_IN,
      bank_send_completed: {
        amountMinor: 1,
        feeMinor: 6500,
        currency: 'NGN',
        recipientName: 'Ada Obi',
        bankName: 'Access Bank',
        accountLast4: '1234',
        reference: 'WAWU-1',
      },
      bank_send_failed: {
        amountMinor: 1,
        returnedMinor: 2,
        currency: 'NGN',
        reference: 'WAWU-1',
      },
      sale_made: {
        itemTitle: 'A song',
        buyerName: null,
        earnedMinor: 85_000,
        currency: 'NGN',
        paidWhen: 'now',
      },
      tip_received: {
        earnedMinor: 85_000,
        currency: 'NGN',
        fromName: null,
        paidWhen: 'when_wallet_opens',
      },
      paid_message_received: {
        fromName: 'Ada',
        earnedMinor: 85_000,
        currency: 'NGN',
        replyBy: at,
      },
      refund_processed: {
        what: 'A question',
        amountMinor: null,
        currency: null,
        returnedTo: 'question_credit',
      },
      purchase_receipt: {
        itemTitle: 'A song',
        paidMinor: 100_000,
        currency: 'NGN',
        reference: 'pay-1',
      },
      ticket_confirmed: {
        eventTitle: 'Show',
        startsAt: at,
        place: null,
        paidMinor: 0,
        currency: 'NGN',
        ticketRef: 'T-1',
      },
      event_cancelled: {
        eventTitle: 'Show',
        refundMinor: null,
        currency: null,
      },
      bill_paid: {
        billerName: 'IKEDC',
        customerRef: '45012345678',
        amountMinor: 500_000,
        currency: 'NGN',
        token: '1234 5678 9012 3456 7890',
        units: '23.5',
        reference: 'bill-1',
      },
    };
    const m = mailer();
    for (const kind of NOTICE_KINDS) {
      m.notify(
        'wawu-person-1',
        kind,
        samples[kind] as never,
        noticeKey(kind, 'sample'),
      );
    }
    await m.settled();
    expect(errors).toEqual([]);
    expect(double.sent.map((r) => r.body.kind).sort()).toEqual(
      [...NOTICE_KINDS].sort(),
    );
  });
});

describe('the relay', () => {
  it('is asked again when busy, then succeeds', async () => {
    double.failNext = { count: 2, status: 503 };
    const m = mailer();
    m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-busy1');
    await m.settled();
    expect(double.requests).toHaveLength(3);
    expect(double.sent).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('is asked three times in all when it stays busy, then given up, by kind and key only', async () => {
    double.failNext = { count: 99, status: 502 };
    const m = mailer();
    m.notify('wawu-secret-person', 'money_in', MONEY_IN, 'money_in-busy2');
    await m.settled();
    expect(double.requests).toHaveLength(3);
    expect(double.sent).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('money_in money_in-busy2');
    expect(errors[0]).not.toContain('wawu-secret-person');
    expect(errors[0]).not.toContain('Ada');
    expect(errors[0]).not.toContain('500000');
  });

  it('is not asked again after a 400', async () => {
    double.failNext = { count: 99, status: 400 };
    const m = mailer();
    m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-bad400');
    await m.settled();
    expect(double.requests).toHaveLength(1);
    expect(errors.join(' ')).toContain('answered 400');
  });

  it('is not asked again after a 429 or a refused key', async () => {
    double.failNext = { count: 99, status: 429 };
    const m = mailer();
    m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-cap001');
    await m.settled();
    expect(double.requests).toHaveLength(1);
    double.reset();
    env.WAWU_ID_INTERNAL_SERVICE_KEY = 'wrong-key';
    m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-key001');
    await m.settled();
    expect(double.requests).toHaveLength(1);
    expect(double.sent).toHaveLength(0);
  });

  it('being down does not throw, and the caller is not held', async () => {
    env.WAWU_ID_BASE_URL = 'http://127.0.0.1:1';
    const m = mailer();
    const started = Date.now();
    expect(() =>
      m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-down01'),
    ).not.toThrow();
    expect(Date.now() - started).toBeLessThan(50);
    await expect(
      m.notifyNow('wawu-person-1', 'money_in', MONEY_IN, 'money_in-down02'),
    ).resolves.toBeUndefined();
    await m.settled();
    expect(errors.length).toBe(2);
  });

  it('sends nothing when WAWU ID is not set up on this server', async () => {
    env = {};
    const m = mailer();
    m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-unset1');
    await m.settled();
    expect(double.requests).toHaveLength(0);
  });
});

describe('the switch notifications.money_emails_on', () => {
  it('off sends none, on sends, and an unreadable switch leaves them on', async () => {
    const m = mailer();
    switchValue = 0;
    m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-sw0001');
    await m.settled();
    expect(double.requests).toHaveLength(0);
    switchValue = 1;
    m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-sw0002');
    await m.settled();
    expect(double.sent).toHaveLength(1);
    switchValue = new Error('db down');
    m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-sw0003');
    await m.settled();
    expect(double.sent).toHaveLength(2);
  });
});

describe('after the commit', () => {
  it('holds a notice raised inside within() until the work returns', async () => {
    const m = mailer();
    let during = -1;
    await m.within(async () => {
      m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-wi0001');
      await m.settled();
      during = double.requests.length;
    });
    await m.settled();
    expect(during).toBe(0);
    expect(double.sent).toHaveLength(1);
  });

  it('drops a notice when the work throws (a rolled-back move)', async () => {
    const m = mailer();
    await expect(
      m.within(async () => {
        m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-wi0002');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await m.settled();
    expect(double.requests).toHaveLength(0);
  });

  it('joins an outer scope, so nothing is sent while the outer work is still open', async () => {
    const m = mailer();
    let afterInner = -1;
    await m.within(async () => {
      await m.within(async () => {
        m.notify('wawu-person-1', 'money_in', MONEY_IN, 'money_in-wi0003');
      });
      await m.settled();
      afterInner = double.requests.length;
    });
    await m.settled();
    expect(afterInner).toBe(0);
    expect(double.sent).toHaveLength(1);
  });
});

describe('noticeKey', () => {
  it('is 8 to 128 of letters, digits, underscore and hyphen, and the same for the same event', () => {
    const a = noticeKey('pin_changed', 'user id:1', 1_700_000_000_000);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(noticeKey('pin_changed', 'user id:1', 1_700_000_000_000)).toBe(a);
    expect(noticeKey('account_deleted', 'x'.repeat(500))).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
    expect(noticeKey('money_in', 'a')).not.toBe(noticeKey('money_in', 'b'));
  });
});
