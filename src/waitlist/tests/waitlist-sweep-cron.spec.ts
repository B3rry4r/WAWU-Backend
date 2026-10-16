import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WaitlistService } from '../waitlist.service';
import { WaitlistSweepService } from '../waitlist-sweep.service';

/**
 * JOIN-01 round 3 (D1): the 5 minute re-check now walks every due row, so a
 * run can outlast the 5 minutes after a registration burst. The REAL
 * scheduler and the REAL sweep service run here with a database that answers
 * slowly (no real database, no Flutterwave): a tick that arrives while the
 * last run is still going must be skipped, not started beside it.
 */
describe('The re-check cron does not overlap itself (JOIN-01)', () => {
  it('skips a tick while the last run is still going, then runs again once it has finished', async () => {
    let inFlight = 0;
    let mostAtOnce = 0;
    let started = 0;
    const prisma = {
      waitlistRegistration: {
        findMany: async () => {
          started += 1;
          inFlight += 1;
          mostAtOnce = Math.max(mostAtOnce, inFlight);
          await new Promise((r) => setTimeout(r, 300));
          inFlight -= 1;
          return [];
        },
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        WaitlistSweepService,
        { provide: PrismaService, useValue: prisma },
        { provide: WaitlistService, useValue: { recheck: () => false } },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    try {
      const job = app
        .get(SchedulerRegistry)
        .getCronJob('waitlist-recheck-pending');
      // Three ticks while the first run is still going: one run, not three.
      await Promise.all([
        job.fireOnTick(),
        new Promise((r) => setTimeout(r, 50)).then(() => job.fireOnTick()),
        new Promise((r) => setTimeout(r, 100)).then(() => job.fireOnTick()),
      ]);
      expect({ started, mostAtOnce }).toEqual({ started: 1, mostAtOnce: 1 });
      // Once it has finished, the next tick runs.
      await job.fireOnTick();
      expect({ started, mostAtOnce }).toEqual({ started: 2, mostAtOnce: 1 });
    } finally {
      await app.close();
    }
  });
});
