/* eslint-disable */
// SETTINGS-06 round 9 (verifier round 8, findings R8-2 and R8-4): the scrub
// reads ONE phone number at a time, in linear time. The table below is the
// verifier's own list, both ways: every phone it lists goes, every price, year
// and count it lists stays.
import { SCRUBBED_WORD, scrubContactDetails } from '../scrub-contact-details';

const W = SCRUBBED_WORD;

/** [input, output]: what the verifier listed as leaking or over-scrubbed, and the held shapes. */
const goes: [string, string][] = [
  // the shapes that held in round 8
  ['Call 08012345678 now', `Call ${W} now`],
  ['Call +2348012345678 now', `Call ${W} now`],
  ['Call 0801 234 5678 now', `Call ${W} now`],
  ['Call (0801) 234 5678', `Call ${W}`],
  ['Call 0801-234-5678.', `Call ${W}.`],
  ['Call +234-801-234-5678', `Call ${W}`],
  ['call +234 (0) 801 234 5678', `call ${W}`],
  ['call +234 801 234 5678 please', `call ${W} please`],
  ['Reach 0801.234.5678 today', `Reach ${W} today`],
  ['234 801 234 5678', W],
  ['+1 415 555 2671', W],
  ['+1 (415) 555-2671', W],
  ['+44 20 7946 0958', W],
  ['+91 98765 43210', W],
  ['tel:+2348012345678', `tel:${W}`],
  ['WhatsApp:08012345678', `WhatsApp:${W}`],
  // R8-2: a number that follows another number or a date was judged with it
  ['Call 08012345678 08098765432', `Call ${W} ${W}`],
  ['0801 234 5678  0902 345 6789', `${W}  ${W}`],
  ['08012345678-08098765432', `${W}-${W}`],
  ['Sold 2026-10-17 08012345678', `Sold 2026-10-17 ${W}`],
  ['Updated 12.05.2024. 0801 234 5678', `Updated 12.05.2024. ${W}`],
  ['Updated 12.05.2024 0801 234 5678', `Updated 12.05.2024 ${W}`],
  ['Ref 24680. 08012345678', `Ref 24680. ${W}`],
  ['Lesson 12 - 08012345678', `Lesson 12 - ${W}`],
  ['Course 2026. 08012345678', `Course 2026. ${W}`],
  ['Course 2026 08012345678', `Course 2026 ${W}`],
  ['08012345678 2026', `${W} 2026`],
  ['Phone: 08012345678 (2026)', `Phone: ${W} (2026)`],
  ['0801 234 5678 2026', `${W} 2026`],
  // R8-2: other separators, and a number glued to letters
  ['0801,234,5678', W],
  ['0801/234/5678', W],
  ['WhatsApp08012345678', `WhatsApp${W}`],
  ['08012345678abc', `${W}abc`],
  ['a08012345678', `a${W}`],
  // emails
  ['mail ada@example.com or ada.o+tag@mail.example.co.uk', `mail ${W} or ${W}`],
  ['ada@localhost', W],
  ['ADA@EXAMPLE.COM.', `${W}.`],
  ['Joe (joe@x.com)', `Joe (${W})`],
  ['a@b.co,c@d.co', `${W},${W}`],
  ['Contact: ada_o@gmail.com.', `Contact: ${W}.`],
];

const stays = [
  'Year 2026',
  'Since 2019 and 2026',
  'Price N12,000',
  'Price N12000',
  'NGN 1,200,000.00',
  '₦5,000 - ₦10,000',
  'Tiers 5000 10000 15000',
  '5000 - 10000 - 20000',
  'Runs 2026 2027 2028',
  'Lessons 1 2 3 4 5 6 7 8 9 10',
  'Steps 0 1 2 3 4 5 6 7 8 9 10',
  '100 200 300 400',
  '12 lessons 24 videos 3 hours',
  '12 lessons for ₦5,000 since 2024.',
  'Dates 12-10-2026',
  '12.10.2026 and 13.10.2026',
  '2024-10-05',
  'Order 1234567890',
  'id 1234567890123456 end',
  '12345678',
  '123456789',
  '1234567890',
  '12345678901234567',
  'v2.0.1.2.3.4.5.6.7.8',
  '3.14159265358979',
  'Course 101 (2026) 8 weeks',
  '10 000 students',
  'Only ₦1,500,000',
  'Call me, ask for Ada',
  'meet @ 5pm and @ada',
  '',
];

describe('scrubContactDetails', () => {
  it.each(goes)('goes: %j', (input, output) => {
    expect(scrubContactDetails(input)).toBe(output);
  });

  it.each(stays)('stays: %j', (input) => {
    expect(scrubContactDetails(input)).toBe(input);
  });

  it('a list of numbers is scrubbed one at a time, and the prices and years between them stay', () => {
    const text =
      'Tiers 5000 10000 15000 for 2026 2027. Call 08012345678 or 0902 345 6789, 08098765432; since 2024, 12 lessons.';
    expect(scrubContactDetails(text)).toBe(
      `Tiers 5000 10000 15000 for 2026 2027. Call ${W} or ${W}, ${W}; since 2024, 12 lessons.`,
    );
  });

  it('is idempotent and writes no em-dash', () => {
    for (const [input] of goes) {
      const once = scrubContactDetails(input);
      expect(scrubContactDetails(once)).toBe(once);
      expect(once).not.toContain('—');
    }
  });

  it('100,000 characters take well under 100 ms, whatever they are', () => {
    const shapes: Record<string, string> = {
      letters: 'a'.repeat(100000),
      dotted: 'a.'.repeat(50000) + '@',
      ats: '@'.repeat(100000),
      localAts: 'a@'.repeat(50000),
      digits: '1'.repeat(100000),
      spacedOnes: '1 '.repeat(50000),
      spacedZeros: '0 '.repeat(50000),
      groups: '0801 '.repeat(20000),
      phones: '08012345678 '.repeat(7700),
      pluses: '+1 '.repeat(33000),
      brackets: '(0'.repeat(50000),
      mixed: 'Call 08012345678 or a@b.co, 2026 5000 '.repeat(2700),
    };
    for (const [name, text] of Object.entries(shapes)) {
      const start = performance.now();
      scrubContactDetails(text);
      const took = performance.now() - start;
      expect({ name, fast: took < 100 }).toEqual({ name, fast: true });
    }
  });
});
