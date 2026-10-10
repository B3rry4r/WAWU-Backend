import type { WaitlistRegistration } from '../../../generated/prisma/client';
import {
  waitlistHeaderLine,
  waitlistLine,
  WAITLIST_EXPORT_COLUMNS,
} from '../waitlist-export';

/**
 * The team's CSV (JOIN-01, JOIN-03): the header and every row line up. Each
 * row is read back BY HEADER with a real CSV reader (quotes, commas and line
 * breaks inside a cell included), so a cell written under the wrong heading,
 * or a row with one cell too many or too few, fails here whatever order the
 * columns are in (JOIN-03 round 2, N4).
 */

/** RFC 4180: cells split on commas, a quoted cell may hold commas, quotes and line breaks. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const registration = (
  over: Partial<WaitlistRegistration>,
): WaitlistRegistration => ({
  id: 'r1',
  offerId: 'event-oct-2026',
  fullName: 'Ada Obi',
  phone: '+2348031234567',
  email: 'ada@example.test',
  state: 'Lagos',
  makes: 'Beads, bags',
  consentAt: new Date('2026-10-01T10:00:00.000Z'),
  reference: 'wawu-join-5f6c15e4aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  accessCode: '5F6C15E4',
  status: 'paid',
  amountKobo: 200000,
  currency: 'NGN',
  flutterwaveTxId: 'tx-100',
  paidKobo: 200000,
  paidAt: new Date('2026-10-02T11:30:00.000Z'),
  claimedByWawuId: null,
  claimedAt: null,
  claimResult: null,
  createdAt: new Date('2026-10-01T10:05:00.000Z'),
  updatedAt: new Date('2026-10-02T11:30:00.000Z'),
  ...over,
});

/** The whole record of one registration, read back from the file by header. */
function recordOf(r: WaitlistRegistration): Record<string, string> {
  const [header, ...rows] = readCsv(
    `${waitlistHeaderLine()}${waitlistLine(r)}`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveLength(header.length);
  return Object.fromEntries(header.map((h, i) => [h, rows[0][i]]));
}

describe('the waitlist CSV reads back by header (round 2, N4)', () => {
  it('has one cell under every heading, none missing and none extra, for every kind of row', () => {
    const kinds = [
      registration({}),
      registration({
        status: 'pending',
        paidKobo: null,
        paidAt: null,
        flutterwaveTxId: null,
        state: null,
        makes: null,
      }),
      registration({ status: 'failed' }),
      registration({
        claimedByWawuId: 'u-1',
        claimedAt: new Date('2026-10-17T09:30:00.000Z'),
      }),
      registration({
        fullName: 'Quote "Q", Comma\nNewline',
        makes: '=SUM(1,1)',
      }),
    ];
    const headers = readCsv(waitlistHeaderLine())[0];
    expect(headers).toEqual([...WAITLIST_EXPORT_COLUMNS]);
    for (const r of kinds) {
      const [row] = readCsv(waitlistLine(r));
      expect(row).toHaveLength(headers.length);
    }
  });

  it('puts each value under its own heading: a paid, claimed registration', () => {
    expect(
      recordOf(
        registration({
          claimedByWawuId: 'u-1',
          claimedAt: new Date('2026-10-17T09:30:00.000Z'),
        }),
      ),
    ).toEqual({
      'Registered at': '2026-10-01T10:05:00.000Z',
      Offer: 'event-oct-2026',
      Status: 'paid',
      'Full name': 'Ada Obi',
      // A leading + is a formula character to a spreadsheet, so the cell is written with a quote in front.
      Phone: "'+2348031234567",
      Email: 'ada@example.test',
      State: 'Lagos',
      'What they make': 'Beads, bags',
      'Fee (₦)': '2000.00',
      'Paid (₦)': '2000.00',
      'Refund due (₦)': '',
      'Paid at': '2026-10-02T11:30:00.000Z',
      'Access code': '5F6C 15E4',
      Reference: 'wawu-join-5f6c15e4aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'Transaction id': 'tx-100',
      Claimed: 'yes',
      'Claimed at': '2026-10-17T09:30:00.000Z',
    });
  });

  it('puts a refund under Refund due and not under Paid, a pending row under neither, an unclaimed row under Claimed: no', () => {
    expect(recordOf(registration({ status: 'failed' }))).toMatchObject({
      Status: 'failed',
      'Paid (₦)': '',
      'Refund due (₦)': '2000.00',
      Claimed: 'no',
      'Claimed at': '',
    });
    expect(
      recordOf(
        registration({
          status: 'pending',
          paidKobo: null,
          paidAt: null,
          flutterwaveTxId: null,
        }),
      ),
    ).toMatchObject({
      Status: 'pending',
      'Fee (₦)': '2000.00',
      'Paid (₦)': '',
      'Refund due (₦)': '',
      'Paid at': '',
      'Transaction id': '',
    });
  });

  it('keeps a cell with a comma, a quote or a line break in its own column, and neutralises a formula', () => {
    const record = recordOf(
      registration({
        fullName: 'Quote "Q", Comma\nNewline',
        makes: '=SUM(1,1)',
        state: '@x',
      }),
    );
    expect(record['Full name']).toBe('Quote "Q", Comma\nNewline');
    expect(record['What they make']).toBe("'=SUM(1,1)");
    expect(record.State).toBe("'@x");
    expect(record.Email).toBe('ada@example.test');
    expect(record['Access code']).toBe('5F6C 15E4');
  });
});
