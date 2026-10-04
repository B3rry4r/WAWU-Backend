import { BadRequestException } from '@nestjs/common';
import {
  calendarDay,
  CSV_EOL,
  dayNumber,
  headerLine,
  lagosToday,
  movementLine,
  nairaText,
  STATEMENT_COLUMNS,
  textCell,
} from '../statement-csv';
import {
  checkedPeriod,
  counterpartyName,
  describeMovement,
  STATEMENT_FUTURE_MESSAGE,
  STATEMENT_MAX_DAYS,
  STATEMENT_NOT_A_DAY_MESSAGE,
  STATEMENT_ORDER_MESSAGE,
  STATEMENT_TOO_LONG_MESSAGE,
} from '../statement.service';

/** The units of a statement (task WALLET-27): the CSV, the calendar, the words. */

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).message;
  }
  throw new Error('expected a 400');
}

describe('statement CSV', () => {
  it('writes kobo as naira with two decimals, exactly, up to the largest safe integer', () => {
    expect(nairaText(0)).toBe('0.00');
    expect(nairaText(5)).toBe('0.05');
    expect(nairaText(100)).toBe('1.00');
    expect(nairaText(125_050)).toBe('1250.50');
    expect(nairaText(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(() => nairaText(-1)).toThrow(RangeError);
    expect(() => nairaText(1.5)).toThrow(RangeError);
  });

  it('quotes a cell with a comma, a quote or a line break, doubling its quotes', () => {
    expect(textCell('Okoro, Chidinma')).toBe('"Okoro, Chidinma"');
    expect(textCell('the "good" one')).toBe('"the ""good"" one"');
    expect(textCell('line one\nline two')).toBe('"line one\nline two"');
    expect(textCell('plain words')).toBe('plain words');
    expect(textCell(null)).toBe('');
    expect(textCell('')).toBe('');
  });

  it('never lets a spreadsheet run a cell: = + - @ tab and CR get a quote mark first', () => {
    expect(textCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(textCell('+2348000000000')).toBe("'+2348000000000");
    expect(textCell('-1')).toBe("'-1");
    expect(textCell('@handle')).toBe("'@handle");
    expect(textCell('\tx')).toBe("'\tx");
    expect(textCell('\rx')).toBe('"\'\rx"');
    expect(textCell('a=b')).toBe('a=b');
  });

  it('a header of nine named columns, naira only, CRLF', () => {
    expect(headerLine()).toBe(
      `Date,Time,Description,Counterparty,Reference,Note,Money in (₦),Money out (₦),Of which fees (₦)${CSV_EOL}`,
    );
    expect(STATEMENT_COLUMNS.join(' ')).not.toMatch(/\$|USD|dollar/i);
  });

  it('money in fills only Money in; money out fills Money out with fees included, and the fees beside it', () => {
    const base = {
      date: '2026-09-01',
      time: '00:00',
      description: 'Transfer',
      counterparty: 'Bayo',
      reference: 'R1',
      note: null,
    };
    expect(
      movementLine({ ...base, direction: 'in', totalKobo: 1000, feeKobo: 0 }),
    ).toBe(`2026-09-01,00:00,Transfer,Bayo,R1,,10.00,,${CSV_EOL}`);
    expect(
      movementLine({
        ...base,
        direction: 'out',
        totalKobo: 2_506_500,
        feeKobo: 6_500,
      }),
    ).toBe(`2026-09-01,00:00,Transfer,Bayo,R1,,,25065.00,65.00${CSV_EOL}`);
  });
});

describe('statement calendar', () => {
  it('reads real days only', () => {
    expect(calendarDay('1970-01-01')).toBe(0);
    expect(calendarDay('2026-09-01')).toBe(dayNumber(2026, 9, 1));
    expect(calendarDay('2028-02-29')).not.toBeNull();
    expect(calendarDay('2026-02-29')).toBeNull();
    expect(calendarDay('2026-02-30')).toBeNull();
    expect(calendarDay('2100-02-29')).toBeNull();
    expect(calendarDay('2000-02-29')).not.toBeNull();
    expect(calendarDay('2026-04-31')).toBeNull();
    expect(calendarDay('0000-01-01')).toBeNull();
    expect(calendarDay('0001-01-01')).not.toBeNull();
    expect(calendarDay('2026-13-01')).toBeNull();
    expect(calendarDay('2026-9-1')).toBeNull();
  });

  it('day numbers agree with the JavaScript calendar over 400 years', () => {
    for (
      let t = Date.UTC(1900, 0, 1);
      t < Date.UTC(2300, 0, 1);
      t += 86_400_000 * 13
    ) {
      const d = new Date(t);
      expect(
        dayNumber(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
      ).toBe(Math.round(t / 86_400_000));
    }
  });

  it('today in Lagos turns at 23:00 UTC', () => {
    expect(lagosToday(new Date('2026-09-30T22:59:59.999Z'))).toBe('2026-09-30');
    expect(lagosToday(new Date('2026-09-30T23:00:00.000Z'))).toBe('2026-10-01');
  });

  it('a period is two real days, in order, not after today in Lagos, at most 366 days', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    expect(checkedPeriod('2026-09-01', '2026-09-30', now)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(checkedPeriod('2026-10-03', '2026-10-03', now).to).toBe(
      '2026-10-03',
    );
    expect(refusal(() => checkedPeriod('2026-02-30', '2026-03-01', now))).toBe(
      STATEMENT_NOT_A_DAY_MESSAGE('from'),
    );
    expect(refusal(() => checkedPeriod('2026-02-01', '2026-02-29', now))).toBe(
      STATEMENT_NOT_A_DAY_MESSAGE('to'),
    );
    expect(refusal(() => checkedPeriod('2026-09-02', '2026-09-01', now))).toBe(
      STATEMENT_ORDER_MESSAGE,
    );
    expect(refusal(() => checkedPeriod('2026-10-01', '2026-10-04', now))).toBe(
      STATEMENT_FUTURE_MESSAGE,
    );
    // 23:30 UTC on 3 Oct is already 4 Oct in Lagos.
    expect(
      checkedPeriod(
        '2026-10-04',
        '2026-10-04',
        new Date('2026-10-03T23:30:00Z'),
      ).to,
    ).toBe('2026-10-04');
    expect(STATEMENT_MAX_DAYS).toBe(366);
    expect(checkedPeriod('2025-10-03', '2026-10-03', now).from).toBe(
      '2025-10-03',
    );
    expect(refusal(() => checkedPeriod('2025-10-02', '2026-10-03', now))).toBe(
      STATEMENT_TOO_LONG_MESSAGE,
    );
  });
});

describe('statement words (the history’s, history-labels.ts)', () => {
  it('describes a movement as the history does', () => {
    const none = {
      linkKind: null,
      linkTitle: null,
      cpKind: null,
      cpBankName: null,
    };
    expect(describeMovement({ ...none, category: 'transfer' })).toBe(
      'Transfer',
    );
    expect(
      describeMovement({
        ...none,
        category: 'transfer',
        cpKind: 'bank_account',
        cpBankName: 'GTBank',
      }),
    ).toBe('Transfer · GTBank');
    expect(
      describeMovement({
        ...none,
        category: 'earning',
        linkKind: 'content_unlock',
        linkTitle: 'Lighting night shoots',
      }),
    ).toBe('Unlock · Lighting night shoots');
    // A link label only for an earning or a purchase.
    expect(
      describeMovement({ ...none, category: 'refund', linkKind: 'tip' }),
    ).toBe('Refund');
    expect(
      describeMovement({ ...none, category: 'bill', cpKind: 'biller' }),
    ).toBe('Bill');
  });

  it('names the other side: recorded, else their wallet name, else @handle, else a plain word', () => {
    const r = {
      cpKind: 'wawu_user' as const,
      cpRecordedName: null,
      cpWalletName: null,
      cpHandle: null,
    };
    expect(counterpartyName({ ...r, cpKind: null })).toBeNull();
    expect(counterpartyName(r)).toBe('Someone on Who Made This');
    expect(counterpartyName({ ...r, cpHandle: 'ada' })).toBe('@ada');
    expect(
      counterpartyName({ ...r, cpHandle: 'ada', cpWalletName: 'Ada Obi' }),
    ).toBe('Ada Obi');
    expect(
      counterpartyName({
        ...r,
        cpHandle: 'ada',
        cpWalletName: 'Ada Obi',
        cpRecordedName: 'Ada',
      }),
    ).toBe('Ada');
    expect(counterpartyName({ ...r, cpKind: 'bank_account' })).toBe(
      'Bank account',
    );
  });
});
