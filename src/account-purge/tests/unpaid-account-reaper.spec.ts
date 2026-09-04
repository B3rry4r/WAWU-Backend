import { UnpaidAccountReaperService } from '../unpaid-account-reaper.service';

/**
 * THE RULES THIS SWEEP MUST NEVER BREAK.
 *
 * It deletes real accounts irreversibly, so the interesting tests are all
 * about who it leaves alone. Each case below is an account that would be
 * wrongly destroyed if one condition were dropped.
 */
describe('unpaid account reaper', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const old = new Date(Date.now() - 3 * DAY);

  function build(opts: {
    profiles?: Array<{ wawuUserId: string; unpaidWarnedAt?: Date | null }>;
    subscriptions?: string[];
    entitled?: string[];
    enabled?: string;
    emailed?: boolean;
  }) {
    const purged: string[] = [];
    const warned: string[] = [];
    const identityDeleted: string[] = [];

    const prisma = {
      userProfile: {
        findMany: jest.fn().mockResolvedValue(
          (opts.profiles ?? []).map((p) => ({ wawuUserId: p.wawuUserId })),
        ),
        updateMany: jest.fn(async ({ where }: { where: { wawuUserId: string } }) => {
          warned.push(where.wawuUserId);
          return { count: 1 };
        }),
      },
      creatorSubscription: {
        findMany: jest.fn().mockResolvedValue(
          (opts.subscriptions ?? []).map((id) => ({ creatorWawuId: id })),
        ),
      },
      creatorState: {
        findMany: jest.fn().mockResolvedValue(
          (opts.entitled ?? []).map((id) => ({ wawuUserId: id })),
        ),
      },
    };
    const purge = {
      purge: jest.fn(async (id: string) => {
        purged.push(id);
        return { deleted: {}, total: 0 };
      }),
    };
    const wawuId = {
      scheduleAccountDeletion: jest.fn(async (id: string) => {
        identityDeleted.push(id);
        return { scheduled: true };
      }),
      finalizeAccountDeletion: jest.fn(),
    };
    const config = {
      get: (k: string) =>
        k === 'UNPAID_ACCOUNT_REAPER'
          ? ('enabled' in opts ? opts.enabled : 'on')
          : k === 'WEB_BASE_URL'
            ? 'https://wawuafrica.com'
            : 'key',
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { emailed: opts.emailed ?? true } }),
    }) as unknown as typeof fetch;

    const service = new UnpaidAccountReaperService(
      prisma as never,
      purge as never,
      config as never,
      wawuId as never,
    );
    return { service, purged, warned, identityDeleted, prisma };
  }

  it('does nothing at all unless it is switched on', async () => {
    const { service, purged, warned } = build({
      profiles: [{ wawuUserId: 'u1' }],
      enabled: undefined,
    });
    await service.run();
    expect(purged).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('leaves a creator who has ever subscribed, even if the plan has lapsed', async () => {
    const { service, purged } = build({
      profiles: [{ wawuUserId: 'lapsed' }],
      subscriptions: ['lapsed'],
    });
    await service.run();
    expect(purged).toEqual([]);
  });

  it('leaves a creator the gates already treat as paid', async () => {
    const { service, purged } = build({
      profiles: [{ wawuUserId: 'paid' }],
      entitled: ['paid'],
    });
    await service.run();
    expect(purged).toEqual([]);
  });

  it('only ever asks for creator accounts', async () => {
    const { service, prisma } = build({ profiles: [] });
    await service.run();
    for (const call of prisma.userProfile.findMany.mock.calls) {
      expect(call[0].where.accountType).toBe('creator');
    }
  });

  it('does not start the deletion clock when the warning could not be delivered', async () => {
    const { service, warned } = build({
      profiles: [{ wawuUserId: 'no-address' }],
      emailed: false,
    });
    await service.run();
    // Unstamped means unwarned, and unwarned is never deleted.
    expect(warned).toEqual([]);
  });

  it('purges the data and the identity together', async () => {
    const { service, purged, identityDeleted } = build({
      profiles: [{ wawuUserId: 'gone', unpaidWarnedAt: old }],
    });
    await service.run();
    expect(purged).toContain('gone');
    expect(identityDeleted).toContain('gone');
  });

  it('caps how many it can take in one run', async () => {
    const { service, prisma } = build({ profiles: [] });
    await service.run();
    for (const call of prisma.userProfile.findMany.mock.calls) {
      expect(call[0].take).toBeLessThanOrEqual(200);
    }
  });
});
