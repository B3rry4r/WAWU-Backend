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

  it.each([
    [null, 'no header'],
    ['', 'empty'],
    ['   ', 'blank'],
    ['0', 'zero'],
    ['-5', 'negative'],
    ['+5', 'signed'],
    ['2.5', 'a fraction'],
    ['1e20', 'scientific notation'],
    ['0x10', 'hex'],
    ['abc', 'text'],
    ['30 seconds', 'text after the number'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['1'.repeat(400), 'a number that overflows to Infinity'],
    ['Wed, 21 Oct 2099 07:28:00 GMT', 'an HTTP date'],
  ])('ignores %p (%s)', (header) => {
    expect(parseRetryAfter(header)).toBeNull();
  });
});
