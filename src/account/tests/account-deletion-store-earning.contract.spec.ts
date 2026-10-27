import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { AccountDeletionMoneyService } from '../account-deletion-money.service';

/**
 * STORE-BUY-HUB: a creator who is owed their 85% of a store sale cannot delete
 * the account (R-11), exactly as for a sale's share or a host's share of
 * credits. A store earning lives in `StoreEarning`, which `waiting_earnings`
 * did not count; after a purge the money would have stayed with WAWU with no
 * one to pay it to.
 *
 * The people here have no wallet, so the provider is never asked anything: a
 * stand-in that fails on any call proves it.
 */
describe('Deleting an account while a store earning is owed (STORE-BUY-HUB)', () => {
  const people: string[] = [];
  let prisma: PrismaService;
  let money: AccountDeletionMoneyService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const provider = {
      name: 'nuvion',
      label: 'Nuvion',
      getBalance: () => {
        throw new Error(
          'the provider must not be asked about a person with no wallet',
        );
      },
    } as unknown as WalletProvider;
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
      providers: [
        AccountDeletionMoneyService,
        { provide: WALLET_PROVIDER, useValue: provider },
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    money = moduleRef.get(AccountDeletionMoneyService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await prisma.storeEarning.deleteMany({
      where: { payeeWawuUserId: { in: people } },
    });
    await close();
  });

  const person = () => {
    const id = randomUUID();
    people.push(id);
    return id;
  };

  function earning(
    payee: string,
    status: 'owed' | 'paid' | 'cancelled',
    role: 'sale' | 'restore' = 'sale',
  ) {
    const sold = new Date('2026-10-22T12:00:00Z');
    return prisma.storeEarning.create({
      data: {
        storePurchaseId: randomUUID(),
        role,
        payeeWawuUserId: payee,
        kind: 'content_unlock',
        targetId: randomUUID(),
        title: 'FIXTURE: account-deletion-store-earning.contract.spec.ts',
        earnedAt: sold,
        listPriceKobo: 100_000n,
        amountKobo: 85_000n,
        availableAt: new Date('2026-10-27T12:00:00Z'),
        provider: 'nuvion',
        status,
        ...(status === 'paid' ? { paidAt: new Date() } : {}),
        ...(status === 'cancelled' ? { cancelledAt: new Date() } : {}),
      },
    });
  }

  it('an owed store earning blocks the deletion with waiting_earnings, and counts', async () => {
    const creator = person();
    await earning(creator, 'owed');
    const check = await money.check(creator);
    expect(check.blockers).toContain('waiting_earnings');
    expect(check.waitingEarnings).toBe(1);
  });

  it('counts each owed earning, a restore among them, and adds to the others', async () => {
    const creator = person();
    await earning(creator, 'owed');
    await earning(creator, 'owed', 'restore');
    const check = await money.check(creator);
    expect(check.waitingEarnings).toBe(2);
  });

  it("a paid one, a cancelled one, and nobody else's, do not block", async () => {
    const creator = person();
    await earning(creator, 'paid');
    await earning(creator, 'cancelled');
    await earning(person(), 'owed');
    const check = await money.check(creator);
    expect(check.blockers).not.toContain('waiting_earnings');
    expect(check.waitingEarnings).toBe(0);
  });
});
