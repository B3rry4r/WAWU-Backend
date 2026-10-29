/**
 * The money and account notices the Hub asks WAWU ID to email (EMAIL-02).
 *
 * The Hub names the person (`wawuId`), the kind and the facts. WAWU ID finds
 * the address, writes the email and sends it. So the Hub never holds an
 * address and never writes HTML: `data` below is plain facts, whole minor
 * units (kobo, cents) with a currency code, ISO times, and short plain text.
 * The contract is `POST /internal/mail/notice` (EMAIL-01, WAWU ID).
 */
export const NOTICE_KINDS = [
  'pin_changed',
  'account_deletion_started',
  'account_deleted',
  'money_in',
  'bank_send_completed',
  'bank_send_failed',
  'sale_made',
  'tip_received',
  'paid_message_received',
  'refund_processed',
  'purchase_receipt',
  'ticket_confirmed',
  'event_cancelled',
  'bill_paid',
  'pass_sold',
  'question_earned',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** When a creator's money reaches the wallet (R-11, R-101). */
export type PaidWhen = 'now' | 'in_3_working_days' | 'when_wallet_opens';
export const PAID_WHEN: readonly PaidWhen[] = [
  'now',
  'in_3_working_days',
  'when_wallet_opens',
];

/** Where a refund went. */
export type ReturnedTo =
  'wallet' | 'card' | 'source_account' | 'question_credit';
export const RETURNED_TO: readonly ReturnedTo[] = [
  'wallet',
  'card',
  'source_account',
  'question_credit',
];

export interface NoticeData {
  pin_changed: { at: string };
  account_deletion_started: { deleteOn: string };
  account_deleted: Record<string, never>;
  money_in: {
    amountMinor: number;
    currency: string;
    senderName: string | null;
  };
  bank_send_completed: {
    amountMinor: number;
    feeMinor: number;
    currency: string;
    recipientName: string;
    bankName: string;
    accountLast4: string;
    reference: string;
  };
  bank_send_failed: {
    amountMinor: number;
    returnedMinor: number;
    currency: string;
    reference: string;
  };
  sale_made: {
    itemTitle: string;
    buyerName: string | null;
    earnedMinor: number;
    currency: string;
    paidWhen: PaidWhen;
  };
  tip_received: {
    earnedMinor: number;
    currency: string;
    fromName: string | null;
    paidWhen: PaidWhen;
  };
  paid_message_received: {
    fromName: string | null;
    earnedMinor: number;
    currency: string;
    replyBy: string;
  };
  refund_processed: {
    what: string;
    amountMinor: number | null;
    currency: string | null;
    returnedTo: ReturnedTo;
  };
  purchase_receipt: {
    itemTitle: string;
    paidMinor: number;
    currency: string;
    reference: string;
  };
  ticket_confirmed: {
    eventTitle: string;
    startsAt: string;
    place: string | null;
    paidMinor: number;
    currency: string;
    ticketRef: string;
  };
  event_cancelled: {
    eventTitle: string;
    refundMinor: number | null;
    currency: string | null;
  };
  pass_sold: {
    communityName: string;
    buyerName: string | null;
    earnedMinor: number;
    currency: string;
    paidWhen: PaidWhen;
  };
  question_earned: {
    fromName: string | null;
    earnedMinor: number;
    currency: string;
    paidWhen: PaidWhen;
  };
  bill_paid: {
    billerName: string;
    customerRef: string;
    amountMinor: number;
    currency: string;
    token: string | null;
    units: string | null;
    reference: string;
  };
}

type FieldRule =
  | { t: 'text'; max: number; nullable?: boolean }
  | { t: 'iso'; nullable?: boolean }
  | { t: 'minor'; nullable?: boolean }
  | { t: 'currency'; nullable?: boolean }
  | { t: 'last4' }
  | { t: 'enum'; of: readonly string[] };

const text = (max: number, nullable = false): FieldRule => ({
  t: 'text',
  max,
  nullable,
});
const iso: FieldRule = { t: 'iso' };
const minor: FieldRule = { t: 'minor' };
const minorOrNull: FieldRule = { t: 'minor', nullable: true };
const currency: FieldRule = { t: 'currency' };
const currencyOrNull: FieldRule = { t: 'currency', nullable: true };

/** Exactly these fields go out for a kind: no more, no fewer. */
export const NOTICE_FIELDS: Record<NoticeKind, Record<string, FieldRule>> = {
  pin_changed: { at: iso },
  account_deletion_started: { deleteOn: iso },
  account_deleted: {},
  money_in: {
    amountMinor: minor,
    currency,
    senderName: text(120, true),
  },
  bank_send_completed: {
    amountMinor: minor,
    feeMinor: minor,
    currency,
    recipientName: text(120),
    bankName: text(120),
    accountLast4: { t: 'last4' },
    reference: text(80),
  },
  bank_send_failed: {
    amountMinor: minor,
    returnedMinor: minor,
    currency,
    reference: text(80),
  },
  sale_made: {
    itemTitle: text(200),
    buyerName: text(120, true),
    earnedMinor: minor,
    currency,
    paidWhen: { t: 'enum', of: PAID_WHEN },
  },
  tip_received: {
    earnedMinor: minor,
    currency,
    fromName: text(120, true),
    paidWhen: { t: 'enum', of: PAID_WHEN },
  },
  paid_message_received: {
    fromName: text(120, true),
    earnedMinor: minor,
    currency,
    replyBy: iso,
  },
  refund_processed: {
    what: text(200),
    amountMinor: minorOrNull,
    currency: currencyOrNull,
    returnedTo: { t: 'enum', of: RETURNED_TO },
  },
  purchase_receipt: {
    itemTitle: text(200),
    paidMinor: minor,
    currency,
    reference: text(80),
  },
  ticket_confirmed: {
    eventTitle: text(200),
    startsAt: iso,
    place: text(200, true),
    paidMinor: minor,
    currency,
    ticketRef: text(80),
  },
  event_cancelled: {
    eventTitle: text(200),
    refundMinor: minorOrNull,
    currency: currencyOrNull,
  },
  pass_sold: {
    communityName: text(120),
    buyerName: text(120, true),
    earnedMinor: minor,
    currency,
    paidWhen: { t: 'enum', of: PAID_WHEN },
  },
  question_earned: {
    fromName: text(120, true),
    earnedMinor: minor,
    currency,
    paidWhen: { t: 'enum', of: PAID_WHEN },
  },
  bill_paid: {
    billerName: text(120),
    customerRef: text(60),
    amountMinor: minor,
    currency,
    token: text(60, true),
    units: text(30, true),
    reference: text(80),
  },
};

// eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
const CONTROL_OR_BRACKET = /[\u0000-\u001f\u007f<>]/g;

/**
 * Plain text only: no angle brackets (so no markup can be formed), no control
 * characters, one space between words, at most `max` characters.
 */
export function plainText(value: string, max: number): string {
  return value
    .replace(CONTROL_OR_BRACKET, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const CURRENCY_SHAPE = /^[A-Z]{3,6}$/;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * The data of one notice, checked and cleaned against the kind's fields.
 * Returns null when it cannot go out as it is: a missing or extra field, a
 * figure that is not a whole number of minor units, a time that is not ISO,
 * an empty required text, or text that looks like an email address (the Hub
 * sends no address, so a name field that holds one is refused, not sent).
 */
export function cleanNoticeData(
  kind: NoticeKind,
  data: unknown,
): Record<string, unknown> | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const rules = NOTICE_FIELDS[kind];
  const given = data as Record<string, unknown>;
  const names = Object.keys(rules);
  if (Object.keys(given).some((k) => !names.includes(k))) return null;
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const rule = rules[name];
    const v = given[name];
    if (v === null || v === undefined) {
      if ('nullable' in rule && rule.nullable === true) {
        out[name] = null;
        continue;
      }
      return null;
    }
    switch (rule.t) {
      case 'text': {
        if (typeof v !== 'string') return null;
        const t = plainText(v, rule.max);
        if (t === '' || EMAIL_SHAPE.test(t)) {
          if (rule.nullable === true && t === '') {
            out[name] = null;
            break;
          }
          return null;
        }
        out[name] = t;
        break;
      }
      case 'iso':
        if (typeof v !== 'string' || !ISO_SHAPE.test(v)) return null;
        out[name] = v;
        break;
      case 'minor':
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
          return null;
        }
        out[name] = v;
        break;
      case 'currency':
        if (typeof v !== 'string' || !CURRENCY_SHAPE.test(v)) return null;
        out[name] = v;
        break;
      case 'last4':
        if (typeof v !== 'string' || !/^\d{4}$/.test(v)) return null;
        out[name] = v;
        break;
      case 'enum':
        if (typeof v !== 'string' || !rule.of.includes(v)) return null;
        out[name] = v;
        break;
    }
  }
  // A refund's amount and currency go together.
  if (kind === 'refund_processed' || kind === 'event_cancelled') {
    const amount =
      out[kind === 'event_cancelled' ? 'refundMinor' : 'amountMinor'];
    if ((amount === null) !== (out.currency === null)) return null;
  }
  return out;
}
