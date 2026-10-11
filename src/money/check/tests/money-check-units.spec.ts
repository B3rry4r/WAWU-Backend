import { ConfigService } from '@nestjs/config';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import {
  MoneyCheckConfigError,
  MoneyCheckSettings,
  recipientsSetting,
  timeSetting,
  wholeSetting,
} from '../money-check-config';
import {
  mailOf,
  MoneyCheckMailer,
  MoneyCheckMailRefused,
  plainRef,
  plainSentence,
} from '../money-check-mailer';
import { FindingSink } from '../money-check-sink';
import { isNight, lagosMinuteOfDay, lagosNight } from '../money-check-time';
import {
  CHECK_IDS,
  type Finding,
  type MoneyCheckReport,
  REPORT_KEEP,
  REPORT_MAIL,
} from '../money-check-types';
import {
  failureOf,
  failureReport,
  failureText,
  RUN_DIED,
  storedFailure,
  verdictOf,
} from '../money-check.service';

/** The settings, the clock, the sink, the verdict and the email's shape (task MONEY-16). */

function settings(values: Record<string, string> = {}): MoneyCheckSettings {
  return new MoneyCheckSettings({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

describe('the settings', () => {
  it('take their defaults when left empty', () => {
    const s = settings();
    expect(s.minuteOfDay).toBe(2 * 60 + 30);
    expect(s.recipients).toEqual([]);
    expect(s.settleMs).toBe(30 * 60_000);
    expect(s.overlapMs).toBe(96 * 3_600_000);
    expect(s.lookbackMs).toBe(35 * 24 * 3_600_000);
    expect(s.historyPages).toBe(30);
    expect(s.feeLookups).toBe(2000);
  });

  it('read the hour, the recipients and the limits', () => {
    const s = settings({
      MONEY_CHECK_TIME: '23:05',
      MONEY_CHECK_RECIPIENT_WAWU_IDS: 'a1b2, c3d4 ,a1b2',
      MONEY_CHECK_SETTLE_MINUTES: '45',
      MONEY_CHECK_HISTORY_PAGES: '5',
    });
    expect(s.minuteOfDay).toBe(23 * 60 + 5);
    expect(s.recipients).toEqual(['a1b2', 'c3d4']);
    expect(s.settleMs).toBe(45 * 60_000);
    expect(s.historyPages).toBe(5);
  });

  it('turn the schedule off with `off`', () => {
    expect(timeSetting('off')).toBeNull();
    expect(timeSetting(' OFF ')).toBeNull();
    expect(settings({ MONEY_CHECK_TIME: 'off' }).minuteOfDay).toBeNull();
  });

  it.each(['2:30', '24:00', '02:60', 'noon', '02.30', '0230'])(
    'refuse the time %s, naming the setting',
    (bad) => {
      expect(() => timeSetting(bad)).toThrow(MoneyCheckConfigError);
      expect(() => timeSetting(bad)).toThrow(/MONEY_CHECK_TIME/);
    },
  );

  it('refuse a number outside its range and a recipient that is not an id', () => {
    expect(() => wholeSetting('4', 'K', 1, 5, 9)).toThrow(
      /K must be a whole number from 5 to 9/,
    );
    expect(() => wholeSetting('1.5', 'K', 1, 0, 9)).toThrow(
      MoneyCheckConfigError,
    );
    expect(() => wholeSetting('-1', 'K', 1, 0, 9)).toThrow(
      MoneyCheckConfigError,
    );
    expect(wholeSetting('', 'K', 7, 0, 9)).toBe(7);
    expect(() => recipientsSetting('ok, bad id')).toThrow(/WAWU ids/);
    expect(() => settings({ MONEY_CHECK_CALL_GAP_MS: '99999' })).toThrow(
      /MONEY_CHECK_CALL_GAP_MS/,
    );
  });
});

describe('the Lagos night', () => {
  it('is the calendar date in Lagos, which is an hour ahead of UTC', () => {
    expect(lagosNight(new Date('2026-10-11T22:59:00Z'))).toBe('2026-10-11');
    expect(lagosNight(new Date('2026-10-11T23:00:00Z'))).toBe('2026-10-12');
    expect(lagosMinuteOfDay(new Date('2026-10-11T23:00:00Z'))).toBe(0);
    expect(lagosMinuteOfDay(new Date('2026-10-12T01:30:00Z'))).toBe(
      2 * 60 + 30,
    );
  });

  it('knows a real date from a made-up one', () => {
    expect(isNight('2026-10-12')).toBe(true);
    expect(isNight('2026-02-30')).toBe(false);
    expect(isNight('2026-1-2')).toBe(false);
    expect(isNight('tonight')).toBe(false);
  });
});

function finding(over: Partial<Finding> = {}): Finding {
  return {
    check: 'movements',
    severity: 'mismatch',
    kind: 'provider_only',
    ref: 'r1',
    detail: 'Something differs.',
    ...over,
  };
}

describe('the finding sink', () => {
  it('keeps what a report holds and counts the rest', () => {
    const sink = new FindingSink();
    for (let i = 0; i < REPORT_KEEP + 40; i += 1)
      sink.add(finding({ ref: `m${i}` }));
    for (let i = 0; i < 3; i += 1) {
      sink.add(
        finding({ severity: 'look', check: 'holds', kind: 'hold_in_review' }),
      );
    }
    sink.skipped('holds', 'look', 7);
    expect(sink.mismatches).toHaveLength(REPORT_KEEP);
    expect(sink.mismatchCount).toBe(REPORT_KEEP + 40);
    expect(sink.omitted.mismatches).toBe(40);
    expect(sink.lookCount).toBe(10);
    expect(sink.omitted.look).toBe(7);
  });

  it('summarises each check in order, a mismatch beating a look, a look beating ok', () => {
    const sink = new FindingSink();
    sink.add(finding());
    sink.add(
      finding({ check: 'holds', severity: 'look', kind: 'hold_in_review' }),
    );
    sink.compared('movements', 12);
    sink.cannot('balances', 'incomplete', 'Two wallets could not be read.');
    sink.cannot('merchant_charges', 'not_checked', 'Not asked.');
    const byId = Object.fromEntries(sink.summaries().map((s) => [s.id, s]));
    expect(sink.summaries().map((s) => s.id)).toEqual([...CHECK_IDS]);
    expect(byId.movements).toMatchObject({
      state: 'differences',
      checked: 12,
      found: 1,
    });
    expect(byId.holds.state).toBe('needs_a_look');
    expect(byId.balances).toMatchObject({
      state: 'incomplete',
      note: 'Two wallets could not be read.',
    });
    expect(byId.merchant_charges.state).toBe('not_checked');
    expect(byId.payments).toMatchObject({ state: 'ok', found: 0, note: null });
  });

  it('lets a check that was not made at all stay not made, whatever else is said about it', () => {
    const sink = new FindingSink();
    sink.cannot('balances', 'not_checked', 'a');
    sink.cannot('balances', 'incomplete', 'b');
    const s = sink.summaries().find((x) => x.id === 'balances')!;
    expect(s.state).toBe('not_checked');
    expect(s.note).toBe('a b');
  });

  it('adds up notices and the money they stand for', () => {
    const sink = new FindingSink();
    sink.notice('x', 2, 500n);
    sink.mergeNotices({ x: { count: 1, amountKobo: '250' }, y: { count: 3 } });
    sink.notice('z', 0);
    expect(sink.notices).toEqual({
      x: { count: 3, amountKobo: '750' },
      y: { count: 3 },
    });
  });
});

function reportWith(
  checks: Array<[string, string]>,
  wallets: Partial<MoneyCheckReport['wallets']> = {},
): Pick<MoneyCheckReport, 'checks' | 'wallets'> {
  return {
    checks: checks.map(([id, state]) => ({
      id: id as MoneyCheckReport['checks'][number]['id'],
      state: state as MoneyCheckReport['checks'][number]['state'],
      checked: 0,
      found: 0,
      note: null,
    })),
    wallets: { total: 3, checked: 3, notChecked: {}, ...wallets },
  };
}

describe('the verdict', () => {
  const ok = [
    ['movements', 'ok'],
    ['merchant_movements', 'ok'],
    ['balances', 'ok'],
    ['holds', 'ok'],
  ] as Array<[string, string]>;

  it('is clean only when every comparison was made and nothing was found', () => {
    expect(verdictOf(reportWith(ok), 0, 0)).toBe('clean');
  });

  it('is differences when anything differs, whatever else is missing', () => {
    expect(verdictOf(reportWith(ok), 1, 0)).toBe('differences');
    expect(
      verdictOf(
        reportWith([
          ['movements', 'not_checked'],
          ['balances', 'not_checked'],
        ]),
        2,
        0,
      ),
    ).toBe('differences');
  });

  it('is needs_a_look when nothing differs and a person has something to decide', () => {
    expect(verdictOf(reportWith(ok), 0, 4)).toBe('needs_a_look');
  });

  it('is never clean when a wallet was not checked or a check was not made in full', () => {
    expect(
      verdictOf(
        reportWith(ok, { checked: 2, notChecked: { unreadable: 1 } }),
        0,
        0,
      ),
    ).toBe('incomplete');
    expect(
      verdictOf(reportWith([...ok, ['merchant_charges', 'incomplete']]), 0, 0),
    ).toBe('incomplete');
    expect(
      verdictOf(reportWith([...ok, ['held_money', 'not_checked']]), 0, 3),
    ).toBe('incomplete');
  });

  it('is not_checked when nothing could be compared with the provider', () => {
    expect(
      verdictOf(
        reportWith([
          ['movements', 'not_checked'],
          ['merchant_movements', 'not_checked'],
          ['balances', 'not_checked'],
        ]),
        0,
        0,
      ),
    ).toBe('not_checked');
  });

  it('says a provider that answers one comparison and not another is incomplete, not clean', () => {
    expect(
      verdictOf(
        reportWith([
          ['movements', 'not_checked'],
          ['merchant_movements', 'not_checked'],
          ['balances', 'ok'],
        ]),
        0,
        0,
      ),
    ).toBe('incomplete');
  });
});

describe('a night that could not be made', () => {
  it('is reported as incomplete in every check, with the reason, never as clean', () => {
    const r = failureReport(
      'fintava',
      '2026-10-12',
      new Date('2026-10-12T01:30:00Z'),
      new Date('2026-10-12T02:10:00Z'),
      failureOf(
        new WalletProviderError({
          kind: 'unavailable',
          provider: 'fintava',
          operation: 'getBalance',
        }),
      ),
    );
    expect(r.verdict).toBe('incomplete');
    expect(r.checks).toHaveLength(CHECK_IDS.length);
    expect(r.checks.every((c) => c.state === 'incomplete')).toBe(true);
    expect(r.checks[0].note).toBe(
      'The run did not finish. The wallet provider failed while the check was reading from it. (provider_unavailable).',
    );
    expect(r.mismatches).toEqual([]);
  });

  it('says the run did not finish once, not twice, when it has no reason to give (VF-7)', () => {
    const r = failureReport(
      'fintava',
      '2026-10-12',
      new Date('2026-10-12T01:30:00Z'),
      new Date('2026-10-12T02:10:00Z'),
    );
    expect(r.checks[0].note).toBe('The run did not finish.');
    const lost = failureReport(
      'fintava',
      '2026-10-12',
      new Date('2026-10-12T01:30:00Z'),
      new Date('2026-10-12T02:10:00Z'),
      RUN_DIED,
    );
    expect(lost.checks[0].note).toBe(
      'The run did not finish. The run stopped before it finished and was not made again. (run_died).',
    );
    expect(lost.checks[0].note?.match(/did not finish/g)).toHaveLength(1);
  });
});

describe('why a night failed (VF-8)', () => {
  it('is a code and one fixed sentence, whatever the error said', () => {
    const plain = failureOf(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
    );
    expect(plain).toEqual({
      code: 'internal_error',
      sentence:
        'The check stopped on an error inside the Hub. The Hub log names it.',
    });
    expect(failureText(plain)).not.toContain('hunter2');
    expect(failureOf('a string')).toEqual(plain);
    expect(failureOf(null)).toEqual(plain);
  });

  it("keeps a provider failure's closed kind and never its text", () => {
    const f = failureOf(
      new WalletProviderError({
        kind: 'rate_limited',
        provider: 'fintava',
        operation: 'listTransactions',
        messages: ['Account 0123456789 is throttled'],
      }),
    );
    expect(f).toEqual({
      code: 'provider_rate_limited',
      sentence:
        'The wallet provider failed while the check was reading from it.',
    });
    expect(failureText(f)).toBe(
      'provider_rate_limited: The wallet provider failed while the check was reading from it.',
    );
  });

  it('is read back from the row only when it is one of ours', () => {
    const ours = failureOf(new Error('x'));
    expect(storedFailure(failureText(ours))).toEqual(ours);
    expect(storedFailure(failureText(RUN_DIED))).toEqual(RUN_DIED);
    expect(storedFailure(null)).toEqual(RUN_DIED);
    expect(storedFailure('Error: planted failure 0123456789')).toEqual(
      RUN_DIED,
    );
    expect(storedFailure('internal_error: has an @ in it')).toEqual(RUN_DIED);
  });
});

describe("the email's facts", () => {
  const base = failureReport(
    'fintava',
    '2026-10-12',
    new Date('2026-10-12T01:30:00Z'),
    new Date('2026-10-12T02:10:00Z'),
  );

  it('carry counts, references and kobo, and no more than the mail holds', () => {
    const report: MoneyCheckReport = {
      ...base,
      verdict: 'differences',
      wallets: { total: 9, checked: 8, notChecked: { unreadable: 1 } },
      mismatches: Array.from({ length: REPORT_MAIL }, (_, i) =>
        finding({ ref: `m${i}`, amountKobo: '1500', otherKobo: '1000' }),
      ),
      look: [
        finding({
          severity: 'look',
          ref: 'l1',
          check: 'payments',
          kind: 'payment_in_review',
        }),
      ],
      omitted: { mismatches: 5, look: 0 },
    };
    const mail = mailOf(report, {
      mismatchCount: REPORT_MAIL + 5,
      lookCount: 1,
    });
    expect(mail.items).toHaveLength(REPORT_MAIL);
    expect(mail.itemsOmitted).toBe(REPORT_MAIL + 5 + 1 - REPORT_MAIL);
    expect(mail.walletsChecked).toBe(8);
    expect(mail.walletsTotal).toBe(9);
    expect(mail.verdict).toBe('differences');
    expect(Object.keys(mail.items[0]).sort()).toEqual(
      [
        'amountKobo',
        'check',
        'detail',
        'kind',
        'otherKobo',
        'ref',
        'severity',
      ].sort(),
    );
    expect(mail.checks).toHaveLength(CHECK_IDS.length);
  });

  it('holds no em-dash, name, phone number or account number', () => {
    const text = JSON.stringify(
      mailOf(
        { ...base, mismatches: [finding()], look: [] },
        { mismatchCount: 1, lookCount: 0 },
      ),
    );
    expect(text).not.toContain(String.fromCharCode(0x2014));
    expect(text).not.toMatch(/\+234|\b0[789]\d{9}\b|\b\d{10}\b/);
  });
});

describe('the mailer', () => {
  const config = (values: Record<string, string>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  const mail = mailOf(
    failureReport(
      'fintava',
      '2026-10-12',
      new Date('2026-10-12T01:30:00Z'),
      new Date('2026-10-12T02:10:00Z'),
    ),
    { mismatchCount: 0, lookCount: 0 },
  );

  it('says what WAWU ID would not take in words with no body text in them', async () => {
    const real = global.fetch;
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('{"message":"Secret detail 0123456789"}', { status: 400 }),
      ) as never;
    try {
      const err = await new MoneyCheckMailer(
        config({ WAWU_ID_INTERNAL_SERVICE_KEY: 'k' }),
      )
        .send('owner', mail)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MoneyCheckMailRefused);
      expect((err as Error).message).toBe(
        'WAWU ID refused the money check report (HTTP 400).',
      );
    } finally {
      global.fetch = real;
    }
  });

  it('does not take a 200 that says nothing was sent', async () => {
    const real = global.fetch;
    try {
      for (const answer of [
        { data: { emailed: false } },
        { data: { sent: false } },
      ]) {
        global.fetch = jest
          .fn()
          .mockResolvedValue(new Response(JSON.stringify(answer))) as never;
        await expect(
          new MoneyCheckMailer(
            config({ WAWU_ID_INTERNAL_SERVICE_KEY: 'k' }),
          ).send('owner', mail),
        ).rejects.toBeInstanceOf(MoneyCheckMailRefused);
      }
      for (const answer of [
        { data: { emailed: true } },
        { data: { sent: true } },
        {},
      ]) {
        global.fetch = jest
          .fn()
          .mockResolvedValue(new Response(JSON.stringify(answer))) as never;
        await expect(
          new MoneyCheckMailer(
            config({ WAWU_ID_INTERNAL_SERVICE_KEY: 'k' }),
          ).send('owner', mail),
        ).resolves.toBeUndefined();
      }
    } finally {
      global.fetch = real;
    }
  });

  it('will not send in production without WAWU IDs service key', async () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        new MoneyCheckMailer(config({})).send('owner', mail),
      ).rejects.toThrow('WAWU_ID_INTERNAL_SERVICE_KEY');
    } finally {
      if (was === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = was;
    }
  });
});

describe('what is sent to WAWU ID is what it takes', () => {
  it('cuts a sentence to letters, digits, spaces and plain punctuation', () => {
    expect(
      plainSentence(
        `The provider ${String.fromCharCode(0x2014)} said "no" to \u20A650 at ada@example.test (see https://x.test/a).`,
        400,
      ),
    ).toBe(
      'The provider said "no" to 50 at ada example.test (see https: x.test a).',
    );
    expect(plainSentence('   ', 400)).toBe('No details.');
    expect(plainSentence('a'.repeat(500), 400)).toHaveLength(400);
  });

  it('gives a reference the length of a phone number a word in front of it', () => {
    expect(plainRef('4a9c7f0e-23d1-4b8e-9d52-1f6a5c0e7b11')).toBe(
      '4a9c7f0e-23d1-4b8e-9d52-1f6a5c0e7b11',
    );
    expect(plainRef('wawu-account')).toBe('wawu-account');
    expect(plainRef('08031234567')).toBe('ref-08031234567');
    expect(plainRef('0123456789')).toBe('ref-0123456789');
    expect(plainRef('2348031234567')).toBe('ref-2348031234567');
    expect(plainRef('0803-123-4567')).toBe('ref-0803-123-4567');
    // A provider's long session id is a reference a person can look up.
    expect(plainRef('110022113344556677889900112233')).toBe(
      '110022113344556677889900112233',
    );
    expect(plainRef('a b/c@d')).toBe('a_b_c_d');
    expect(plainRef('-x')).toBe('r-x');
    expect(plainRef('x'.repeat(200))).toHaveLength(80);
  });

  it('is applied to every sentence and reference the mail carries', () => {
    const base = failureReport(
      'fintava',
      '2026-10-12',
      new Date('2026-10-12T01:30:00Z'),
      new Date('2026-10-12T02:10:00Z'),
    );
    const report: MoneyCheckReport = {
      ...base,
      verdict: 'differences',
      checks: base.checks.map((c, i) =>
        i === 0 ? { ...c, note: 'Not checked \u20A6 here.' } : c,
      ),
      mismatches: [
        {
          check: 'movements',
          severity: 'mismatch',
          kind: 'provider_only',
          ref: '08031234567',
          detail: `One ${String.fromCharCode(0x2014)} two`,
        },
      ],
    };
    const mail = mailOf(report, { mismatchCount: 1, lookCount: 0 });
    expect(mail.items[0].ref).toBe('ref-08031234567');
    expect(mail.items[0].detail).toBe('One two');
    expect(mail.checks[0].note).toBe('Not checked here.');
    // The stored report keeps what the check wrote.
    expect(report.mismatches[0].ref).toBe('08031234567');
  });
});
