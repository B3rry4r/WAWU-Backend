import type { ContentPiece } from '../../../generated/prisma/client';
import { DELETED_CREATOR_ID } from '../deleted-creator';
import { hiddenByDeletion, readHidden } from '../deletion-hid';

/**
 * SETTINGS-06 L15 (SWEEP-MONEY): a read that missed the deletion marker just
 * before the purge's strip committed re-reads the piece, finds it removed and
 * keyed to the deleted account, and must look the marker up again instead of
 * trusting the creator id: a piece that was taken down before the deletion is
 * not the buyers', so it must not be handed to a completed buyer.
 */

type Marker = { priorStatus: string } | null;

/** A database whose marker answers come from a list, one per lookup, in order. */
function fakeDb(markers: Marker[], now: Partial<ContentPiece> | null) {
  const answers = [...markers];
  return {
    accountDeletionContent: {
      findFirst: jest.fn(() => Promise.resolve(answers.shift() ?? null)),
    },
    contentPiece: { findUnique: jest.fn(() => Promise.resolve(now)) },
    purchase: { findFirst: jest.fn() },
  } as never;
}

const removed = {
  id: 'p1',
  status: 'removed' as const,
  creatorWawuId: 'creator-1',
};
const stripped = { ...removed, creatorWawuId: DELETED_CREATOR_ID };

describe('a piece the strip re-keyed while it was being read', () => {
  it("readHidden: the second marker lookup finds the strip's marker of a piece taken down earlier, so it is not the buyers'", async () => {
    const out = await readHidden(
      fakeDb([null, { priorStatus: 'removed' }], stripped),
      removed as ContentPiece,
    );
    expect(out.hidden).toBe(false);
  });

  it('hiddenByDeletion: the same', async () => {
    expect(
      await hiddenByDeletion(
        fakeDb([null, { priorStatus: 'removed' }], stripped),
        removed,
      ),
    ).toBe(false);
  });

  it("a piece that was live when the deletion started stays the buyers' whichever lookup finds the marker", async () => {
    expect(
      (
        await readHidden(
          fakeDb([null, { priorStatus: 'live' }], stripped),
          removed as ContentPiece,
        )
      ).hidden,
    ).toBe(true);
    expect(
      await hiddenByDeletion(
        fakeDb([null, { priorStatus: 'live' }], stripped),
        removed,
      ),
    ).toBe(true);
  });

  it("a purge from before the markers (no marker at all) is still the buyers' on the creator id", async () => {
    expect(
      (
        await readHidden(
          fakeDb([null, null], stripped),
          removed as ContentPiece,
        )
      ).hidden,
    ).toBe(true);
    expect(
      await hiddenByDeletion(fakeDb([null, null], stripped), removed),
    ).toBe(true);
  });

  it('a piece not keyed to the deleted account, or no longer removed, is not hidden', async () => {
    expect(
      (await readHidden(fakeDb([null], removed), removed as ContentPiece))
        .hidden,
    ).toBe(false);
    expect(
      (
        await readHidden(
          fakeDb([null], { ...removed, status: 'live' as const }),
          removed as ContentPiece,
        )
      ).hidden,
    ).toBe(false);
    expect(await hiddenByDeletion(fakeDb([null], null), removed)).toBe(false);
  });
});
