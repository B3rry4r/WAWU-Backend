import { cleanAiText, readableOption, withoutControlChars } from '../ai-text';

/**
 * R2-LEGAL2 (CHECK-3 legal M-1, M-2): what a model writes is made safe to
 * show and to store, and a tap is always a word a person reads.
 */
describe('ai-text', () => {
  describe('control characters (M-2)', () => {
    it('removes U+0008 and the other control characters, not the line breaks', () => {
      expect(cleanAiText('Property\u0008 Rent increase dispute')).toBe(
        'Property Rent increase dispute',
      );
      expect(cleanAiText('a\u0007b\u001Fc\u007Fd\u0085e')).toBe('a b c d e');
      expect(cleanAiText('one\ntwo\tthree')).toBe('one\ntwo\tthree');
    });

    it('still removes NUL and em-dashes', () => {
      expect(cleanAiText('a\u0000b')).toBe('ab');
      expect(cleanAiText('rent — rise')).toBe('rent, rise');
    });

    it('withoutControlChars leaves ordinary text alone', () => {
      expect(withoutControlChars('Lekki, Lagos 60%')).toBe('Lekki, Lagos 60%');
    });
  });

  describe('readableOption (M-1)', () => {
    it('turns an option id into words', () => {
      expect(readableOption('business_owner')).toBe('Business owner');
      expect(readableOption('one_only')).toBe('One only');
      expect(readableOption('no_rush')).toBe('No rush');
      expect(readableOption('individual')).toBe('Individual');
      expect(readableOption('yes')).toBe('Yes');
      expect(readableOption('businessOwner')).toBe('Business owner');
    });

    it("uses the question bank's own label for an option id it knows (R2-LEGAL3)", () => {
      // "Other african" and "Outside africa" were the raw ids read as words;
      // the bank's labels are what the form shows.
      expect(readableOption('other_african')).toBe('Another African country');
      expect(readableOption('outside_africa')).toBe('Outside Africa');
      expect(readableOption('south_africa')).toBe('South Africa');
      expect(readableOption('multiple_african')).toBe(
        'Several African countries',
      );
    });

    it('keeps reading an id the bank does not know, or names two ways, as words', () => {
      expect(readableOption('no_rush')).toBe('No rush');
      // Same id, different labels in different questions: no single label is true.
      expect(readableOption('other')).toBe('Other');
    });

    it('leaves a label that is already words alone', () => {
      expect(readableOption("Yes, there's a clause")).toBe(
        "Yes, there's a clause",
      );
      expect(readableOption('Business owner')).toBe('Business owner');
      expect(readableOption('I am not sure')).toBe('I am not sure');
    });
  });
});
