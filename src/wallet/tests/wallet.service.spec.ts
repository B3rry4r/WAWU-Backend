import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletService, MIN_WITHDRAWAL_NGN } from '../wallet.service';

/**
 * THE RULES THAT KEEP MONEY WHERE IT BELONGS.
 *
 * Every case here is one that costs somebody real naira if it regresses:
 * paying an earning twice, withdrawing more than is there, sending to an
 * account nobody checked, or marking a movement settled that never happened.
 */
describe('wallet', () => {
  const WALLET = {
    wawuUserId: 'u1',
    accountReference: 'PSA123',
    barterId: '2340001',
    nuban: '9012345678',
    bankName: 'Flutterwave MFB',
    bankCode: '090567',
    status: 'active',
    createdAt: new Date(),
  };

  function build(opts: {
    wallet?: typeof WALLET | null;
    balance?: number;
    entries?: Record<string, unknown>;
    fundThrows?: Error;
    kyc?: string;
    withdrawThrows?: (Error & { status?: number }) | undefined;
  } = {}) {
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const byReference = new Map<string, Record<string, unknown>>(
      Object.entries(opts.entries ?? {}) as [string, Record<string, unknown>][],
    );

    const prisma = {
      creatorWallet: {
        findUnique: jest.fn().mockResolvedValue(
          opts.wallet === undefined ? WALLET : opts.wallet,
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
      walletLedgerEntry: {
        findUnique: jest.fn(async ({ where }: { where: { reference: string } }) =>
          byReference.get(where.reference) ?? null,
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `e${created.length + 1}`, status: 'pending', ...data };
          created.push(row);
          byReference.set(String(data.reference), row);
          return row;
        }),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updated.push(data);
          return { ...data };
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      creatorState: {
        findUnique: jest.fn().mockResolvedValue(
          opts.kyc === undefined ? { kycStatus: 'approved' } : { kycStatus: opts.kyc },
        ),
      },
      walletWithdrawal: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
    };

    const flw = {
      createWallet: jest.fn().mockResolvedValue({
        accountReference: 'PSA_NEW', barterId: 'b1', nuban: '9', bankName: 'Flutterwave MFB',
        bankCode: '090567', status: 'ACTIVE',
      }),
      balance: jest.fn().mockResolvedValue({ availableNgn: opts.balance ?? 100000 }),
      fundWallet: opts.fundThrows
        ? jest.fn().mockRejectedValue(opts.fundThrows)
        : jest.fn().mockResolvedValue({ transferId: 't1', status: 'NEW' }),
      withdraw: opts.withdrawThrows
        ? jest.fn().mockRejectedValue(opts.withdrawThrows)
        : jest.fn().mockResolvedValue({ transferId: 't2', status: 'NEW' }),
      resolveAccount: jest.fn().mockResolvedValue({
        accountNumber: '0690000040', accountName: 'ADA OKEKE',
      }),
      banks: jest.fn().mockResolvedValue([{ code: '044', name: 'Access Bank' }]),
    };

    return { service: new WalletService(prisma as never, flw as never), prisma, flw, created, updated };
  }

  // ── paying a creator ────────────────────────────────────────────────────
  describe('crediting an earning', () => {
    it('pays it once, and never twice for the same sale', async () => {
      const { service, flw } = build({
        entries: { 'sale-9': { id: 'existing', reference: 'sale-9', amount: 5000 } },
      });
      const entry = await service.creditEarning({
        wawuUserId: 'u1', amount: 5000, reference: 'sale-9',
        sourceType: 'purchase', sourceId: 'p9',
      });
      expect(entry).toMatchObject({ id: 'existing' });
      // The whole point: a replayed sale must not reach Flutterwave again.
      expect(flw.fundWallet).not.toHaveBeenCalled();
    });

    it('records the entry BEFORE asking Flutterwave to move anything', async () => {
      const { service, prisma, flw } = build();
      await service.creditEarning({
        wawuUserId: 'u1', amount: 5000, reference: 'sale-1',
        sourceType: 'purchase', sourceId: 'p1',
      });
      const wrote = prisma.walletLedgerEntry.create.mock.invocationCallOrder[0];
      const moved = flw.fundWallet.mock.invocationCallOrder[0];
      // Dying between the two must leave a reconcilable pending row, not
      // money that moved with nothing recording it.
      expect(wrote).toBeLessThan(moved);
    });

    it('leaves the entry PENDING when Flutterwave could not be reached', async () => {
      const { service, updated } = build({ fundThrows: new Error('socket hang up') });
      await service.creditEarning({
        wawuUserId: 'u1', amount: 5000, reference: 'sale-2',
        sourceType: 'purchase', sourceId: 'p2',
      });
      // Marking it failed would invite a second payment for the same sale;
      // the request may well have landed.
      expect(updated.some((u) => u.status === 'failed')).toBe(false);
    });

    it('refuses a zero or negative earning', async () => {
      const { service } = build();
      await expect(
        service.creditEarning({ wawuUserId: 'u1', amount: 0, reference: 'r', sourceType: 'x', sourceId: 'y' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to pay a creator with no wallet', async () => {
      const { service } = build({ wallet: null });
      await expect(
        service.creditEarning({ wawuUserId: 'u1', amount: 100, reference: 'r2', sourceType: 'x', sourceId: 'y' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── taking money out ────────────────────────────────────────────────────
  describe('withdrawing', () => {
    it('refuses more than Flutterwave says is available', async () => {
      const { service } = build({ balance: 4000 });
      await expect(
        service.withdraw({ wawuUserId: 'u1', amount: 5000, bankCode: '044', accountNumber: '0690000040' }),
      ).rejects.toThrow(/4,000/);
    });

    it('checks the balance with Flutterwave rather than a figure we summed', async () => {
      const { service, flw } = build({ balance: 50000 });
      await service.withdraw({ wawuUserId: 'u1', amount: 5000, bankCode: '044', accountNumber: '0690000040' });
      expect(flw.balance).toHaveBeenCalledWith('PSA123');
    });

    it('resolves the account name before sending, and stores it', async () => {
      const { service, prisma, flw } = build();
      const out = await service.withdraw({
        wawuUserId: 'u1', amount: 5000, bankCode: '044', accountNumber: '0690000040',
      });
      expect(flw.resolveAccount).toHaveBeenCalledWith('044', '0690000040');
      expect(out.accountName).toBe('ADA OKEKE');
      // A mistyped digit otherwise pays a stranger with nothing recording
      // that it was not what they meant.
      expect(prisma.walletWithdrawal.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ accountName: 'ADA OKEKE' }) }),
      );
    });

    it('debits the creator wallet, not WAWU', async () => {
      const { service, flw } = build();
      await service.withdraw({ wawuUserId: 'u1', amount: 5000, bankCode: '044', accountNumber: '0690000040' });
      // Without debit_subaccount the money comes out of WAWU's own balance.
      expect(flw.withdraw).toHaveBeenCalledWith(
        expect.objectContaining({ accountReference: 'PSA123' }),
      );
    });

    it('refuses an amount below the floor', async () => {
      const { service } = build();
      await expect(
        service.withdraw({ wawuUserId: 'u1', amount: MIN_WITHDRAWAL_NGN - 1, bankCode: '044', accountNumber: '0690000040' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks a REFUSED transfer failed, since no money moved', async () => {
      const refused = Object.assign(new Error('Insufficient funds'), { status: 400 });
      const { service, updated } = build({ withdrawThrows: refused });
      await expect(
        service.withdraw({ wawuUserId: 'u1', amount: 5000, bankCode: '044', accountNumber: '0690000040' }),
      ).rejects.toThrow();
      expect(updated.some((u) => u.status === 'failed')).toBe(true);
    });

    it('leaves an UNREACHABLE Flutterwave pending, not failed', async () => {
      const down = Object.assign(new Error('gateway timeout'), { status: 503 });
      const { service, updated } = build({ withdrawThrows: down });
      await expect(
        service.withdraw({ wawuUserId: 'u1', amount: 5000, bankCode: '044', accountNumber: '0690000040' }),
      ).rejects.toThrow();
      // "We could not ask" is not "it did not happen".
      expect(updated.some((u) => u.status === 'failed')).toBe(false);
    });
  });

  // ── settling from the webhook ───────────────────────────────────────────
  describe('settling', () => {
    it('only settles a movement that is still pending', async () => {
      const { service, prisma } = build();
      await service.settleFromWebhook({ reference: 'wawu-wd-1', succeeded: true });
      // Flutterwave delivers webhooks more than once; the status guard is what
      // stops a redelivery settling twice or reviving a failed transfer.
      expect(prisma.walletLedgerEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { reference: 'wawu-wd-1', status: 'pending' },
        }),
      );
    });

    it('reports settling nothing when the entry was already settled', async () => {
      const { service, prisma } = build();
      prisma.walletLedgerEntry.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.settleFromWebhook({ reference: 'gone', succeeded: true }),
      ).resolves.toEqual({ settled: false });
    });
  });

  // ── the KYC gate on opening one ─────────────────────────────────────────
  describe('opening on first ask', () => {
    const CLAIMS = {
      sub: 'u1', firstName: 'Ada', lastName: 'Okeke',
      email: 'ada@example.com', phone: '+2348000000000', country: 'NG',
    };

    it('refuses until the identity check is approved, and says which gate', async () => {
      const { service, flw } = build({ wallet: null, kyc: 'pending' });
      await expect(service.getWallet(CLAIMS)).rejects.toThrow(/identity check/i);
      // A wallet is a bank account; opening one for an unverified person is
      // the thing KYC exists to prevent.
      expect(flw.createWallet).not.toHaveBeenCalled();
    });

    it('opens it in the creator\'s verified name once KYC is approved', async () => {
      const { service, flw } = build({ wallet: null, kyc: 'approved' });
      await service.getWallet(CLAIMS);
      expect(flw.createWallet).toHaveBeenCalledWith(
        expect.objectContaining({ accountName: 'Ada Okeke', country: 'NG' }),
      );
    });

    it('does not re-open a wallet that already exists', async () => {
      const { service, flw } = build();
      await service.getWallet(CLAIMS);
      expect(flw.createWallet).not.toHaveBeenCalled();
    });
  });

  // ── opening one ─────────────────────────────────────────────────────────
  describe('opening a wallet', () => {
    it('returns the existing wallet rather than opening a second', async () => {
      const { service, flw } = build();
      const w = await service.ensureWallet({
        wawuUserId: 'u1', accountName: 'Ada', email: 'a@b.co', country: 'NG',
      });
      expect(w).toMatchObject({ accountReference: 'PSA123' });
      expect(flw.createWallet).not.toHaveBeenCalled();
    });

    it('opens one when there is none', async () => {
      const { service, flw } = build({ wallet: null });
      await service.ensureWallet({
        wawuUserId: 'u2', accountName: 'Ada', email: 'a@b.co', country: 'NG',
      });
      expect(flw.createWallet).toHaveBeenCalled();
    });
  });
});
