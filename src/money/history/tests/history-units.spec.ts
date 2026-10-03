import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { PAYMENT_KINDS } from '../../dto/money-enums';
import {
  decodeCursor,
  decodeGroupKey,
  encodeCursor,
  encodeGroupKey,
} from '../history-keys';
import {
  CATEGORY_LABELS,
  COUNTERPARTY_FALLBACK_NAMES,
  DESCRIPTION_SEPARATOR,
  GROUP_COUNT_SUFFIX,
  LINK_KIND_LABELS,
} from '../history-labels';
import {
  feeOf,
  koboFromText,
  likePattern,
  searchText,
} from '../transaction-history.service';

/** The history's pure pieces (task MONEY-15). The routes are in money-history.contract.spec.ts. */
describe('history keys', () => {
  it('a cursor goes out and comes back as the same time and id', () => {
    const c = {
      at: '2026-09-26T08:02:00.123Z',
      id: '90c58e0e-ca19-43ca-96d6-a171f9e28146',
    };
    const raw = encodeCursor(c);
    expect(raw).toMatch(/^c1\.[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual(c);
  });

  it('a cursor this history did not write is a 400, never a query', () => {
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString('base64url');
    const id = '90c58e0e-ca19-43ca-96d6-a171f9e28146';
    for (const raw of [
      '',
      'c1.',
      'c1.!!',
      `c2.${b64(['2026-09-26T08:02:00.123Z', id])}`,
      `c1.${b64(['2026-09-26T08:02:00Z', id])}`,
      `c1.${b64(['2026-02-30T08:02:00.000Z', id])}`,
      `c1.${b64(['2026-09-26T08:02:00.123Z', 'not-an-id'])}`,
      `c1.${b64(['2026-09-26T08:02:00.123Z', id, 'x'])}`,
      `c1.${b64({ at: '2026-09-26T08:02:00.123Z', id })}`,
      `c1.${b64([1, id])}`,
      `c1.${Buffer.from('not json').toString('base64url')}`,
    ]) {
      expect(() => decodeCursor(raw)).toThrow(BadRequestException);
    }
  });

  it('a group key goes out and comes back as the same piece and day', () => {
    const g = { targetId: 'piece-1|odd', day: '2026-09-26' };
    expect(decodeGroupKey(encodeGroupKey(g))).toEqual(g);
  });

  it('a group key this history did not write is a 400', () => {
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const raw of [
      'g1.',
      `c1.${b64(['p', '2026-09-26'])}`,
      `g1.${b64(['', '2026-09-26'])}`,
      `g1.${b64(['p', '2026-9-26'])}`,
      `g1.${b64(['p', '2026-09-32'])}`,
      `g1.${b64(['p\u0000', '2026-09-26'])}`,
      `g1.${b64(['x'.repeat(201), '2026-09-26'])}`,
      `g1.${b64(['p'])}`,
    ]) {
      expect(() => decodeGroupKey(raw)).toThrow(BadRequestException);
    }
  });
});

describe('search text', () => {
  it('% _ and \\ are escaped, so they match only themselves', () => {
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
    expect(likePattern('Chidinma')).toBe('%Chidinma%');
  });

  it('is trimmed, loses any NUL, and is no search when nothing is left', () => {
    expect(searchText(undefined)).toBeNull();
    expect(searchText('   ')).toBeNull();
    expect(searchText('\u0000\u0000')).toBeNull();
    expect(searchText('  Ada\u0000 Obi ')).toBe('Ada Obi');
  });
});

describe('fees on a row (R-10, W27)', () => {
  const out = {
    direction: 'out' as const,
    amountKobo: 2_500_000,
    feeKobo: 6_500,
    totalKobo: 2_506_500,
  };

  it('the quoted split, when it adds up to what left the wallet', () => {
    expect(
      feeOf({ ...out, providerFeeKobo: 4_000, wawuFeeKobo: 2_500 }),
    ).toEqual({
      providerFeeKobo: 4_000,
      wawuFeeKobo: 2_500,
      totalFeeKobo: 6_500,
    });
  });

  it("otherwise Fintava's own charge, and WAWU's fee 0", () => {
    for (const split of [
      { providerFeeKobo: null, wawuFeeKobo: null },
      { providerFeeKobo: 4_000, wawuFeeKobo: null },
      { providerFeeKobo: 4_000, wawuFeeKobo: 2_000 },
      { providerFeeKobo: 6_500, wawuFeeKobo: 2_500 },
    ]) {
      expect(feeOf({ ...out, ...split })).toEqual({
        providerFeeKobo: 6_500,
        wawuFeeKobo: 0,
        totalFeeKobo: 6_500,
      });
    }
  });

  it('money in has no fees', () => {
    expect(
      feeOf({
        ...out,
        direction: 'in',
        providerFeeKobo: 4_000,
        wawuFeeKobo: 2_500,
      }),
    ).toEqual({ providerFeeKobo: 0, wawuFeeKobo: 0, totalFeeKobo: 0 });
  });
});

describe('kobo from the database', () => {
  it('is exact to 2^53 - 1 and refuses anything past it', () => {
    expect(koboFromText('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(koboFromText('0')).toBe(0);
    expect(() => koboFromText('9007199254740992')).toThrow(RangeError);
    expect(() => koboFromText('1.5')).toThrow();
  });
});

describe('the words a row is described with', () => {
  it('every category and every payment kind has a label; nothing a person reads has an em-dash', () => {
    for (const k of PAYMENT_KINDS)
      expect(LINK_KIND_LABELS[k]).toEqual(expect.any(String));
    const all = [
      ...Object.values(CATEGORY_LABELS),
      ...Object.values(LINK_KIND_LABELS),
      ...Object.values(COUNTERPARTY_FALLBACK_NAMES),
      DESCRIPTION_SEPARATOR,
      GROUP_COUNT_SUFFIX,
    ];
    for (const s of all) {
      expect(s).not.toMatch(/—/);
      expect(s).not.toMatch(/fintava|flutterwave|wawu/i);
    }
  });

  it('the history never asks Fintava: none of its code reaches the client', () => {
    const dir = join(__dirname, '..');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect({
        f,
        client: /fintava\/fintava-client|FintavaClient/.test(src),
      }).toEqual({ f, client: false });
    }
  });
});
