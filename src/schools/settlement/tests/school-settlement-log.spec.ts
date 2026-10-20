import { Prisma } from '../../../../generated/prisma/client';
import { SchoolSettlementService } from '../school-settlement.service';

/**
 * FIX-69 L2 (SWEEP-LATE): the lines the settlement sweep logs for a failed
 * step name the Prisma code and the Postgres state, as the release sweep's do
 * (G-FIX-68-3), and never anything a person typed. Before this they printed
 * the error's class name only, so a timeout and a deadlock read the same.
 * No database and no provider: the steps are stood in.
 */

const failure = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Invalid invocation: ada@example.com +2348012345678',
    {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '40P01', message: 'deadlock detected' },
    },
  );

function service() {
  const logger = {
    error: jest.fn<void, [string]>(),
    warn: jest.fn(),
    log: jest.fn(),
  };
  const svc = Object.create(SchoolSettlementService.prototype) as unknown as {
    logger: typeof logger;
    prisma: unknown;
    provider: { name: string };
    decide: jest.Mock;
    drive: jest.Mock;
    run: SchoolSettlementService['run'];
    sweep: SchoolSettlementService['sweep'];
  };
  svc.logger = logger;
  svc.provider = { name: 'nuvion' };
  svc.prisma = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([{ id: 'pay-1' }])
      .mockResolvedValueOnce([{ id: 'ref-1' }]),
    schoolSettlement: {
      findMany: jest.fn().mockResolvedValue([{ id: 's-1' }]),
    },
  };
  svc.decide = jest.fn().mockRejectedValue(failure());
  svc.drive = jest.fn().mockRejectedValue(failure());
  return { svc, logger };
}

const WHAT = 'PrismaClientKnownRequestError, prisma P2010, postgres 40P01';

describe('the school settlement sweep names why a step failed', () => {
  it('run: the payout, the refund and the drive each log the code and the state', async () => {
    const { svc, logger } = service();
    await svc.run();
    const lines = logger.error.mock.calls.map((c) => c[0]);
    expect(lines).toEqual([
      `school settlement pay-1: could not decide the payout (${WHAT})`,
      `school settlement ref-1: could not decide the refund (${WHAT})`,
      `school settlement s-1: the sweep could not drive it (${WHAT})`,
    ]);
  });

  it('sweep: a pass that fails as a whole logs the code and the state', async () => {
    const { svc, logger } = service();
    (svc.prisma as { $queryRaw: jest.Mock }).$queryRaw = jest
      .fn()
      .mockRejectedValue(failure());
    await svc.sweep();
    expect(logger.error).toHaveBeenCalledWith(
      `school settlement sweep failed (${WHAT})`,
    );
  });

  it('never prints the message, the query or what a person typed', async () => {
    const { svc, logger } = service();
    await svc.run();
    const text = logger.error.mock.calls.map((c) => c[0]).join('\n');
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('2348012345678');
    expect(text).not.toContain('deadlock detected');
  });
});
