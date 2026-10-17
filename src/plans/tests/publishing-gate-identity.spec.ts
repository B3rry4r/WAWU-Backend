import {
  IdentityPausedError,
  type IdentityPause,
  type IdentityPauseService,
} from '../../money/opening/identity-pause';
import { PublishingGate } from '../publishing-gate.service';
import { TierGateError } from '../tier-gate-error';
import { publishingOver, publishingTables } from './publishing-fakes';

/**
 * S7 round 2, F3: the Hub's publishing gate refuses while the person's
 * identity check is paused, with one code (403 `identity_paused`) and the
 * Hub's own sentence. The tier comes first and the room after. A check that
 * passed, and one never started, are refused nothing (as before). The real
 * allowance and gate over small fakes.
 */

const PAUSED: IdentityPause = {
  stage: 'needs_documents',
  message:
    'Publishing is paused until your identity check passes. Your wallet is not finished opening. Send the documents the bank asked for.',
};

/** The reader as the gate sees it, and its `of` spy for the cases that count calls. */
function identityOf(found: IdentityPause | null) {
  const of = jest.fn().mockResolvedValue(found);
  return { reader: { of } as unknown as IdentityPauseService, of };
}

function gateFor(
  world: Parameters<typeof publishingTables>[0],
  identity?: IdentityPauseService,
) {
  const { allowance } = publishingOver(publishingTables(world));
  return new PublishingGate(allowance, identity);
}

const RUNNING = { tier: { endsInDays: 20, productsIncluded: 3 }, slotsUsed: 0 };

describe('the publishing gate and the identity pause (S7 round 2, F3)', () => {
  it('refuses an upload while the check is paused, with the one code and the Hub’s sentence', async () => {
    const gate = gateFor(RUNNING, identityOf(PAUSED).reader);
    const error = await gate
      .assertMayUpload('creator-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityPausedError);
    const refused = error as IdentityPausedError;
    expect(refused.getStatus()).toBe(403);
    expect(refused.getResponse()).toMatchObject({
      message: PAUSED.message,
      reason: {
        code: 'identity_paused',
        message: PAUSED.message,
        stage: 'needs_documents',
      },
    });
  });

  it('refuses a publish the same way: the room is asked only after the identity', async () => {
    const gate = gateFor(RUNNING, identityOf(PAUSED).reader);
    await expect(gate.assertRoomForProduct('creator-1')).rejects.toBeInstanceOf(
      IdentityPausedError,
    );
  });

  it('a person at every place used who is paused is told about the identity, not the limit', async () => {
    const gate = gateFor(
      { tier: { endsInDays: 20, productsIncluded: 3 }, slotsUsed: 3 },
      identityOf(PAUSED).reader,
    );
    await expect(gate.assertRoomForProduct('creator-1')).rejects.toBeInstanceOf(
      IdentityPausedError,
    );
  });

  it('a person with no tier is told tier_required first, and the identity is not even read', async () => {
    const identity = identityOf(PAUSED);
    const gate = gateFor({}, identity.reader);
    const error = await gate
      .assertRoomForProduct('creator-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TierGateError);
    expect((error as TierGateError).code).toBe('tier_required');
    expect(identity.of).not.toHaveBeenCalled();
  });

  it('a check that passed or never started (nothing paused) publishes as before', async () => {
    const identity = identityOf(null);
    const gate = gateFor(RUNNING, identity.reader);
    await expect(gate.assertMayUpload('creator-1')).resolves.toMatchObject({
      basis: expect.any(String) as string,
    });
    await expect(gate.assertRoomForProduct('creator-1')).resolves.toBeDefined();
    expect(identity.of).toHaveBeenCalledWith('creator-1');
  });

  it('a gate built without the reader (a unit spec) pauses nothing', async () => {
    const gate = gateFor(RUNNING);
    await expect(gate.assertRoomForProduct('creator-1')).resolves.toBeDefined();
  });

  it('a person who is at the limit and not paused is still refused product_limit_reached', async () => {
    const gate = gateFor(
      { tier: { endsInDays: 20, productsIncluded: 3 }, slotsUsed: 3 },
      identityOf(null).reader,
    );
    const error = await gate
      .assertRoomForProduct('creator-1')
      .catch((e: unknown) => e);
    expect((error as TierGateError).code).toBe('product_limit_reached');
  });
});
