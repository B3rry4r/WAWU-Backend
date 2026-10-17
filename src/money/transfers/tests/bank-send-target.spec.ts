import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import { MoneyError } from '../../money-error';
import {
  BankAccountCheckService,
  NAME_CHECK_ANSWERS,
} from '../../saved-accounts/bank-account-check.service';
import type {
  BankSendTarget,
  SavedAccountTargetService,
  SendTargetResult,
} from '../../saved-accounts/saved-account-target.service';
import { ACCOUNT_CHANGED_MESSAGE, BankSendTargets } from '../bank-send-target';

/**
 * Who a bank send may go to (WALLET-09; NUV-06's notes N3 and N5), with the
 * bank, the saved places and the database stood in, so every answer of
 * `SavedAccountTargetService` is met, including the ones only Nuvion gives.
 */

const NUMBER = '0123456789';
const ME = 'user-1';

const kept = (over: Partial<BankSendTarget> = {}): BankSendTarget => ({
  bankCode: '000013',
  bankName: 'Guaranty Trust Bank',
  accountNumber: NUMBER,
  accountName: 'SIMI MICHELLE',
  payee: { counterpartyId: 'cp_1', paymentDetailId: 'pd_1' },
  ...over,
});

function build(opts: {
  prepared?: SendTargetResult;
  live?: { bankName: string; accountName: string; bankCode?: string };
  beneficiary?: { id: string } | null;
  payout?: { bankCode: string } | null;
  ownWallet?: boolean;
  walletBankCode?: string;
  checkError?: MoneyError;
}) {
  const prisma = {
    fintavaWallet: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.ownWallet ? { wawuUserId: ME } : null),
    },
    moneyBeneficiary: {
      findFirst: jest.fn().mockResolvedValue(opts.beneficiary ?? null),
    },
    moneyPayoutAccount: {
      findFirst: jest.fn().mockResolvedValue(opts.payout ?? null),
    },
  };
  const check = jest.fn((bankCode: string, accountNumber: string) => {
    if (opts.checkError) return Promise.reject(opts.checkError);
    return Promise.resolve({
      bankCode: opts.live?.bankCode ?? bankCode,
      bankName: opts.live?.bankName ?? 'Guaranty Trust Bank',
      accountNumber,
      accountName: opts.live?.accountName ?? 'SIMI MICHELLE',
    });
  });
  const saved = {
    forBeneficiary: jest.fn().mockResolvedValue(opts.prepared),
    forPayoutAccount: jest.fn().mockResolvedValue(opts.prepared),
  };
  const provider = {
    name: 'nuvion',
    walletBankCode: opts.walletBankCode ?? '',
    timings: { retryAfterSeconds: 30 },
  };
  const targets = new BankSendTargets(
    prisma as unknown as PrismaService,
    provider as unknown as WalletProvider,
    { check } as unknown as BankAccountCheckService,
    saved as unknown as SavedAccountTargetService,
  );
  return { targets, prisma, check, saved };
}

async function refusal(p: Promise<unknown>): Promise<MoneyError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MoneyError);
    return e as MoneyError;
  }
  throw new Error('expected a refusal');
}
const reasonOf = (e: MoneyError) =>
  (e.getResponse() as { reason: Record<string, unknown> }).reason;

describe('BankSendTargets (WALLET-09)', () => {
  it('an account that is not saved is sent to as the bank just named it, with no payee', async () => {
    const { targets, check, saved } = build({
      live: {
        bankName: 'Guaranty Trust Bank',
        accountName: 'AS THE BANK SAYS',
      },
    });
    const r = await targets.resolve(ME, '000013', NUMBER);
    expect(r.place).toBeNull();
    expect(r.target).toEqual({
      bankCode: '000013',
      bankName: 'Guaranty Trust Bank',
      accountNumber: NUMBER,
      accountName: 'AS THE BANK SAYS',
      payee: null,
    });
    expect(check).toHaveBeenCalledWith('000013', NUMBER);
    expect(saved.forBeneficiary).not.toHaveBeenCalled();
  });

  it('a saved beneficiary that is ready is sent to under the code the provider knows the bank by, with its payee ids', async () => {
    const { targets, check, saved } = build({
      beneficiary: { id: 'ben-1' },
      prepared: { state: 'ready', target: kept({ bankCode: 'NUV-13' }) },
      live: { bankName: 'Guaranty Trust Bank', accountName: 'simi  michelle' },
    });
    const r = await targets.resolve(ME, '000013', NUMBER);
    expect(saved.forBeneficiary).toHaveBeenCalledWith(ME, 'ben-1');
    // The bank is asked under the provider's code, not the saved one.
    expect(check).toHaveBeenCalledWith('NUV-13', NUMBER);
    expect(r.place).toEqual({ kind: 'beneficiary', id: 'ben-1' });
    expect(r.target).toMatchObject({
      bankCode: 'NUV-13',
      payee: { counterpartyId: 'cp_1', paymentDetailId: 'pd_1' },
    });
  });

  it('the payout account is the place when no beneficiary is, and keeps the code it was saved under', async () => {
    const { targets, saved } = build({
      payout: { bankCode: '000013' },
      prepared: { state: 'ready', target: kept() },
    });
    const r = await targets.resolve(ME, '000013', NUMBER);
    expect(saved.forPayoutAccount).toHaveBeenCalledWith(ME, 'person');
    expect(r.place).toEqual({ kind: 'payout', bankCode: '000013' });
  });

  it('a holder that is not the one kept is account_name_changed with the names as they stand now, and nothing is resolved', async () => {
    const { targets } = build({
      beneficiary: { id: 'ben-1' },
      prepared: { state: 'ready', target: kept() },
      live: { bankName: 'Guaranty Trust Bank', accountName: 'SOMEONE ELSE' },
    });
    const e = await refusal(targets.resolve(ME, '000013', NUMBER));
    expect(e.getStatus()).toBe(409);
    expect(reasonOf(e)).toMatchObject({
      code: 'account_name_changed',
      message: ACCOUNT_CHANGED_MESSAGE,
      accountName: 'SOMEONE ELSE',
      bankName: 'Guaranty Trust Bank',
    });
  });

  it("N5: a code that is another bank in the provider's list is not ready, even when the holder matches", async () => {
    // Saved as Access Bank under 000014; the provider's list has 000014 as Zenith.
    const { targets } = build({
      beneficiary: { id: 'ben-1' },
      prepared: {
        state: 'ready',
        target: kept({ bankCode: '000014', bankName: 'Access Bank' }),
      },
      live: { bankName: 'Zenith Bank', accountName: 'SIMI MICHELLE' },
    });
    const e = await refusal(targets.resolve(ME, '000014', NUMBER));
    expect(reasonOf(e)).toMatchObject({
      code: 'account_name_changed',
      bankName: 'Zenith Bank',
    });
  });

  it('a company suffix or the case of a bank name is not a different bank', async () => {
    const { targets } = build({
      beneficiary: { id: 'ben-1' },
      prepared: {
        state: 'ready',
        target: kept({ bankName: 'ZENITH BANK PLC' }),
      },
      live: { bankName: 'Zenith Bank', accountName: 'SIMI MICHELLE' },
    });
    await expect(targets.resolve(ME, '000013', NUMBER)).resolves.toBeDefined();
  });

  it('name_changed from the saved-account gate is shown for confirmation, never sent to', async () => {
    const { targets } = build({
      beneficiary: { id: 'ben-1' },
      prepared: {
        state: 'name_changed',
        accountName: 'NEW HOLDER',
        target: kept({ accountName: 'NEW HOLDER' }),
      },
      live: { bankName: 'Guaranty Trust Bank', accountName: 'NEW HOLDER' },
    });
    const e = await refusal(targets.resolve(ME, '000013', NUMBER));
    expect(reasonOf(e)).toMatchObject({
      code: 'account_name_changed',
      accountName: 'NEW HOLDER',
    });
  });

  it('refused is its own plain 422, unavailable is 503, and a place that went missing is sent to as any account', async () => {
    const refused = build({
      beneficiary: { id: 'b' },
      prepared: { state: 'refused', reason: 'bank_not_supported' },
    });
    const e1 = await refusal(refused.targets.resolve(ME, '000013', NUMBER));
    expect(e1.getStatus()).toBe(422);
    expect(reasonOf(e1)).toMatchObject({
      code: 'name_check_failed',
      message: NAME_CHECK_ANSWERS.bank_not_supported,
    });
    expect(refused.check).not.toHaveBeenCalled();

    const unavailable = build({
      beneficiary: { id: 'b' },
      prepared: { state: 'unavailable' },
    });
    const e2 = await refusal(unavailable.targets.resolve(ME, '000013', NUMBER));
    expect(e2.getStatus()).toBe(503);
    expect(reasonOf(e2)).toMatchObject({
      code: 'provider_unreachable',
      retryAfterSeconds: 30,
    });

    const missing = build({
      beneficiary: { id: 'b' },
      prepared: { state: 'missing' },
    });
    const r = await missing.targets.resolve(ME, '000013', NUMBER);
    expect(r.place).toBeNull();
    expect(r.target.payee).toBeNull();
  });

  it('a name check that does not confirm the account is the refusal it gave, before any send', async () => {
    const { targets } = build({
      checkError: new MoneyError(
        'name_check_failed',
        'We could not confirm that account.',
      ),
    });
    const e = await refusal(targets.resolve(ME, '000013', NUMBER));
    expect(reasonOf(e).code).toBe('name_check_failed');
  });

  it("your own wallet at the provider's own bank is self_transfer; another bank's number is not", async () => {
    const own = build({ ownWallet: true, walletBankCode: '090620' });
    const e = await refusal(own.targets.resolve(ME, '090620', NUMBER));
    expect(reasonOf(e).code).toBe('self_transfer');
    expect(own.check).not.toHaveBeenCalled();

    const other = build({ ownWallet: true, walletBankCode: '090620' });
    await expect(
      other.targets.resolve(ME, '000013', NUMBER),
    ).resolves.toBeDefined();
    expect(other.prisma.fintavaWallet.findFirst).not.toHaveBeenCalled();
  });
});
