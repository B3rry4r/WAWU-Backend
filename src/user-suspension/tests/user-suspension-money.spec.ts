/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method -- hand-made fakes of the database and the bank */
// USER-SUSPEND round 2, H1 (R-121 tightened by the lead): while a person is suspended, money may leave them only to a bank
// account in their OWN verified name. Every other bank send, a beneficiary that is not their own account, a payout
// account that is not theirs and the legacy /wallet/withdraw to a stranger are 403 `account_suspended`, before the PIN is
// looked at and before any money or ledger row is touched. Everybody who is not suspended is answered exactly as before.
//
// The rule is `PayoutAccountService.notYourNameRefusal` (BVN name, else the wallet's name), the same check a payout
// account has always needed (WALLET-37, R-51). These specs fake the database and the bank so each branch is exact; the
// stack run in tasks/USER-SUSPEND.md drives the real routes.

import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { MoneyError } from '../../money/money-error';
import { PayoutAccountService } from '../../money/saved-accounts/payout-account.service';
import { BeneficiaryService } from '../../money/saved-accounts/beneficiary.service';
import { BANK_TARGET_KEY } from '../../money/transfers/bank-send-target';
import { PayoutOwnNameGuard } from '../../money/transfers/payout-own-name.guard';
import { FlutterwaveWalletMock } from '../../wallet/flutterwave-wallet.mock';
import { WalletService } from '../../wallet/wallet.service';
import {
  SUSPENDED_MESSAGE,
  isSuspended,
} from '../../common/suspension/user-suspension';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OWN_ACCOUNT = { accountName: 'ADA OKEKE', bankName: 'Access Bank' };
const STRANGER = { accountName: 'JOHN DOE', bankName: 'Access Bank' };

const notYours = (a: { accountName: string; bankName: string }) =>
  new MoneyError(
    'account_not_in_your_name',
    `This account is in the name ${a.accountName}, which is not your name.`,
  );

/** A payout service that knows one verified name: ADA OKEKE. */
function payoutFake() {
  return {
    notYourNameRefusal: jest.fn(
      (_who: string, a: { accountName: string; bankName: string }) =>
        Promise.resolve(a.accountName === 'ADA OKEKE' ? null : notYours(a)),
    ),
  };
}

function suspendedPrisma(suspended: boolean) {
  return {
    userSuspension: {
      findFirst: jest.fn(() =>
        Promise.resolve(suspended ? { id: 's1' } : null),
      ),
    },
    moneyPayoutAccount: {
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
  };
}

function isSuspendedRefusal(e: unknown): boolean {
  if (!(e instanceof ForbiddenException)) return false;
  const body = e.getResponse() as {
    message: string;
    reason: { code: string; supportEmail: string };
  };
  return (
    e.getStatus() === 403 &&
    body.reason.code === 'account_suspended' &&
    body.message === SUSPENDED_MESSAGE &&
    body.reason.supportEmail === 'support@wawuafrica.com'
  );
}

async function expectSuspended(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(isSuspendedRefusal(caught)).toBe(true);
}

describe('USER-SUSPEND H1: a bank send by a suspended person (PayoutOwnNameGuard)', () => {
  const build = (
    suspended: boolean,
    holder: { accountName: string; bankName: string },
  ) => {
    const prisma = suspendedPrisma(suspended);
    const payout = payoutFake();
    const guard = new PayoutOwnNameGuard(prisma as never, payout as never);
    const req: Record<string, unknown> = {
      user: { sub: OWNER },
      body: { bankCode: '044', accountNumber: '0690000040' },
      headers: { 'x-transaction-pin': '1234', 'x-device-approval': 'tok' },
      rawHeaders: ['X-Transaction-Pin', '1234'],
      [BANK_TARGET_KEY]: {
        target: {
          ...holder,
          bankCode: '044',
          accountNumber: '0690000040',
          payee: null,
        },
        place: null,
      },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { guard, ctx, req, prisma, payout };
  };

  it("refuses a send to a stranger's account in the suspended words, and takes the PIN off the request so no try is spent", async () => {
    const { guard, ctx, req } = build(true, STRANGER);
    let caught: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      caught = e;
    }
    expect(isSuspendedRefusal(caught)).toBe(true);
    expect(
      (req.headers as Record<string, string>)['x-transaction-pin'],
    ).toBeUndefined();
    expect(req.rawHeaders).toEqual([]);
  });

  it('lets a send go to an account in their own name', async () => {
    const { guard, ctx, payout } = build(true, OWN_ACCOUNT);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(payout.notYourNameRefusal).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ accountName: 'ADA OKEKE' }),
    );
  });

  it('a person who is not suspended is not asked the name at all for an account that is not their payout account (byte-identical)', async () => {
    const { guard, ctx, payout } = build(false, STRANGER);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(payout.notYourNameRefusal).not.toHaveBeenCalled();
  });

  it('and for their payout account in another name it is still the 409 account_not_in_your_name it always was', async () => {
    const { guard, ctx, prisma } = build(false, STRANGER);
    prisma.moneyPayoutAccount.findFirst.mockResolvedValueOnce({
      wawuUserId: OWNER,
    } as never);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'account_not_in_your_name',
    });
  });
});

describe('USER-SUSPEND H1: saving a beneficiary while suspended (BeneficiaryService)', () => {
  const build = (suspended: boolean) => {
    const prisma = {
      ...suspendedPrisma(suspended),
      moneyBeneficiary: {
        findUnique: jest.fn(() => Promise.resolve(null)),
      },
    };
    const banks = {
      check: jest.fn(),
      checkedStamp: jest.fn(() => ({
        nuvionBankCode: null,
        nuvionCheckedAt: null,
      })),
    };
    const payout = payoutFake();
    const service = new BeneficiaryService(
      prisma as never,
      banks as never,
      {} as never,
      {} as never,
      payout as never,
    );
    // The two private steps after the rule (the room check and the insert) are replaced; the rule is what is tested.
    const priv = service as unknown as {
      insert: (...a: unknown[]) => Promise<unknown>;
      assertRoom: (...a: unknown[]) => Promise<void>;
    };
    const insert = jest.spyOn(priv, 'insert').mockResolvedValue({ id: 'b1' });
    jest.spyOn(priv, 'assertRoom').mockResolvedValue(undefined);
    return { service, banks, payout, insert, prisma };
  };
  const bank = (extra = {}) => ({
    kind: 'bank_account' as const,
    bankCode: '044',
    accountNumber: '0690000040',
    ...extra,
  });

  it("refuses a stranger's bank account, and saves nothing", async () => {
    const { service, banks, insert } = build(true);
    banks.check.mockResolvedValue({
      bankCode: '044',
      ...STRANGER,
      accountNumber: '0690000040',
    });
    await expectSuspended(service.add(OWNER, bank()));
    expect(insert).not.toHaveBeenCalled();
  });

  it('saves an account in their own name', async () => {
    const { service, banks, insert } = build(true);
    banks.check.mockResolvedValue({
      bankCode: '044',
      ...OWN_ACCOUNT,
      accountNumber: '0690000040',
    });
    await expect(service.add(OWNER, bank() as never)).resolves.toEqual({
      id: 'b1',
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('refuses saving another WAWU person (a suspended person sends to nobody else)', async () => {
    const { service, insert } = build(true);
    await expectSuspended(
      service.add(OWNER, {
        kind: 'wawu_user',
        wawuUserId: '22222222-2222-4222-8222-222222222222',
      } as never),
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('a person who is not suspended saves a stranger account exactly as before (no name rule)', async () => {
    const { service, banks, insert, payout } = build(false);
    banks.check.mockResolvedValue({
      bankCode: '044',
      ...STRANGER,
      accountNumber: '0690000040',
    });
    await expect(service.add(OWNER, bank() as never)).resolves.toEqual({
      id: 'b1',
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(payout.notYourNameRefusal).not.toHaveBeenCalled();
  });
});

describe('USER-SUSPEND H1: the payout account while suspended (PayoutAccountService.set)', () => {
  const build = (
    suspended: boolean,
    holder: { accountName: string; bankName: string },
  ) => {
    const prisma = {
      ...suspendedPrisma(suspended),
      moneyPayoutAccount: {
        findUnique: jest.fn(() => Promise.resolve(null)),
        upsert: jest.fn(() =>
          Promise.resolve({
            bankCode: '044',
            bankName: holder.bankName,
            accountNumber: '0690000040',
            accountName: holder.accountName,
            updatedAt: new Date(),
          }),
        ),
      },
      walletIdentity: { findUnique: jest.fn(() => Promise.resolve(null)) },
      fintavaWalletOpening: {
        findUnique: jest.fn(() => Promise.resolve(null)),
      },
      fintavaWallet: {
        findUnique: jest.fn(() =>
          Promise.resolve({ accountName: 'Ada Okeke' }),
        ),
      },
    };
    const banks = {
      check: jest.fn(() =>
        Promise.resolve({
          bankCode: '044',
          accountNumber: '0690000040',
          ...holder,
        }),
      ),
      checkedStamp: jest.fn(() => ({})),
    };
    const hasher = { configured: false, hash: jest.fn() };
    const service = new PayoutAccountService(
      prisma as never,
      banks as never,
      hasher as never,
    );
    return { service, prisma };
  };
  const dto = { bankCode: '044', accountNumber: '0690000040' };

  it("a stranger's account is refused as 403 account_suspended, and nothing is stored", async () => {
    const { service, prisma } = build(true, STRANGER);
    await expectSuspended(service.set(OWNER, dto));
    expect(prisma.moneyPayoutAccount.upsert).not.toHaveBeenCalled();
  });

  it('an account in their own name is saved', async () => {
    const { service, prisma } = build(true, OWN_ACCOUNT);
    await expect(service.set(OWNER, dto as never)).resolves.toEqual(
      expect.objectContaining({ accountName: 'ADA OKEKE' }),
    );
    expect(prisma.moneyPayoutAccount.upsert).toHaveBeenCalledTimes(1);
  });

  it('a person who is not suspended gets the 409 account_not_in_your_name they always got', async () => {
    const { service } = build(false, STRANGER);
    await expect(service.set(OWNER, dto as never)).rejects.toMatchObject({
      code: 'account_not_in_your_name',
    });
  });
});

describe('USER-SUSPEND H1: the legacy POST /wallet/withdraw (WalletService.withdraw)', () => {
  // The Flutterwave mock names every account ADA OKEKE, so a person called Ada Okeke is withdrawing to their own account
  // and anybody else is withdrawing to a stranger's.
  const build = () => {
    const gateway = new FlutterwaveWalletMock();
    const ledger: unknown[] = [];
    const prisma = {
      creatorWallet: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            wawuUserId: OWNER,
            accountReference: 'PSA1',
            barterId: 'b1',
          }),
        ),
      },
      creatorState: {
        findUnique: jest.fn(() => Promise.resolve({ kycStatus: 'approved' })),
      },
      walletLedgerEntry: {
        create: jest.fn((a: { data: unknown }) => {
          ledger.push(a.data);
          return Promise.resolve({ id: 'e1', ...(a.data as object) });
        }),
        update: jest.fn(() => Promise.resolve({})),
      },
      walletWithdrawal: { create: jest.fn(() => Promise.resolve({})) },
    };
    jest.spyOn(gateway, 'balance').mockResolvedValue({ availableNgn: 50000 });
    const withdrawSpy = jest.spyOn(gateway, 'withdraw');
    const service = new WalletService(prisma as never, gateway);
    return { service, prisma, withdrawSpy, ledger };
  };
  const input = {
    wawuUserId: OWNER,
    amount: 1000,
    bankCode: '044',
    accountNumber: '0690000040',
  };

  it("a suspended person's withdrawal to an account in another name is 403 account_suspended, before any ledger row or transfer", async () => {
    const { service, prisma, withdrawSpy } = build();
    await expectSuspended(
      service.withdraw({ ...input, ownNameOnly: 'John Doe' }),
    );
    expect(prisma.walletLedgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.walletWithdrawal.create).not.toHaveBeenCalled();
    expect(withdrawSpy).not.toHaveBeenCalled();
  });

  it('to an account in their own name it goes (a middle name left out either side is fine)', async () => {
    for (const name of ['Ada Okeke', 'Ada Chioma Okeke']) {
      const { service, withdrawSpy } = build();
      await expect(
        service.withdraw({ ...input, ownNameOnly: name }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'pending',
          accountName: 'ADA OKEKE',
        }),
      );
      expect(withdrawSpy).toHaveBeenCalledTimes(1);
    }
  });

  it('a person who is not suspended is never asked (no ownNameOnly): the same transfer to the same stranger as before', async () => {
    const { service, withdrawSpy } = build();
    await expect(service.withdraw(input)).resolves.toEqual(
      expect.objectContaining({ status: 'pending' }),
    );
    expect(withdrawSpy).toHaveBeenCalledTimes(1);
  });
});

describe('USER-SUSPEND H1: the helper everything reads', () => {
  it('isSuspended is false for nobody and for a person with no row in force', async () => {
    const prisma = suspendedPrisma(false);
    await expect(isSuspended(prisma as never, null)).resolves.toBe(false);
    await expect(isSuspended(prisma as never, OWNER)).resolves.toBe(false);
    await expect(
      isSuspended(suspendedPrisma(true) as never, OWNER),
    ).resolves.toBe(true);
  });
});
