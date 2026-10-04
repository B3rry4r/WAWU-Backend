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
import { ReceiptSettings } from '../receipt-config';
import { DrawLimiter, ReceiptBusyError } from '../receipt-draw-limiter';
import {
  digitMasking,
  foldDigits,
  headlineOf,
  maskDigits,
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
  clip,
  escapeXml,
  fit,
  IMAGE_SCALE,
  MAX_PRINTED,
  printable,
  pdfPlacement,
  receiptCard,
  RECEIPT_WIDTH,
  receiptPdf,
  receiptPng,
  textWidth,
  wrap,
} from '../receipt-render';
import type { DigitTable, ReceiptDocument } from '../receipt-document';
import type { ReceiptView } from '../receipt-view.type';
import { drawnWidth } from './drawn-width';
import { D3_FORMS, visibleDigits } from './d3-forms';
import { PNG } from './png-rows';
import {
  OTHER_DIGITS,
  OTHER_NUMBERS,
  UNICODE_DIGIT_VERSION,
} from '../unicode-digits.generated';

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

describe('numbers in names (round 2)', () => {
  it('a phone, meter or account number keeps only its last 4 digits however it is written', () => {
    for (const [given, shown] of [
      ['MTN Airtime 08031234567', 'MTN Airtime •••• 4567'],
      ['MTN Airtime 0803 123 4567', 'MTN Airtime •••• 4567'],
      ['MTN Airtime 0803-123-4567', 'MTN Airtime •••• 4567'],
      ['MTN Airtime 0803.123.4567', 'MTN Airtime •••• 4567'],
      ['MTN Airtime +234 803 123 4567', 'MTN Airtime •••• 4567'],
      ['MTN Airtime +2348031234567', 'MTN Airtime •••• 4567'],
      ['MTN Airtime (0803) 123 4567', 'MTN Airtime •••• 4567'],
      ['Meter 4501-2345-678/9', 'Meter •••• 6789'],
      ['IKEDC 12345', 'IKEDC •••• 2345'],
      ['Shop 1234', 'Shop 1234'],
      ['Ikeja Electric', 'Ikeja Electric'],
    ])
      expect(maskDigits(given)).toBe(shown);
  });

  it('the public receipt never shows more than 4 digits of a number in any name or bank name', () => {
    const p = publicReceipt(
      tx({
        counterparty: {
          kind: 'biller',
          name: 'MTN Airtime +234 803-123-4567',
          avatarUrl: null,
          wawuUserId: null,
          bankName: 'Bank 0123 456 789',
          accountNumberLast4: '6789',
        },
      }),
      { accountNumber: '8123456789', accountName: 'Ada 0803 123 4567 Obi' },
      'Loma 12345 Bank',
      null,
      'wawu/r/T1P97ZQAK3MP',
    );
    expect(p.from!.name).toBe('MTN Airtime •••• 4567');
    expect(p.to!.name).toBe('Ada O.');
    const shown = [p.from, p.to, p.bankName]
      .map((x) => JSON.stringify(x))
      .join(' ');
    for (const run of shown.match(/\d(?:[\s.-]*\d)*/g) ?? [])
      expect({ run, digits: run.replace(/\D/g, '').length <= 4 }).toEqual({
        run,
        digits: true,
      });
  });
});

describe('text for the drawing (round 2)', () => {
  it('escapes &, <, >, and both quotes, & first', () => {
    expect(escapeXml(`A & B <c> "d" 'e' &amp;`)).toBe(
      'A &#38; B &#60;c&#62; &#34;d&#34; &#39;e&#39; &#38;amp;',
    );
  });

  it('drops what XML 1.0 forbids, and turns tabs and line breaks into spaces', () => {
    expect(printable('Bad\u0001Name\u0008X \uFFFE\uFFFF\uD800')).toBe(
      'BadNameX ',
    );
    expect(printable('a\tb\nc\rd')).toBe('a b c d');
    expect(printable('\u007fx\u0085y')).toBe('xy');
    expect(printable('emoji 😀 stays')).toBe('emoji 😀 stays');
  });
});

describe('receipt drawing', () => {
  const doc = receiptDocument(
    view(tx(), 'https://hub.example.test/api/hub/r/T1P97ZQAK3MP'),
  );

  it("the image is a PNG, 3 pixels a point, the receipt's width", async () => {
    const png = await receiptPng(doc);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(RECEIPT_WIDTH * IMAGE_SCALE);
    expect(png.readUInt32BE(20)).toBeGreaterThan(900);
  });

  it('the PDF is one A4 page, every object where the cross-reference table says, and a link only with an address', async () => {
    for (const d of [doc, { ...doc, url: null }]) {
      const pdf = await receiptPdf(d, new Date('2026-09-26T09:30:00.000Z'));
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

  /** The longest the ledger keeps (ledger.service.ts `clean`): names 500, references 200. */
  const longest = (): ReceiptDocument => {
    const word = (n: number, seed: number) =>
      Array.from({ length: n }, (_, i) =>
        String.fromCharCode(97 + ((i * 11 + seed) % 26)),
      ).join('');
    return {
      ...doc,
      headline: `Transfer from ${word(500, 1)}`,
      lines: [
        { label: 'Type', value: 'Transfer' },
        { label: 'From', value: `${word(500, 2)} · ${word(500, 3)} •••• 6789` },
        { label: 'To', value: 'Lennox Emmanuel · 812 345 6789' },
        { label: 'Bank', value: word(500, 4) },
        { label: 'Reference', value: `R${'7'.repeat(199)}` },
      ],
      footer: `Check it at wawu/r/T1P97ZQAK3MP · ${word(500, 5)}`,
    };
  };

  const median = (xs: number[]) =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  it("drawing is bounded: at the ledger's longest name and reference, each of the image and the PDF takes under 300 ms", async () => {
    const big = longest();
    await receiptPng(big); // the fonts' first load
    await receiptPdf(big, new Date());
    for (const draw of [
      () => receiptPng(big),
      () => receiptPdf(big, new Date()),
    ]) {
      const times: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const t0 = performance.now();
        await draw();
        times.push(performance.now() - t0);
      }
      expect(median(times)).toBeLessThan(300);
    }
  });

  it('while a long receipt is drawn the server keeps answering: the event loop never stalls 100 ms', async () => {
    const big = longest();
    // The longest gap between 5 ms ticks while three receipts draw. Best of
    // 3 tries, so a busy machine pausing this process does not count; a
    // draw on the event loop (150 ms and more) fails every try.
    const attempt = async () => {
      let worst = 0;
      let last = performance.now();
      const tick = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
      }, 5);
      try {
        await Promise.all([
          receiptPdf(big, new Date()),
          receiptPng(big),
          receiptPdf(big, new Date()),
        ]);
      } finally {
        clearInterval(tick);
      }
      return worst;
    };
    const tries: number[] = [];
    for (let i = 0; i < 3; i += 1) tries.push(await attempt());
    expect(Math.min(...tries)).toBeLessThan(100);
  });

  it('measuring is linear: wrapping 500 characters takes under 20 ms, and every line fits', () => {
    const t0 = performance.now();
    const lines = wrap('x'.repeat(500), 13, 200, 600, 1000);
    expect(performance.now() - t0).toBeLessThan(20);
    expect(lines.join('')).toBe('x'.repeat(500));
    for (const l of lines)
      expect(textWidth(l, 13, 600)).toBeLessThanOrEqual(200);
    expect(fit('y'.repeat(500), 13, 100)).toMatch(/^y+…$/);
    expect(textWidth(fit('y'.repeat(500), 13, 100), 13)).toBeLessThanOrEqual(
      100,
    );
  });

  it('every printed string is cut to 160 characters before it is drawn', () => {
    expect(MAX_PRINTED).toBe(160);
    expect([...clip('z'.repeat(5000))]).toHaveLength(160);
    expect(clip('z'.repeat(5000)).endsWith('…')).toBe(true);
    expect(clip('Loma Bank')).toBe('Loma Bank');
  });

  it('a name with characters XML forbids, and with &, <, >, quotes, still draws as an image and a PDF', async () => {
    const odd: ReceiptDocument = {
      ...doc,
      headline: 'Transfer from Bad\u0001Name\u0008X \uFFFE',
      lines: [
        {
          label: 'From',
          value: 'Bad\u0001Name\u0008X \uFFFE\uD800 & Sons <Ltd> "A" \'B\'',
        },
        { label: 'To', value: 'Tab\there\nnewline\u007f\u0085' },
      ],
    };
    const png = await receiptPng(odd);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const pdf = await receiptPdf(odd, new Date());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('numbers in names, at the root (round 3)', () => {
  it('folds every decimal digit to 0 to 9 (full-width, Arabic-Indic, Persian, Devanagari, superscript, circled, mathematical)', () => {
    expect(foldDigits('０٨۰३⁴⑤𝟔')).toBe('0803456');
  });

  it('every listed form keeps at most its last 4 digits', () => {
    for (const [given, shown] of D3_FORMS) {
      expect({ given, out: maskDigits(given) }).toEqual({ given, out: shown });
      expect({ given, visible: visibleDigits(maskDigits(given)) <= 4 }).toEqual(
        { given, visible: true },
      );
    }
  });

  it('person names: a number first in the name never shows whole', () => {
    for (const name of [
      '０８０３１２３４５６７ John Doe',
      '0803-123-4567 John',
      '0803_123_4567 John',
    ]) {
      const shown = maskedName(name, 'bank_account');
      expect({ name, visible: visibleDigits(shown) <= 4 }).toEqual({
        name,
        visible: true,
      });
    }
    expect(maskedName('0803_123_4567 John', 'bank_account')).toBe('•••• J.');
  });

  it('a date or an amount written into a name is reshaped as a number (decision)', () => {
    expect(maskDigits('IKEDC token 2026-10-03 ₦5,000.00 Ref 12')).toBe(
      'IKEDC token •••• 0000 Ref 12',
    );
  });

  it("the other side's name and bank on the owner's image and PDF are masked the same way", () => {
    const t = tx({
      counterparty: {
        kind: 'bank_account',
        name: 'Ada 0803_123_4567',
        avatarUrl: null,
        wawuUserId: null,
        bankName: 'GTBank ０１２３４５６７８９',
        accountNumberLast4: '6789',
      },
    });
    const v = view(t);
    const text = JSON.stringify([v.headline, v.from, v.lines]);
    expect(text).not.toContain('0803');
    expect(text).not.toContain('０１２３');
    expect(v.from!.name).toBe('Ada •••• 4567');
  });
});

describe('marks and boxes (round 3, D4)', () => {
  const doc = receiptDocument(view(tx()));

  it('keeps at most 2 combining marks on a character, after NFC', () => {
    expect(printable('B' + '\u0335'.repeat(499))).toBe('B\u0335\u0335');
    expect(printable('A' + '\u0301\u0302\u0303\u0304\u0308'.repeat(99))).toBe(
      '\u00c1\u0302\u0303',
    );
    expect(printable('Chidinma Ọ̀kọ́rọ̀')).toBe('Chidinma Ọ̀kọ́rọ̀'.normalize('NFC'));
  });

  it('a stack of marks in a name never draws over the header: the top of the image is the same as without it', async () => {
    const plain = await receiptPng({
      ...doc,
      headline: 'Transfer from A',
      lines: [{ label: 'From', value: 'A' }],
    });
    const stacked = await receiptPng({
      ...doc,
      headline: 'Transfer from A' + '\u0301\u0302\u0303\u0304\u0308'.repeat(99),
      lines: [
        {
          label: 'From',
          value: 'A' + '\u0301\u0302\u0303\u0304\u0308'.repeat(99),
        },
      ],
    });
    const a = PNG(plain);
    const b = PNG(stacked);
    // The header band (the mark, TRANSACTION RECEIPT, the date): its first 60 points.
    const rows = 60 * IMAGE_SCALE;
    expect(b.rows(0, rows).equals(a.rows(0, rows))).toBe(true);
  });

  it('the 200-character reference is drawn whole, on as many lines as it takes', () => {
    const ref = `R${'7'.repeat(199)}`;
    const card = receiptCard({
      ...doc,
      lines: [{ label: 'Reference', value: ref }],
    });
    const drawn = [...card.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
      .map((m) => m[1])
      .filter((t) => /^[R7]+$/.test(t))
      .join('');
    expect(drawn).toBe(ref);
  });
});

describe('the width table against what resvg draws (round 3, N4)', () => {
  it('measures every sample at least as wide as resvg draws it, and Latin within 15% of it', () => {
    const samples: [string, 400 | 600 | 700][] = [
      ['Lennox Emmanuel Okafor', 600],
      ['WALLET18-SBX-20261003204540-1', 600],
      ['WWWWWWWWWWMMMMMMMMMM', 700],
      ['iiiiiiiiiilllllllll', 400],
      ['₦25,065.00', 700],
      ['Transfer to Chidinma Okoro', 400],
      ['ẸKỌ́ Ọ̀ṢỌ́ ỌMỌ', 600],
    ];
    for (const [sample, weight] of samples) {
      const drawn = drawnWidth(sample, 13, weight);
      const measured = textWidth(sample, 13, weight);
      expect({ sample, notNarrower: measured >= drawn }).toEqual({
        sample,
        notNarrower: true,
      });
      if (/^[\x20-\x7e]+$/.test(sample))
        expect({ sample, close: drawn / measured > 0.85 }).toEqual({
          sample,
          close: true,
        });
    }
  });
});

describe('drawing slots (round 3)', () => {
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('runs at most 2 at once and the rest in the order they came', async () => {
    const lim = new DrawLimiter(2, 5_000);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        lim.run(async () => {
          expect(lim.inFlight).toBeLessThanOrEqual(2);
          await later(20);
          order.push(i);
        }),
      ),
    );
    expect(lim.peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(lim.inFlight).toBe(0);
  });

  it('a request that finds no slot within the wait is refused as busy (503), and the slot is freed after a failure', async () => {
    const lim = new DrawLimiter(1, 50);
    const long = lim.run(() => later(200));
    const t0 = Date.now();
    await expect(lim.run(() => later(1))).rejects.toBeInstanceOf(
      ReceiptBusyError,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(new ReceiptBusyError().getStatus()).toBe(503);
    expect(lim.waiting).toBe(0);
    await long;
    await expect(
      lim.run(() => Promise.reject(new Error('draw failed'))),
    ).rejects.toThrow('draw failed');
    expect(lim.inFlight).toBe(0);
    await expect(lim.run(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('the cap is a setting: 2 by default, 1 to 8, anything else stops the app', () => {
    const settings = (v?: string) =>
      new ReceiptSettings({
        get: (k: string) =>
          k === 'RECEIPT_RENDER_CONCURRENCY' ? v : undefined,
      } as never);
    expect(settings().renderConcurrency).toBe(2);
    expect(settings('4').renderConcurrency).toBe(4);
    expect(() => settings('0')).toThrow();
    expect(() => settings('9')).toThrow();
  });
});

describe('every Unicode digit (round 4, lead ruling)', () => {
  it('every character with a single-digit numeric value folds to that digit, and five of them are masked as a number', () => {
    // The decimal digits (\p{Nd}) of the runtime's Unicode, by value...
    let decimals = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (!/\p{Nd}/u.test(ch)) continue;
      decimals += 1;
      let start = cp;
      while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
      const v = String((cp - start) % 10);
      expect({ cp, folded: foldDigits(ch) }).toEqual({ cp, folded: v });
      expect({ cp, masked: maskDigits(`MTN ${ch.repeat(6)}`) }).toEqual({
        cp,
        masked: `MTN •••• ${v.repeat(4)}`,
      });
    }
    expect(decimals).toBeGreaterThan(600);
    // ...and every other number character with such a value, from the UCD.
    expect(OTHER_DIGITS.length).toBeGreaterThan(450);
    for (const [cp, value] of OTHER_DIGITS) {
      const ch = String.fromCodePoint(cp);
      expect({ cp, number: /\p{N}/u.test(ch) }).toEqual({ cp, number: true });
      expect({ cp, folded: foldDigits(ch) }).toEqual({
        cp,
        folded: String(value),
      });
      expect({ cp, masked: maskDigits(`MTN ${ch.repeat(6)}`) }).toEqual({
        cp,
        masked: `MTN •••• ${String(value).repeat(4)}`,
      });
    }
  });

  it('a fraction or a number of 10 or more is not a digit', () => {
    expect(foldDigits('⑩')).toBe('10');
    expect(OTHER_DIGITS.some(([cp]) => cp === 0x2469)).toBe(false); // ⑩
    expect(OTHER_DIGITS.some(([cp]) => cp === 0xbd)).toBe(false); // ½
  });
});

describe('the digit table keeps up with the runtime (round 5)', () => {
  /** "17.0" or "17.0.0" as [17, 0, 0]. */
  const version = (v: string) =>
    [...v.split('.').map(Number), 0, 0, 0].slice(0, 3);
  const notOlder = (table: string, runtime: string) => {
    const [a, b] = [version(table), version(runtime)];
    const i = a.findIndex((n, k) => n !== b[k]);
    return i === -1 || a[i] > b[i];
  };
  /** Every No or Nl character this runtime knows. */
  const runtimeOthers = (): number[] => {
    const out: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (/[\p{No}\p{Nl}]/u.test(String.fromCodePoint(cp))) out.push(cp);
    }
    return out;
  };
  /** The shipped table with one character left out, as a table one Unicode version behind would be. */
  const without = (gone: number): DigitTable => ({
    digits: OTHER_DIGITS.filter(([cp]) => cp !== gone),
    otherNumbers: OTHER_NUMBERS.flatMap(([a, b]) =>
      gone < a || gone > b
        ? [[a, b] as const]
        : [
            ...(gone > a ? [[a, gone - 1] as const] : []),
            ...(gone < b ? [[gone + 1, b] as const] : []),
          ],
    ),
  });

  it("the table's Unicode version is not older than the runtime's", () => {
    expect(notOlder('17.0.0', '17.0')).toBe(true);
    expect(notOlder('14.0.0', '17.0')).toBe(false);
    expect(notOlder('17.0.0', '17.0.1')).toBe(false);
    const runtime = process.versions.unicode ?? '';
    expect(runtime).toMatch(/^\d+\.\d+/);
    expect({
      table: UNICODE_DIGIT_VERSION,
      runtime,
      notOlder: notOlder(UNICODE_DIGIT_VERSION, runtime),
    }).toEqual({ table: UNICODE_DIGIT_VERSION, runtime, notOlder: true });
  });

  it('the table holds exactly the No and Nl characters of the runtime, so none is unknown today', () => {
    const table = new Set<number>(OTHER_DIGITS.map(([cp]) => cp));
    for (const [a, b] of OTHER_NUMBERS)
      for (let cp = a; cp <= b; cp += 1) table.add(cp);
    const runtime = runtimeOthers();
    expect(runtime.filter((cp) => !table.has(cp))).toEqual([]);
    expect(table.size).toBe(runtime.length);
  });

  it('the 12 digits of Unicode 15 to 17 fold to their value: Kaktovik 0 to 9 and the Yangqin signs 1 and 2', () => {
    const added: [number, number][] = [
      ...Array.from(
        { length: 10 },
        (_, v) => [0x1d2c0 + v, v] as [number, number],
      ),
      [0x16ff4, 1],
      [0x16ff6, 2],
    ];
    for (const [cp, value] of added) {
      const ch = String.fromCodePoint(cp);
      expect({
        cp,
        entry: OTHER_DIGITS.some(([c, v]) => c === cp && v === value),
      }).toEqual({
        cp,
        entry: true,
      });
      expect({ cp, folded: foldDigits(ch) }).toEqual({
        cp,
        folded: String(value),
      });
      expect({ cp, masked: maskDigits(`MTN ${ch.repeat(6)}`) }).toEqual({
        cp,
        masked: `MTN •••• ${String(value).repeat(4)}`,
      });
    }
    // Kaktovik 10 and 19 are numbers of 10 or more: never folded to one digit.
    expect(maskDigits('MTN \u{1d2ca} \u{1d2d3}')).toBe(
      'MTN \u{1d2ca} \u{1d2d3}',
    );
  });

  it('fail closed: a number character the table does not know is hidden, counted, and never one of the shown 4', () => {
    // A table without Kaktovik one (U+1D2C1) and five (U+1D2C5) stands for a runtime one Unicode version ahead.
    const one = 0x1d2c1;
    const five = 0x1d2c5;
    const older = without(one);
    const behind = digitMasking({
      digits: older.digits.filter(([cp]) => cp !== five),
      otherNumbers: older.otherNumbers,
    });
    // Counted in its number: 11 digits, the last 4 known.
    expect(behind.maskDigits('MTN 𝋀𝋈𝋀𝋃𝋁𝋂𝋃𝋄𝋅𝋆𝋇')).toBe('MTN •••• 4•67');
    expect(behind.maskDigits('MTN 0803𝋁234567')).toBe('MTN •••• 4567');
    // One of the last 4: its place is a •, and no other digit moves up into it.
    expect(behind.maskDigits('MTN 𝋀8𜳰3𝋁2𜳳4𝋅6𜳷')).toBe('MTN •••• 4•67');
    expect(behind.maskDigits('MTN 0803123456𝋁')).toBe('MTN •••• 456•');
    // All unknown: nothing but •.
    expect(behind.maskDigits('MTN 𝋁𝋁𝋁𝋁𝋁𝋁')).toBe('MTN •••• ••••');
    // Fewer than 5 digits: still never shown.
    expect(behind.maskDigits('Flat 𝋁, Shop 12𝋅')).toBe('Flat •, Shop 12•');
    expect(behind.foldDigits('𝋀𝋁')).toBe('0•');
    // A noncharacter already in the text is never read as a number.
    expect(behind.maskDigits('MTN 0803﷐')).toBe('MTN 0803�');
    expect(maskDigits('MTN 0803﷐')).toBe('MTN 0803�');
  });

  it('fail closed, for every No and Nl character: left out of the table, it is never shown', () => {
    for (const cp of runtimeOthers()) {
      const ch = String.fromCodePoint(cp);
      const { maskDigits: mask } = digitMasking(without(cp));
      expect({ cp, alone: mask(`MTN ${ch}`) }).toEqual({ cp, alone: 'MTN •' });
      expect({ cp, run: mask(`MTN 0803${ch}2${ch}4567`) }).toEqual({
        cp,
        run: 'MTN •••• 4567',
      });
    }
  });
});

describe('the PDF page (round 4, D5)', () => {
  const W500 = 'W'.repeat(500);
  /** The verifier's refWide row: an out row, both names 500 wide letters, a 200-W reference. */
  const refWide = (): ReceiptDocument =>
    receiptDocument(
      view(
        tx({
          direction: 'out',
          category: 'transfer',
          amountKobo: 2500000,
          fee: { providerFeeKobo: 4000, wawuFeeKobo: 2500, totalFeeKobo: 6500 },
          totalKobo: 2506500,
          description: 'Transfer',
          reference: 'W'.repeat(200),
          counterparty: {
            kind: 'bank_account',
            name: W500,
            avatarUrl: null,
            wawuUserId: null,
            bankName: 'M'.repeat(500),
            accountNumberLast4: '6789',
          },
        }),
        'https://hub.example.test/api/hub/r/T1P97ZQAK3MP',
      ),
    );

  it("the verifier's refWide receipt fits the one A4 page, footer and link included", async () => {
    const doc = refWide();
    const card = receiptCard(doc);
    const at = pdfPlacement(card.height);
    expect(at.scale).toBeLessThan(1.25);
    expect(at.y).toBeGreaterThanOrEqual(36);
    expect(at.y + at.h).toBeLessThanOrEqual(A4.height);
    const pdf = (await receiptPdf(doc, new Date())).toString('latin1');
    // Where the picture is drawn, from the page's own content stream.
    const m = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im1 Do Q/.exec(
      pdf,
    )!;
    const [w, h, x, y] = m.slice(1).map(Number);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(A4.width);
    expect(y + h).toBeLessThanOrEqual(A4.height);
    // The footer's link sits on the page too.
    const r = /\/Rect \[([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)\]/
      .exec(pdf)!
      .slice(1)
      .map(Number);
    expect(r[1]).toBeGreaterThanOrEqual(0);
    expect(r[3]).toBeLessThanOrEqual(A4.height);
    expect(r[1]).toBeGreaterThanOrEqual(y);
  });

  it('an ordinary receipt keeps its full size, 72 pt from the top', () => {
    const at = pdfPlacement(receiptCard(receiptDocument(view(tx()))).height);
    expect(at.scale).toBe(1.25);
    expect(A4.height - (at.y + at.h)).toBe(72);
  });
});

describe('each line in its own box (round 4, R3)', () => {
  it('a line of characters the font lacks (emoji) leaves both side margins of the image blank', async () => {
    const png = await receiptPng({
      ...receiptDocument(view(tx())),
      lines: [
        { label: 'From', value: '👩‍👩‍👧‍👦'.repeat(60) + ' 🇳🇬'.repeat(30) },
        { label: 'Bank', value: '🏦'.repeat(200) },
      ],
    });
    const img = PNG(png);
    const stride = img.width * 4 + 1;
    const raw = img.rows(0, img.height);
    const margin = 20 * IMAGE_SCALE - 2; // PAD_X, less the antialiasing pixel
    let inked = 0;
    for (let y = 0; y < img.height; y += 1) {
      for (const x of [
        ...Array(margin).keys(),
        ...Array.from({ length: margin }, (_, i) => img.width - 1 - i),
      ]) {
        const at = y * stride + 1 + x * 4;
        if (raw[at] < 250 || raw[at + 1] < 250 || raw[at + 2] < 250) inked += 1;
      }
    }
    expect(inked).toBe(0);
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
