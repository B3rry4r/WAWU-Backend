/* eslint-disable */
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { AccountModule } from '../account.module';
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import { AccountService } from '../account.service';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../wawu-id-account.gateway';

describe('SETTINGS-06 verifier: provider without freeze (Nuvion shape)', () => {
  jest.setTimeout(60000);
  const state = { balance: 0n, fail: false };
  const provider: any = {
    name: 'nuvion',
    label: 'Nuvion',
    timings: { retryAfterSeconds: 3 },
    getBalance: jest.fn(async () => {
      if (state.fail)
        throw new WalletProviderError({ kind: 'unreachable' as any, provider: 'nuvion', operation: 'getBalance' });
      return { availableKobo: state.balance, bookedKobo: state.balance };
    }),
  };
  const gateway = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  const people: string[] = [];
  let app: INestApplication;
  let prisma: PrismaService;
  let accounts: AccountService;
  let sweep: AccountDeletionSweepService;
  async function person(rowProvider = 'nuvion') {
    const id = randomUUID();
    people.push(id);
    await prisma.fintavaWallet.create({
      data: { wawuUserId: id, customerId: `c-${id}`, walletId: `nw-${id}`, accountNumber: `8${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`, provider: rowProvider } as any,
    });
    return id;
  }
  const st = (e: any) => e?.getStatus?.() ?? -1;
  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, AccountModule] })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY).useValue(gateway)
      .overrideProvider(WALLET_PROVIDER).useValue(provider)
      .compile();
    app = m.createNestApplication();
    await app.init();
    prisma = m.get(PrismaService);
    accounts = m.get(AccountService);
    sweep = m.get(AccountDeletionSweepService);
  });
  afterAll(async () => {
    await prisma.accountDeletionContent.deleteMany({ where: { wawuUserId: { in: people } } });
    await prisma.accountDeletion.deleteMany({ where: { wawuUserId: { in: people } } });
    await prisma.pushStoppedAccount.deleteMany({ where: { userWawuId: { in: people } } });
    await prisma.fintavaWallet.deleteMany({ where: { wawuUserId: { in: people } } });
    await app.close();
  });
  beforeEach(() => { state.balance = 0n; state.fail = false; gateway.scheduleAccountDeletion.mockReset().mockResolvedValue({ scheduled: true }); });

  it('N1 empty nuvion wallet: scheduled, nothing frozen, cancel answers walletUnfrozen false', async () => {
    const id = await person();
    expect(await accounts.deleteAccount(id)).toHaveProperty('deletionScheduledAt');
    const r = await prisma.accountDeletion.findUnique({ where: { wawuUserId: id } });
    expect(r).toMatchObject({ status: 'scheduled', walletFrozenAt: null });
    expect(await accounts.cancelDeletion(id)).toMatchObject({ cancelled: true, walletUnfrozen: false });
  });
  it('N2 provider fails at the check: 503 and no row; money: 409', async () => {
    const id = await person();
    state.fail = true;
    await expect(accounts.deleteAccount(id)).rejects.toMatchObject({ status: 503 });
    expect(await prisma.accountDeletion.findUnique({ where: { wawuUserId: id } })).toBeNull();
    state.fail = false; state.balance = 500n;
    await expect(accounts.deleteAccount(id)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.accountDeletion.findUnique({ where: { wawuUserId: id } })).toBeNull();
  });
  it('N3 sweep with the provider down keeps the account; cancel still restores; money later blocks, then clears', async () => {
    const id = await person();
    await accounts.deleteAccount(id);
    await prisma.accountDeletion.update({ where: { wawuUserId: id }, data: { purgeAfter: new Date(Date.now() - 1000), scheduledAt: new Date(Date.now() - 31 * 86400000) } });
    state.fail = true;
    await sweep.runOnce(new Date(), 100);
    expect(await prisma.accountDeletion.findUnique({ where: { wawuUserId: id } })).toMatchObject({ status: 'scheduled', purgeBlockedBy: 'provider_unreachable' });
    state.fail = false; state.balance = 7000n;
    await sweep.runOnce(new Date(), 100);
    expect(await prisma.accountDeletion.findUnique({ where: { wawuUserId: id } })).toMatchObject({ status: 'scheduled', purgeBlockedBy: expect.stringContaining('wallet_balance') });
    state.balance = 0n;
    await sweep.runOnce(new Date(), 100);
    expect((await prisma.accountDeletion.findUnique({ where: { wawuUserId: id } }))!.status).toBe('purged');
    expect(gateway.finalizeAccountDeletion.mock.calls.filter((c: any) => c[0] === id).length).toBe(1);
  });
  it('N4 a Fintava-owned wallet row under a Nuvion server (after a rollback): 503, nothing recorded or frozen', async () => {
    const id = await person('fintava');
    await expect(accounts.deleteAccount(id)).rejects.toMatchObject({ status: 503 });
    expect(await prisma.accountDeletion.findUnique({ where: { wawuUserId: id } })).toBeNull();
  });
  it('N5 WAWU ID stand-in refuses the schedule: DELETE still answers; cancel and sweep do not depend on it', async () => {
    const id = await person();
    gateway.scheduleAccountDeletion.mockRejectedValue(new Error('id down'));
    expect(await accounts.deleteAccount(id)).toHaveProperty('deletionScheduledAt');
    expect((await accounts.cancelDeletion(id)).cancelled).toBe(true);
  });
  it('N6 stale freezing rows under a Nuvion server: a Fintava-owned row is left alone (no provider call), a Nuvion row is dropped', async () => {
    const mk = async (walletProvider: string | null, withWallet = true) => {
      const id = await person(walletProvider ?? 'fintava');
      await prisma.accountDeletion.create({ data: { wawuUserId: id, status: 'freezing', scheduledAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86400000), walletId: withWallet ? `nw-${id}` : null, walletProvider } });
      await prisma.$executeRawUnsafe(`UPDATE "AccountDeletion" SET "updatedAt" = now() - interval '30 minutes' WHERE "wawuUserId" = '${id}'`);
      return id;
    };
    const foreign = await mk('fintava');
    const legacy = await mk(null);
    const own = await mk('nuvion');
    const r = await sweep.runOnce(new Date(), 100);
    const left = async (id: string) => (await prisma.accountDeletion.findUnique({ where: { wawuUserId: id } }))?.status ?? null;
    console.log('N6', JSON.stringify(r), 'foreign', await left(foreign), 'legacy(null=fintava)', await left(legacy), 'own', await left(own));
    expect(await left(foreign)).toBe('freezing');
    expect(await left(legacy)).toBe('freezing');
    expect(await left(own)).toBe('cancelled'); // round 7 (R6-1): closed, never deleted
  });
});
