// VIDEO-PRIVACY round 2: a web upload is never confirmed by the app, so its row is
// `pending` when it is published. Every place a pending row is settled, and the sweep, clean it.
import { StorageService } from '../storage.service';

function service(over: Record<string, unknown>) {
  const ensure = jest.fn().mockResolvedValue(undefined);
  const svc = Object.create(StorageService.prototype) as StorageService;
  Object.assign(svc, {
    client: {},
    bucket: 'b',
    ensureVideoClean: ensure,
    ...over,
  });
  return { svc, ensure };
}

describe('pending video rows are cleaned where they are settled', () => {
  it('confirmUpload of a pending row cleans it once it is confirmed', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { svc, ensure } = service({
      prisma: { storageObject: { updateMany } },
      bucketHolds: () => Promise.resolve('present'),
    });
    expect(
      await svc.confirmUpload({
        id: 'r1',
        status: 'pending',
        key: 'content/full/u/a.mp4',
      }),
    ).toBe(true);
    expect(ensure).toHaveBeenCalledWith('content/full/u/a.mp4');
  });

  it('the reconcile that settles a stale pending row cleans it in the background', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'r1', key: 'profile/work/u/w.mp4' }]);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { svc, ensure } = service({
      prisma: { storageObject: { findMany, updateMany } },
      bucketHolds: () => Promise.resolve('present'),
    });
    await (
      svc as unknown as { reconcileStale(id: string): Promise<void> }
    ).reconcileStale('u');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1', status: 'pending' } }),
    );
    expect(ensure).toHaveBeenCalledWith('profile/work/u/w.mp4', {
      background: true,
    });
  });

  it('the sweep reads the pending rows of lately as well as the confirmed ones', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ key: 'content/full/u/p.mp4' }]);
    const { svc, ensure } = service({
      prisma: { storageObject: { findMany } },
    });
    expect(await svc.sweepVideoPrivacy(5)).toBe(1);
    const where = (findMany.mock.calls as unknown[][])[0][0] as {
      where: { OR: { status: string }[] };
    };
    expect(where.where.OR.map((c) => c.status)).toEqual([
      'confirmed',
      'pending',
    ]);
    expect(ensure).toHaveBeenCalledWith('content/full/u/p.mp4', {
      background: true,
    });
  });
});
