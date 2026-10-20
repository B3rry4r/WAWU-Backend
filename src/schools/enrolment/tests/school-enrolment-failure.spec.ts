import { Prisma } from '../../../../generated/prisma/client';
import { describeDatabaseFailure } from '../school-enrolment-failure';

/**
 * FIX-69 (G-FIX-68-3): the line the release sweep logs names the Prisma code,
 * the Postgres state and the model, and never anything a person typed.
 */

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(
    'Invalid `prisma.schoolEnrolment.updateMany()` invocation: ada@example.com +2348012345678',
    { code, clientVersion: 'test', meta },
  );

describe('describeDatabaseFailure', () => {
  it('names the Prisma code and the model of a known request error', () => {
    const line = describeDatabaseFailure(
      known('P2025', { modelName: 'SchoolEnrolment' }),
    );
    expect(line).toBe(
      'PrismaClientKnownRequestError, prisma P2025, model SchoolEnrolment',
    );
  });

  it('tells a timeout from a deadlock: P2028 carries no state, a raw 40P01 carries it', () => {
    expect(describeDatabaseFailure(known('P2028'))).toBe(
      'PrismaClientKnownRequestError, prisma P2028',
    );
    expect(describeDatabaseFailure(known('P2024'))).toBe(
      'PrismaClientKnownRequestError, prisma P2024',
    );
    expect(
      describeDatabaseFailure(
        known('P2010', { code: '40P01', message: 'deadlock detected' }),
      ),
    ).toBe('PrismaClientKnownRequestError, prisma P2010, postgres 40P01');
  });

  it('reads the state from the driver adapter report (Prisma 7)', () => {
    expect(
      describeDatabaseFailure(
        known('P2010', {
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              kind: 'postgres',
              originalCode: '40P01',
              originalMessage: 'deadlock detected, ada@example.com',
            },
          },
        }),
      ),
    ).toBe('PrismaClientKnownRequestError, prisma P2010, postgres 40P01');
  });

  it('never prints the message, the query or the arguments', () => {
    const all = [
      known('P2010', {
        code: '40P01',
        message: 'ada@example.com +2348012345678',
        modelName: 'CourseIntake',
      }),
      known('P2028', { modelName: 'ada@example.com' }),
      new Error('ada@example.com +2348012345678'),
    ].map(describeDatabaseFailure);
    for (const line of all) {
      expect(line).not.toMatch(/ada@|\+234|2348012345678|invocation/i);
    }
    // A value that is not the right shape is left out, not printed.
    expect(all[1]).toBe('PrismaClientKnownRequestError, prisma P2028');
  });

  it('answers for a plain error and for something that is not an error', () => {
    expect(describeDatabaseFailure(new Error('x'))).toBe('Error');
    expect(describeDatabaseFailure('ada@example.com')).toBe('not an error');
    expect(describeDatabaseFailure(null)).toBe('not an error');
    expect(describeDatabaseFailure(undefined)).toBe('not an error');
  });
});
