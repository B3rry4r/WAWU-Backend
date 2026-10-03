import type { ExecutionContext } from '@nestjs/common';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { MoneyError } from '../../money-error';
import {
  NO_WALLET_MESSAGE,
  WALLET_OPENING_MESSAGE,
  WalletGate,
  WalletGateGuard,
  walletStateOf,
} from '../wallet-gate';

/**
 * The wallet gate's rule and its guard, without a database (task MONEY-13).
 * The HTTP behaviour is in wallet-gate.contract.spec.ts.
 */

describe('walletStateOf: the one rule GET /money/wallet and the gate share', () => {
  const cases: Array<
    [boolean, { state: string; failure: string | null } | null, string]
  > = [
    [true, null, 'open'],
    // A wallet row wins whatever the opening row says.
    [true, { state: 'failed', failure: 'x' }, 'open'],
    [
      true,
      { state: 'conflict', failure: 'phone_held_by_other_identity' },
      'open',
    ],
    [false, null, 'not_open'],
    [false, { state: 'failed', failure: null }, 'not_open'],
    [false, { state: 'failed', failure: 'lookup_unavailable' }, 'not_open'],
    [
      false,
      { state: 'conflict', failure: 'phone_held_by_other_identity' },
      'not_open',
    ],
    [
      false,
      { state: 'conflict', failure: 'phone_holder_bvn_unreadable' },
      'not_open',
    ],
    [false, { state: 'opening', failure: null }, 'opening'],
    [false, { state: 'unknown', failure: 'timed out' }, 'opening'],
    [false, { state: 'conflict', failure: 'held_by_other_account' }, 'opening'],
    [false, { state: 'conflict', failure: null }, 'opening'],
    [false, { state: 'open', failure: null }, 'opening'],
    // A state this code does not know is not an account on its way.
    [false, { state: 'something_new', failure: null }, 'not_open'],
  ];
  for (const [hasWallet, opening, expected] of cases) {
    it(`wallet ${hasWallet}, opening ${JSON.stringify(opening)}: ${expected}`, () => {
      expect(walletStateOf(hasWallet, opening)).toBe(expected);
    });
  }
});

type Rows = {
  wallet: {
    customerId: string;
    walletId: string;
    accountNumber: string;
  } | null;
  opening: { state: string; failure: string | null } | null;
};

function fakePrisma(rows: Rows) {
  const calls = { wallet: 0, opening: 0 };
  const prisma = {
    fintavaWallet: {
      findUnique: jest.fn(() => {
        calls.wallet += 1;
        return Promise.resolve(rows.wallet);
      }),
    },
    fintavaWalletOpening: {
      findUnique: jest.fn(() => {
        calls.opening += 1;
        return Promise.resolve(rows.opening);
      }),
    },
  } as unknown as PrismaService;
  return { prisma, calls };
}

function requestWith(headers: Record<string, string>, sub?: string) {
  const rawHeaders = Object.entries(headers).flat();
  return {
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    rawHeaders,
    user: sub ? { sub } : undefined,
  } as Record<string, unknown> & {
    headers: Record<string, string>;
    rawHeaders: string[];
  };
}

function contextFor(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('WalletGate.requireOpen', () => {
  it('an open wallet: its ids, and the opening row is not read', async () => {
    const wallet = {
      customerId: 'c1',
      walletId: 'w1',
      accountNumber: '1100000001',
    };
    const { prisma, calls } = fakePrisma({ wallet, opening: null });
    await expect(new WalletGate(prisma).requireOpen('u1')).resolves.toEqual({
      wawuUserId: 'u1',
      ...wallet,
    });
    expect(calls).toEqual({ wallet: 1, opening: 0 });
  });

  it('no wallet: 409 wallet_not_open with the one sentence', async () => {
    const { prisma } = fakePrisma({ wallet: null, opening: null });
    const refusal = await new WalletGate(prisma)
      .requireOpen('u1')
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(MoneyError);
    expect((refusal as MoneyError).getStatus()).toBe(409);
    expect((refusal as MoneyError).getResponse()).toEqual({
      message: NO_WALLET_MESSAGE,
      reason: { code: 'wallet_not_open', message: NO_WALLET_MESSAGE },
    });
  });

  it('opening: 409 wallet_opening', async () => {
    const { prisma } = fakePrisma({
      wallet: null,
      opening: { state: 'unknown', failure: null },
    });
    const refusal = await new WalletGate(prisma)
      .requireOpen('u1')
      .catch((e: unknown) => e);
    expect((refusal as MoneyError).getStatus()).toBe(409);
    expect((refusal as MoneyError).getResponse()).toEqual({
      message: WALLET_OPENING_MESSAGE,
      reason: { code: 'wallet_opening', message: WALLET_OPENING_MESSAGE },
    });
  });

  it('the sentences are plain: no em-dash, no provider name', () => {
    for (const m of [NO_WALLET_MESSAGE, WALLET_OPENING_MESSAGE]) {
      expect(m).not.toContain('\u2014');
      expect(m).not.toMatch(/fintava|flutterwave|loma/i);
    }
  });
});

describe('WalletGateGuard', () => {
  it('on a refusal, drops X-Transaction-Pin unread from headers and rawHeaders', async () => {
    const { prisma } = fakePrisma({ wallet: null, opening: null });
    const req = requestWith(
      { 'X-Transaction-Pin': '4826', Accept: 'application/json' },
      'u1',
    );
    await expect(
      new WalletGateGuard(new WalletGate(prisma)).canActivate(contextFor(req)),
    ).rejects.toMatchObject({ code: 'wallet_not_open' });
    expect(req.headers['x-transaction-pin']).toBeUndefined();
    expect(req.rawHeaders).toEqual(['Accept', 'application/json']);
  });

  it('on a pass, leaves the PIN for the PIN guard and the wallet for the route', async () => {
    const wallet = {
      customerId: 'c1',
      walletId: 'w1',
      accountNumber: '1100000001',
    };
    const { prisma } = fakePrisma({ wallet, opening: null });
    const req = requestWith({ 'X-Transaction-Pin': '4826' }, 'u1');
    await expect(
      new WalletGateGuard(new WalletGate(prisma)).canActivate(contextFor(req)),
    ).resolves.toBe(true);
    expect(req.headers['x-transaction-pin']).toBe('4826');
    expect(req.wawuOpenWallet).toEqual({ wawuUserId: 'u1', ...wallet });
  });

  it('runs once per request: a second gate on the same route reads nothing', async () => {
    const wallet = {
      customerId: 'c1',
      walletId: 'w1',
      accountNumber: '1100000001',
    };
    const { prisma, calls } = fakePrisma({ wallet, opening: null });
    const guard = new WalletGateGuard(new WalletGate(prisma));
    const req = requestWith({}, 'u1');
    await guard.canActivate(contextFor(req));
    await guard.canActivate(contextFor(req));
    expect(calls.wallet).toBe(1);
  });

  it('fails loudly without a signed-in caller (WawuAuthGuard missing)', async () => {
    const { prisma, calls } = fakePrisma({ wallet: null, opening: null });
    await expect(
      new WalletGateGuard(new WalletGate(prisma)).canActivate(
        contextFor(requestWith({})),
      ),
    ).rejects.toThrow('WawuAuthGuard must run first');
    expect(calls.wallet).toBe(0);
  });
});
