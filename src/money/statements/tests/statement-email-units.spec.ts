import type { WawuJwtClaims } from '../../../common/auth/wawu-jwt-claims.interface';
import {
  longDay,
  mailIdempotencyKey,
  maskedEmail,
  provenEmailOf,
  statementMail,
} from '../statement-email';
import type { StatementView } from '../statement-view.type';

/** The pure parts of emailing a statement (task WALLET-35). */

const claims = (over: Record<string, unknown>): WawuJwtClaims =>
  ({
    sub: 'u',
    email: 'a@b.co',
    emailVerified: true,
    ...over,
  }) as unknown as WawuJwtClaims;

describe('provenEmailOf', () => {
  it('is the token’s own address, and only when WAWU ID says it was confirmed', () => {
    expect(provenEmailOf(claims({}))).toBe('a@b.co');
    expect(provenEmailOf(claims({ email: '  a@b.co ' }))).toBe('a@b.co');
    for (const over of [
      { emailVerified: false },
      { emailVerified: 'true' },
      { emailVerified: 1 },
      { emailVerified: undefined },
      { email: null },
      { email: '' },
      { email: 'no-at-sign' },
      { email: '@b.co' },
      { email: 'a@' },
      { email: 'a b@c.co' },
      { email: 'a@b.co\r\nBcc: x@y.z' },
      { email: 'a@b.co, x@y.z' },
      { email: `${'a'.repeat(250)}@b.co` },
    ]) {
      expect(provenEmailOf(claims(over))).toBeNull();
    }
  });
});

describe('maskedEmail and longDay', () => {
  it('names the first letter and the domain only', () => {
    expect(maskedEmail('lennox@wawu.africa')).toBe('l***@wawu.africa');
    expect(maskedEmail('a@b.co')).toBe('a***@b.co');
  });
  it('writes a day out, with no leading zero', () => {
    expect(longDay('2026-09-01')).toBe('1 September 2026');
    expect(longDay('2026-12-31')).toBe('31 December 2026');
    expect(longDay('2026-02-09')).toBe('9 February 2026');
  });
});

describe('mailIdempotencyKey', () => {
  it('is stable for one person and one key, and never repeats without a key', () => {
    const k = mailIdempotencyKey('p1', 'attempt-0001');
    expect(mailIdempotencyKey('p1', 'attempt-0001')).toBe(k);
    expect(mailIdempotencyKey('p2', 'attempt-0001')).not.toBe(k);
    expect(mailIdempotencyKey('p1', 'attempt-0002')).not.toBe(k);
    expect(mailIdempotencyKey('p1', undefined)).not.toBe(
      mailIdempotencyKey('p1', undefined),
    );
    expect(mailIdempotencyKey('p1', 'short')).not.toBe(
      mailIdempotencyKey('p1', 'short'),
    );
    expect(k).toMatch(/^stmt-[0-9a-f]{48}$/);
    expect(k.length).toBeLessThanOrEqual(256);
  });
});

describe('statementMail', () => {
  const view = (rowCount: number): StatementView => ({
    from: '2026-09-01',
    to: '2026-09-30',
    timeZone: 'Africa/Lagos',
    format: 'csv',
    fileName: 'statement-2026-09-01-to-2026-09-30.csv',
    contentType: 'text/csv; charset=utf-8',
    rowCount,
    content: '',
    generatedAt: '2026-10-01T00:00:00.000Z',
  });
  it('says the period, the count and the file in plain words, with no em-dash and no markup in the text', () => {
    const m = statementMail(view(42));
    expect(m.subject).toBe(
      'Your wallet statement, 1 September 2026 to 30 September 2026',
    );
    expect(m.text).toContain('42 movements are listed');
    expect(m.text).toContain('statement-2026-09-01-to-2026-09-30.csv');
    expect(m.text).not.toContain('<');
    expect(statementMail(view(1)).text).toContain('1 movement is listed');
    expect(statementMail(view(0)).text).toContain('0 movements are listed');
    for (const s of [m.subject, m.text, m.html]) expect(s).not.toMatch(/[—–]/);
  });
});
