import { inflateSync } from 'node:zlib';
import type { TransactionView } from '../../money-view.type';
import {
  newReceiptCode,
  normalReceiptCode,
  RECEIPT_CODE_ALPHABET,
  RECEIPT_CODE_LENGTH,
  receiptLink,
} from '../receipt-code';
import { verifyBase } from '../receipt-config';
import {
  headlineOf,
  maskedName,
  naira,
  partiesOf,
  publicReceipt,
  receiptDate,
  receiptDocument,
  receiptLines,
} from '../receipt-document';
import {
  A4,
  IMAGE_SCALE,
  RECEIPT_WIDTH,
  receiptPdf,
  receiptPng,
} from '../receipt-render';
import type { ReceiptView } from '../receipt-view.type';

/** Receipts (WALLET-18) without a server: the code, the words, the drawing. */

function tx(over: Partial<TransactionView> = {}): TransactionView {
  return {
    id: '7d3f2c1e-0000-4000-8000-000000000001',
    direction: 'in',
    category: 'earning',
    status: 'completed',
    amountKobo: 200000,
    fee: { providerFeeKobo: 0, wawuFeeKobo: 0, totalFeeKobo: 0 },
    totalKobo: 200000,
    description: 'Tip · How I light a night shoot',
    counterparty: {
      kind: 'wawu_user',
      name: 'Amaka Nwosu',
      avatarUrl: null,
      wawuUserId: 'u-amaka',
      bankName: null,
      accountNumberLast4: null,
    },
    link: { kind: 'tip', targetId: 'c1', title: 'How I light a night shoot' },
    note: 'thanks for the video',
    reference: 'WAW-T1P9-7ZQA',
    transferId: null,
    paymentId: null,
    group: null,
    createdAt: '2026-09-26T09:24:00.000Z',
    ...over,
  };
}

const own = { accountNumber: '8123456789', accountName: 'Lennox Emmanuel' };

function view(t: TransactionView, url: string | null = null): ReceiptView {
  const parties = partiesOf(t, own);
  return {
    code: 'T1P97ZQAK3MP',
    link: receiptLink('T1P97ZQAK3MP'),
    url,
    transaction: t,
    typeLabel: 'Tip',
    headline: headlineOf(t),
    ...parties,
    bankName: 'Loma Bank',
    licenceLine: null,
    lines: receiptLines(t, parties, 'Loma Bank'),
    issuedAt: '2026-09-26T09:30:00.000Z',
  };
}

describe('receipt codes', () => {
  it('are 12 characters of Crockford base 32, and 20,000 in a row never repeat or follow on', () => {
    const seen = new Set<string>();
    let previous = '';
    for (let i = 0; i < 20_000; i += 1) {
      const c = newReceiptCode();
      expect(c).toMatch(
        new RegExp(`^[${RECEIPT_CODE_ALPHABET}]{${RECEIPT_CODE_LENGTH}}$`),
      );
      expect(c).not.toBe(previous);
      seen.add(c);
      previous = c;
    }
    expect(seen.size).toBe(20_000);
  });

  it('use every character about equally in every place (random, not counted)', () => {
    const counts = Array.from(
      { length: RECEIPT_CODE_LENGTH },
      () => new Map<string, number>(),
    );
    const n = 32_000;
    for (let i = 0; i < n; i += 1) {
      [...newReceiptCode()].forEach((ch, at) =>
        counts[at].set(ch, (counts[at].get(ch) ?? 0) + 1),
      );
    }
    for (const place of counts) {
      expect(place.size).toBe(32);
      for (const k of place.values()) {
        expect(k).toBeGreaterThan(700);
        expect(k).toBeLessThan(1300);
      }
    }
  });

  it('read as typed: any case, spaces and hyphens, O as 0, I and L as 1; anything else is no code', () => {
    expect(normalReceiptCode('t1p9-7zqa-k3mp')).toBe('T1P97ZQAK3MP');
    expect(normalReceiptCode(' T1P9 7ZQA K3MP ')).toBe('T1P97ZQAK3MP');
    expect(normalReceiptCode('TOPI7ZQAK3ML')).toBe('T0P17ZQAK3M1');
    expect(normalReceiptCode('T1P9')).toBeNull();
    expect(normalReceiptCode('T1P97ZQAK3MPX')).toBeNull();
    expect(normalReceiptCode('T1P97ZQAK3MU')).toBeNull();
    expect(normalReceiptCode("'; DROP TABLE x;--")).toBeNull();
    expect(normalReceiptCode('A'.repeat(5000))).toBeNull();
    expect(receiptLink('T1P97ZQAK3MP')).toBe('wawu/r/T1P97ZQAK3MP');
  });
});

describe('receipt words', () => {
  it('writes naira from kobo, with no float on the way', () => {
    expect(naira(200000)).toBe('₦2,000.00');
    expect(naira(2506500)).toBe('₦25,065.00');
    expect(naira(5)).toBe('₦0.05');
    expect(naira(123456789012)).toBe('₦1,234,567,890.12');
    expect(() => naira(1.5)).toThrow();
  });

  it('dates in Lagos time, as W41 prints them', () => {
    expect(receiptDate('2026-09-26T09:24:00.000Z')).toBe('26 Sep 2026, 10:24');
    expect(receiptDate('2026-12-31T23:30:00.000Z')).toBe('1 Jan 2027, 00:30');
  });

  it("money in: the tip as W41 draws it, the owner's own account in full", () => {
    const v = view(tx());
    expect(v.headline).toBe('Tip from Amaka Nwosu');
    expect(v.lines).toEqual([
      { label: 'Type', value: 'Tip' },
      { label: 'From', value: 'Amaka Nwosu' },
      { label: 'To', value: 'Lennox Emmanuel · 812 345 6789' },
      { label: 'Bank', value: 'Loma Bank' },
      { label: 'Reference', value: 'WAW-T1P9-7ZQA' },
    ]);
    const doc = receiptDocument(v);
    expect(doc.amountText).toBe('+₦2,000.00');
    expect(doc.statusText).toBe('Completed');
    expect(doc.footer).toBe('Check it at wawu/r/T1P97ZQAK3MP');
  });

  it("money out to a bank: what it cost (R-10), and the other side's account only by its last 4", () => {
    const t = tx({
      direction: 'out',
      category: 'transfer',
      amountKobo: 2500000,
      fee: { providerFeeKobo: 4000, wawuFeeKobo: 2500, totalFeeKobo: 6500 },
      totalKobo: 2506500,
      description: 'Transfer · GTBank',
      counterparty: {
        kind: 'bank_account',
        name: 'Chidinma Okoro',
        avatarUrl: null,
        wawuUserId: null,
        bankName: 'GTBank',
        accountNumberLast4: '6789',
      },
      link: null,
    });
    const v = view(t);
    expect(v.headline).toBe('Transfer to Chidinma Okoro');
    expect(v.lines).toEqual([
      { label: 'Type', value: 'Transfer' },
      { label: 'From', value: 'Lennox Emmanuel · 812 345 6789' },
      { label: 'To', value: 'Chidinma Okoro · GTBank •••• 6789' },
      { label: 'Bank', value: 'Loma Bank' },
      { label: 'Amount', value: '₦25,000.00' },
      { label: "Fintava's charge", value: '₦40.00' },
      { label: "WAWU's fee", value: '₦25.00' },
      { label: 'Total paid', value: '₦25,065.00' },
      { label: 'Reference', value: 'WAW-T1P9-7ZQA' },
    ]);
    expect(receiptDocument(v).amountText).toBe('₦25,000.00');
  });

  it('the public receipt masks both sides and keeps nothing else: no full account, handle, note or what was bought', () => {
    const p = publicReceipt(
      tx({
        counterparty: {
          kind: 'bank_account',
          name: 'Chidinma Adaeze Okoro',
          avatarUrl: null,
          wawuUserId: null,
          bankName: 'GTBank',
          accountNumberLast4: '4321',
        },
      }),
      own,
      'Loma Bank',
      null,
      'wawu/r/T1P97ZQAK3MP',
    );
    expect(p.from).toEqual({
      name: 'Chidinma A. O.',
      account: 'GTBank •••• 4321',
    });
    expect(p.to).toEqual({ name: 'Lennox E.', account: 'Loma Bank •••• 6789' });
    const text = JSON.stringify(p);
    for (const secret of [
      '8123456789',
      '812 345',
      'Emmanuel',
      'night shoot',
      'thanks',
      'Adaeze',
    ])
      expect(text).not.toContain(secret);
  });

  it('masks names: initials after the first name, never a handle, a company keeps its name, long numbers keep 4 digits', () => {
    expect(maskedName('Amaka Nwosu', 'wawu_user')).toBe('Amaka N.');
    expect(maskedName('@amaka', 'wawu_user')).toBe('Someone on Who Made This');
    expect(maskedName('Someone on Who Made This', 'wawu_user')).toBe(
      'Someone on Who Made This',
    );
    expect(maskedName('Ikeja Electric', 'biller')).toBe('Ikeja Electric');
    expect(maskedName('MTN 08031234412', 'biller')).toBe('MTN •••• 4412');
    expect(maskedName('Ada', 'owner')).toBe('Ada');
    expect(maskedName('  ', 'owner')).toBe('Someone on Who Made This');
  });
});

describe('receipt drawing', () => {
  const doc = receiptDocument(
    view(tx(), 'https://hub.example.test/api/hub/r/T1P97ZQAK3MP'),
  );

  it("the image is a PNG, 3 pixels a point, the receipt's width", () => {
    const png = receiptPng(doc);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(RECEIPT_WIDTH * IMAGE_SCALE);
    expect(png.readUInt32BE(20)).toBeGreaterThan(900);
  });

  it('the PDF is one A4 page, every object where the cross-reference table says, and a link only with an address', () => {
    for (const d of [doc, { ...doc, url: null }]) {
      const pdf = receiptPdf(d, new Date('2026-09-26T09:30:00.000Z'));
      const latin = pdf.toString('latin1');
      expect(latin.startsWith('%PDF-1.4\n')).toBe(true);
      expect(latin.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(latin).toContain(
        `/MediaBox [0 0 ${A4.width.toFixed(2)} ${A4.height.toFixed(2)}]`,
      );
      expect(latin.match(/\/Type \/Page /g)).toHaveLength(1);
      const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(latin)![1]);
      expect(latin.slice(startxref, startxref + 4)).toBe('xref');
      const table = latin.slice(startxref).split('\n');
      const count = Number(table[1].split(' ')[1]);
      for (let i = 1; i < count; i += 1) {
        const at = Number(table[2 + i].slice(0, 10));
        expect(latin.slice(at, at + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
      }
      // The picture inflates to width x height x 3 bytes.
      const m =
        /\/Width (\d+) \/Height (\d+) .*?\/Length (\d+) >>\nstream\n/s.exec(
          latin,
        )!;
      const start = m.index + m[0].length;
      const raw = inflateSync(pdf.subarray(start, start + Number(m[3])));
      expect(raw.length).toBe(Number(m[1]) * Number(m[2]) * 3);
      if (d.url)
        expect(latin).toContain(
          '/URI (https://hub.example.test/api/hub/r/T1P97ZQAK3MP)',
        );
      else expect(latin).not.toContain('/Annots');
    }
  });
});

describe('RECEIPT_VERIFY_BASE_URL', () => {
  it('is optional, loses a trailing slash, and must be https in production', () => {
    expect(verifyBase(undefined, true)).toBeNull();
    expect(verifyBase('  ', true)).toBeNull();
    expect(verifyBase('https://hub.example.test/api/hub/r/', true)).toBe(
      'https://hub.example.test/api/hub/r',
    );
    expect(verifyBase('http://127.0.0.1:4971/api/hub/r', false)).toBe(
      'http://127.0.0.1:4971/api/hub/r',
    );
    expect(() => verifyBase('http://hub.example.test/r', true)).toThrow();
    expect(() => verifyBase('not a url', false)).toThrow();
    expect(() => verifyBase('https://x.test/r?a=1', false)).toThrow();
  });
});
