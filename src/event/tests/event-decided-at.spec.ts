import { EventService } from '../event.service';

/**
 * FIX-110 (E17's "Taken down 20 Sep"): `EventView.decidedAt` is the day an
 * admin last sent the event back or took it down, read from the review trail,
 * for the host's own rows only. No database: `listMine` is given a stand-in
 * for each table it reads.
 */

const HOST = 'host-1';
const STRANGER = 'stranger-1';
const TAKEN = new Date('2026-09-20T09:30:00.000Z');
const SENT_BACK_EARLIER = new Date('2026-09-10T09:30:00.000Z');

const row = (id: string, status: string, hostWawuId = HOST) => ({
  id,
  hostWawuId,
  name: id,
  description: '',
  hostOrg: '',
  hostOrgBio: null,
  format: 'in_person',
  type: 'workshop',
  startsAt: new Date('2026-12-01T09:00:00.000Z'),
  endsAt: null,
  timeLabel: null,
  timezone: null,
  location: '',
  address: null,
  venueName: null,
  externalUrl: null,
  bannerUrl: null,
  category: 'business',
  contactEmail: null,
  contactPhone: null,
  cancelledAt: null,
  cancelReason: null,
  recapUrl: null,
  recapText: null,
  featured: false,
  status,
  speakers: [],
  createdAt: new Date('2026-09-01T09:00:00.000Z'),
  lastDecisionReason: status === 'removed' ? 'Not happening.' : null,
});

function serviceWith(rows: ReturnType<typeof row>[]) {
  const groupBy = jest.fn(() =>
    Promise.resolve([
      { eventId: 'removed-1', _max: { reviewedAt: TAKEN } },
      { eventId: 'sent-back-1', _max: { reviewedAt: SENT_BACK_EARLIER } },
    ]),
  );
  const prisma = {
    $transaction: (ops: unknown[]) => Promise.all(ops),
    event: {
      findMany: () => Promise.resolve(rows),
      count: () => Promise.resolve(rows.length),
    },
    eventGoing: {
      groupBy: () => Promise.resolve([]),
      findMany: () => Promise.resolve([]),
    },
    eventSave: { findMany: () => Promise.resolve([]) },
    eventTicketType: { groupBy: () => Promise.resolve([]) },
    adminEventReview: { groupBy },
  };
  const verification = { forMany: () => Promise.resolve(new Map()) };
  const service = new EventService(
    prisma as never,
    verification as never,
    {} as never,
    {} as never,
  );
  return { service, groupBy };
}

const page = { page: 1, perPage: 20 } as never;

describe('EventView.decidedAt (FIX-110)', () => {
  it("is the last send back or takedown, on the host's rejected and removed rows", async () => {
    const { service, groupBy } = serviceWith([
      row('removed-1', 'removed'),
      row('sent-back-1', 'rejected'),
      row('live-1', 'published'),
      row('waiting-1', 'pending'),
    ]);
    const { items } = await service.listMine(HOST, page);
    const at = (id: string) => items.find((e) => e.id === id)!.decidedAt;
    expect(at('removed-1')).toEqual(TAKEN);
    expect(at('sent-back-1')).toEqual(SENT_BACK_EARLIER);
    expect(at('live-1')).toBeNull();
    expect(at('waiting-1')).toBeNull();
    // One grouped read, only for the rows that were decided against.
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eventId: { in: ['removed-1', 'sent-back-1'] },
          newStatus: { in: ['rejected', 'removed'] },
        },
      }),
    );
  });

  it('is never sent to anyone but the host, and costs no read when nothing was decided', async () => {
    const strangers = serviceWith([row('removed-1', 'removed')]);
    const seen = await strangers.service.listMine(STRANGER, page);
    expect(seen.items[0].decidedAt).toBeNull();
    expect(seen.items[0].lastDecisionReason).toBeNull();
    expect(strangers.groupBy).not.toHaveBeenCalled();

    const quiet = serviceWith([row('live-1', 'published')]);
    await quiet.service.listMine(HOST, page);
    expect(quiet.groupBy).not.toHaveBeenCalled();
  });
});
