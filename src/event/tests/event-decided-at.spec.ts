import { EventService } from '../event.service';

/**
 * FIX-110 (E17's "Taken down 20 Sep"): `GET /events/mine/decisions` is the day
 * an admin last sent each of the host's events back or took it down, read from
 * the review trail. No database: each table the method reads is a stand-in.
 */

const HOST = 'host-1';
const TAKEN = new Date('2026-09-20T09:30:00.000Z');
const SENT_BACK = new Date('2026-09-10T09:30:00.000Z');

function serviceWith(
  events: { id: string }[],
  trail: { eventId: string; _max: { reviewedAt: Date | null } }[],
) {
  const findMany = jest.fn(() => Promise.resolve(events));
  const groupBy = jest.fn(() => Promise.resolve(trail));
  const prisma = { event: { findMany }, adminEventReview: { groupBy } };
  const service = new EventService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, findMany, groupBy };
}

describe('GET /events/mine/decisions (FIX-110)', () => {
  it("is the last send back or takedown of each of the host's rejected and removed events", async () => {
    const { service, findMany, groupBy } = serviceWith(
      [{ id: 'removed-1' }, { id: 'sent-back-1' }],
      [
        { eventId: 'removed-1', _max: { reviewedAt: TAKEN } },
        { eventId: 'sent-back-1', _max: { reviewedAt: SENT_BACK } },
      ],
    );
    expect(await service.decisionsMine(HOST)).toEqual({
      items: [
        { eventId: 'removed-1', decidedAt: TAKEN },
        { eventId: 'sent-back-1', decidedAt: SENT_BACK },
      ],
    });
    // Only the caller's own events, only those standing rejected or removed.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          hostWawuId: HOST,
          status: { in: ['rejected', 'removed'] },
        },
      }),
    );
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eventId: { in: ['removed-1', 'sent-back-1'] },
          newStatus: { in: ['rejected', 'removed'] },
        },
      }),
    );
  });

  it('reads nothing from the trail when no event of theirs stands decided against', async () => {
    const { service, groupBy } = serviceWith([], []);
    expect(await service.decisionsMine(HOST)).toEqual({ items: [] });
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('leaves out an event with no decision in the trail', async () => {
    const { service } = serviceWith(
      [{ id: 'removed-1' }],
      [{ eventId: 'removed-1', _max: { reviewedAt: null } }],
    );
    expect(await service.decisionsMine(HOST)).toEqual({ items: [] });
  });
});
