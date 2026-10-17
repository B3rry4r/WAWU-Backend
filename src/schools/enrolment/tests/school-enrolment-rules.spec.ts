import {
  DEFAULT_MAX_OPEN_RESERVATIONS,
  DEFAULT_RESERVATION_MINUTES,
  integerSetting,
  intakeStillOpen,
  lagosToday,
  newEnrolmentReference,
  reservedUntil,
  splitCourseFee,
} from '../school-enrolment-rules';

describe('SCHOOLS-07 rules', () => {
  describe('splitCourseFee (R-12, 85/15)', () => {
    it('gives the school 85% and WAWU the rest, and they add up to the fee', () => {
      expect(splitCourseFee(15_000_000)).toEqual({
        schoolShareKobo: 12_750_000,
        wawuShareKobo: 2_250_000,
        commissionBps: 1500,
      });
    });

    it('rounds the school share down so WAWU never gets less than 15%', () => {
      for (const price of [1, 7, 99, 10_001, 1_000_001, 2_147_483_647]) {
        const s = splitCourseFee(price);
        expect(s.schoolShareKobo + s.wawuShareKobo).toBe(price);
        expect(s.schoolShareKobo).toBe(Math.floor((price * 85) / 100));
        expect(s.wawuShareKobo).toBeGreaterThanOrEqual(
          Math.floor((price * 15) / 100),
        );
      }
    });

    it('splits a fee of nothing into nothing and refuses a fraction or a negative', () => {
      expect(splitCourseFee(0)).toMatchObject({
        schoolShareKobo: 0,
        wawuShareKobo: 0,
      });
      expect(() => splitCourseFee(10.5)).toThrow(RangeError);
      expect(() => splitCourseFee(-1)).toThrow(RangeError);
    });
  });

  describe('newEnrolmentReference', () => {
    it('is WAW- and two groups of four characters nobody mistakes for another', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(newEnrolmentReference()).toMatch(
          /^WAW-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
        );
      }
    });

    it('does not repeat in a few thousand tries', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 5000; i += 1) seen.add(newEnrolmentReference());
      expect(seen.size).toBe(5000);
    });
  });

  describe('when an intake still takes enrolments', () => {
    const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

    it('reads today in Lagos, not in UTC', () => {
      // 23:30 UTC on the 2nd is 00:30 on the 3rd in Lagos (UTC+1).
      expect(lagosToday(new Date('2030-11-02T23:30:00.000Z'))).toBe(
        '2030-11-03',
      );
      expect(lagosToday(new Date('2030-11-02T22:30:00.000Z'))).toBe(
        '2030-11-02',
      );
    });

    it('is open up to and including the day it starts', () => {
      const now = new Date('2030-11-03T10:00:00.000Z');
      expect(intakeStillOpen(day('2030-11-03'), now)).toBe(true);
      expect(intakeStillOpen(day('2030-11-04'), now)).toBe(true);
      expect(intakeStillOpen(day('2030-11-02'), now)).toBe(false);
    });

    it('closes when the Lagos day after the start begins, which is before midnight UTC', () => {
      expect(
        intakeStillOpen(
          day('2030-11-03'),
          new Date('2030-11-03T23:30:00.000Z'),
        ),
      ).toBe(false);
    });
  });

  describe('settings', () => {
    it('keeps a place for the given minutes', () => {
      const now = new Date('2030-01-01T00:00:00.000Z');
      expect(reservedUntil(now, 30).toISOString()).toBe(
        '2030-01-01T00:30:00.000Z',
      );
    });

    it('takes a whole number inside its range, else the default', () => {
      const range = { min: 5, max: 1440 };
      expect(integerSetting(undefined, 30, range)).toBe(30);
      expect(integerSetting('', 30, range)).toBe(30);
      expect(integerSetting('45', 30, range)).toBe(45);
      expect(integerSetting('4', 30, range)).toBe(30);
      expect(integerSetting('1441', 30, range)).toBe(30);
      expect(integerSetting('12.5', 30, range)).toBe(30);
      expect(integerSetting('abc', 30, range)).toBe(30);
    });

    it('has defaults inside their ranges', () => {
      expect(DEFAULT_RESERVATION_MINUTES).toBeGreaterThanOrEqual(5);
      expect(DEFAULT_MAX_OPEN_RESERVATIONS).toBeGreaterThanOrEqual(1);
    });
  });
});
