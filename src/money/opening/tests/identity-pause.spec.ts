import { HttpStatus } from '@nestjs/common';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import { CLAIM_LOST } from '../bvn-claim';
import {
  IDENTITY_PAUSED_CODE,
  IdentityPausedError,
  IdentityPauseService,
  identityPauseOf,
  type PauseEntity,
  type PauseOpening,
} from '../identity-pause';

/**
 * S7 round 2, F3: the identity pause is the Hub's. The rule over the stored
 * rows, and the reader that fetches them. Pure and fakes only.
 */

const entity = (over: Partial<PauseEntity> = {}): PauseEntity => ({
  entityId: 'ent_1',
  status: 'pending',
  decidedAt: null,
  correctedAt: null,
  bvnStatus: null,
  ninStatus: null,
  documentStatus: null,
  addressProofStatus: null,
  rejectionReasons: [],
  ...over,
});

const pause = (
  e: PauseEntity | null,
  opening: PauseOpening | null = { state: 'review', failure: null },
  over: { reviews?: boolean; hasWallet?: boolean } = {},
) =>
  identityPauseOf({
    reviews: over.reviews ?? true,
    hasWallet: over.hasWallet ?? false,
    opening,
    entity: e,
  });

describe('identityPauseOf (S7 round 2, F3)', () => {
  it('a check waiting for documents is paused, with the Hub’s sentence', () => {
    const p = pause(entity({ status: 'incomplete' }));
    expect(p?.stage).toBe('needs_documents');
    expect(p?.message).toBe(
      'Publishing is paused until your identity check passes. Your wallet is not finished opening. Send the documents the bank asked for.',
    );
  });

  it('a refused check is paused and says what failed and what to fix', () => {
    const p = pause(
      entity({
        status: 'rejected',
        decidedAt: new Date('2026-10-10T10:00:00Z'),
        documentStatus: 'rejected',
      }),
    );
    expect(p?.stage).toBe('rejected');
    expect(p?.message).toContain('Publishing is paused');
    expect(p?.message).toContain('We could not verify your ID document.');
    expect(p?.message).toContain('Upload a clear photo of an ID');
  });

  it('a refusal that names nothing we can read still gives the general reason', () => {
    const p = pause(
      entity({
        status: 'rejected',
        decidedAt: new Date('2026-10-10T10:00:00Z'),
      }),
    );
    expect(p?.stage).toBe('rejected');
    expect(p?.message).toContain('We could not verify your details.');
  });

  it('a refusal after which corrected details were sent reads as documents needed again', () => {
    const p = pause(
      entity({
        status: 'rejected',
        decidedAt: new Date('2026-10-10T10:00:00Z'),
        correctedAt: new Date('2026-10-11T10:00:00Z'),
      }),
    );
    expect(p?.stage).toBe('needs_documents');
  });

  it.each(['failed', 'suspended'])(
    'a review the provider ended (%s) is paused as stopped',
    (status) => {
      const p = pause(entity({ status }), { state: 'stopped', failure: null });
      expect(p?.stage).toBe('stopped');
      expect(p?.message).toContain('We could not open your wallet.');
      expect(p?.message).toContain('Contact support');
    },
  );

  it('an opening stopped because its BVN is now another account’s is paused as stopped, whatever the review says', () => {
    const p = pause(entity({ status: 'approved' }), {
      state: 'stopped',
      failure: CLAIM_LOST,
    });
    expect(p?.stage).toBe('stopped');
  });

  it('an opening closed because it was left unfinished is paused as expired, and says how to start again', () => {
    const p = pause(entity({ status: 'incomplete' }), {
      state: 'expired',
      failure: 'hold_expired',
    });
    expect(p?.stage).toBe('expired');
    expect(p?.message).toContain('Send your details again');
  });

  it.each(['pending', 'approved', 'something-new'])(
    'a check still under way (%s) is not paused',
    (status) => {
      expect(
        pause(entity({ status }), { state: 'open', failure: null }),
      ).toBeNull();
    },
  );

  it('a check that passed (a wallet is open) is not paused, whatever the review rows say', () => {
    expect(
      pause(entity({ status: 'rejected' }), null, { hasWallet: true }),
    ).toBeNull();
  });

  it('a check never started is not paused: no review was ever sent', () => {
    expect(pause(null, null)).toBeNull();
    expect(pause(entity({ entityId: null, status: 'incomplete' }))).toBeNull();
    // An opening row with no review (the older BVN check) says nothing either.
    expect(pause(null, { state: 'failed', failure: 'x' })).toBeNull();
  });

  it('under a provider that does not review the person itself nothing is ever paused', () => {
    expect(
      pause(entity({ status: 'incomplete' }), null, { reviews: false }),
    ).toBeNull();
  });

  it('no sentence has an em-dash or names a provider', () => {
    const rows: Array<[PauseEntity, PauseOpening | null]> = [
      [entity({ status: 'incomplete' }), null],
      [
        entity({
          status: 'rejected',
          bvnStatus: 'rejected',
          ninStatus: 'rejected',
        }),
        null,
      ],
      [entity({ status: 'suspended' }), null],
      [entity(), { state: 'expired', failure: null }],
    ];
    for (const [e, o] of rows) {
      const message = pause(e, o)?.message ?? '';
      expect(message).not.toMatch(/—|nuvion|fintava/i);
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe('IdentityPausedError', () => {
  it('is one 403 with the one code and the Hub’s sentence in the contract’s error shape', () => {
    const error = new IdentityPausedError({
      stage: 'rejected',
      message: 'Paused.',
    });
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.getResponse()).toEqual({
      message: 'Paused.',
      reason: {
        code: IDENTITY_PAUSED_CODE,
        message: 'Paused.',
        stage: 'rejected',
      },
    });
    expect(IDENTITY_PAUSED_CODE).toBe('identity_paused');
  });
});

describe('IdentityPauseService', () => {
  function over(
    rows: {
      wallet?: object | null;
      opening?: PauseOpening | null;
      entity?: PauseEntity | null;
    },
    reviews = true,
  ) {
    const reads: string[] = [];
    const prisma = {
      fintavaWallet: {
        findUnique: () => {
          reads.push('wallet');
          return Promise.resolve(rows.wallet ?? null);
        },
      },
      fintavaWalletOpening: {
        findUnique: () => {
          reads.push('opening');
          return Promise.resolve(rows.opening ?? null);
        },
      },
      nuvionEntity: {
        findUnique: () => {
          reads.push('entity');
          return Promise.resolve(rows.entity ?? null);
        },
      },
    } as unknown as PrismaService;
    const provider = {
      capabilities: { separateKyc: reviews },
    } as unknown as WalletProvider;
    return { service: new IdentityPauseService(prisma, provider), reads };
  }

  it('reads nothing under a provider that does not review the person', async () => {
    const { service, reads } = over(
      { entity: entity({ status: 'incomplete' }) },
      false,
    );
    await expect(service.of('p1')).resolves.toBeNull();
    expect(reads).toEqual([]);
  });

  it('a person with a wallet is read with one lookup and is not paused', async () => {
    const { service, reads } = over({ wallet: { wawuUserId: 'p1' } });
    await expect(service.of('p1')).resolves.toBeNull();
    expect(reads).toEqual(['wallet']);
  });

  it('a person with no wallet and a refused review is paused', async () => {
    const { service } = over({
      opening: { state: 'review', failure: null },
      entity: entity({
        status: 'rejected',
        decidedAt: new Date(),
        bvnStatus: 'rejected',
      }),
    });
    const found = await service.of('p1');
    expect(found?.stage).toBe('rejected');
    expect(found?.message).toContain('We could not confirm your BVN.');
  });

  it('a person who never started is not paused', async () => {
    const { service } = over({});
    await expect(service.of('p1')).resolves.toBeNull();
  });
});
