import { BadRequestException } from '@nestjs/common';
import { readHistoryTake } from '../wallet-history-take';

/**
 * FIX-18: GET /wallet/history?take=... Three kinds of value used to reach
 * Prisma and answer 500 (not a number, `take` sent twice, a negative too big
 * to take). They answer 400 naming `take`. Every value that answered anything
 * else is read exactly as it was: `take ? Number(take) : undefined`.
 */
describe('readHistoryTake', () => {
  const asBefore = (raw: string) => (raw ? Number(raw) : undefined);

  it('reads every value that never failed exactly as before', () => {
    const fine = [
      '',
      '0',
      '1',
      '50',
      '200',
      '201',
      '1000',
      '-1',
      '-5',
      '-2147483649',
      '-9223372036854774784',
      '1.5',
      '0.5',
      '-0.5',
      '-0',
      '1e2',
      '0x10',
      '0b11',
      '+5',
      ' 5 ',
      ' 5',
      '00003',
      '.5',
      '5.',
      'Infinity',
      '1e400',
      '1e21',
      '4294967296',
    ];
    for (const raw of fine) {
      expect(readHistoryTake(raw)).toBe(asBefore(raw));
    }
    expect(readHistoryTake(undefined)).toBeUndefined();
  });

  it('answers 400 naming take for a value that is not a number', () => {
    for (const raw of ['abc', 'NaN', '\0', '1_0', '1,2', 'true', 'null']) {
      expect(() => readHistoryTake(raw)).toThrow(BadRequestException);
      expect(() => readHistoryTake(raw)).toThrow(/^take must be/);
    }
  });

  it('answers 400 naming take when take is sent twice or more', () => {
    for (const raw of [
      ['1', '2'],
      ['', ''],
      ['5', '5', '5'],
      ['1', ''],
    ]) {
      expect(() => readHistoryTake(raw)).toThrow(BadRequestException);
      expect(() => readHistoryTake(raw)).toThrow(/^take must be/);
    }
  });

  it('answers 400 naming take for a negative Prisma cannot take', () => {
    for (const raw of [
      '-Infinity',
      '-1e400',
      '-1e21',
      '-9223372036854775808',
      '-10000000000000000000',
    ]) {
      expect(() => readHistoryTake(raw)).toThrow(BadRequestException);
      expect(() => readHistoryTake(raw)).toThrow(/^take is out of range/);
    }
  });

  it('keeps em-dashes out of its messages', () => {
    for (const raw of ['abc', ['1', '2'], '-Infinity']) {
      try {
        readHistoryTake(raw);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as Error).message).not.toContain('—');
      }
    }
  });
});
