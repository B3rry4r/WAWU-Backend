// INBOX-03 round 4 (S2): which Retry-After values from Expo count at all.
// Pure function, no database. The cap itself is in the sender and is covered
// in push-sender.contract.spec.ts.
import { parseRetryAfter } from '../expo-push.client';

describe('parseRetryAfter', () => {
  it.each([
    ['30', 30],
    [' 30 ', 30],
    ['1', 1],
    ['100000', 100000],
    // far too long to wait, but a plain number: the sender caps it
    ['99999999999999999999', 1e20],
  ])('reads whole seconds (%s)', (header, seconds) => {
    expect(parseRetryAfter(header)).toBe(seconds);
  });

  const IGNORED: Array<{ header: string | null; why: string }> = [
    { header: null, why: 'no header' },
    { header: '', why: 'empty' },
    { header: '   ', why: 'blank' },
    { header: '0', why: 'zero' },
    { header: '-5', why: 'negative' },
    { header: '+5', why: 'signed' },
    { header: '2.5', why: 'a fraction' },
    { header: '1e20', why: 'scientific notation' },
    { header: '0x10', why: 'hex' },
    { header: 'abc', why: 'text' },
    { header: '30 seconds', why: 'text after the number' },
    { header: 'Infinity', why: 'Infinity' },
    { header: 'NaN', why: 'NaN' },
    { header: '1'.repeat(400), why: 'a number that overflows to Infinity' },
    { header: 'Wed, 21 Oct 2099 07:28:00 GMT', why: 'an HTTP date' },
  ];

  it.each(IGNORED)('ignores $why', ({ header }) => {
    expect(parseRetryAfter(header)).toBeNull();
  });
});
