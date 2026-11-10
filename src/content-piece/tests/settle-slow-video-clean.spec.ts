// VIDEO-PRIVACY round 1: the publish check cleans a video only when it is the caller's own upload.
import { ContentPieceService } from '../content-piece.service';

describe('settleSlowUploads: video privacy hook', () => {
  it("cleans the caller's own confirmed uploads and no other key named in the request", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([]) // late (abandoned) rows: none
      .mockResolvedValueOnce([{ key: 'content/full/me/a.mp4' }]); // the caller's own
    const ensureVideoClean = jest.fn().mockResolvedValue(undefined);
    const svc = Object.create(
      ContentPieceService.prototype,
    ) as ContentPieceService;
    Object.assign(svc, {
      prisma: { storageObject: { findMany } },
      storage: { ensureVideoClean, settleUpload: jest.fn() },
    });
    await svc.settleSlowUploads('me', {
      fullAsset: 'content/full/me/a.mp4',
      previewAsset: 'content/full/someone-else/b.mp4',
    });
    const ownQuery = (findMany.mock.calls as unknown[][])[1][0] as {
      where: Record<string, unknown>;
    };
    expect(ownQuery.where).toMatchObject({
      wawuUserId: 'me',
      releasedAt: null,
      removingAt: null,
    });
    // Whatever the status: a web upload is still `pending` when its piece is published.
    expect(ownQuery.where).not.toHaveProperty('status');
    expect(ensureVideoClean).toHaveBeenCalledTimes(1);
    expect(ensureVideoClean).toHaveBeenCalledWith('content/full/me/a.mp4');
  });
});
