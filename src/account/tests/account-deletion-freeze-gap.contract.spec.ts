import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import type { WalletProvider } from '../../wallet-provider/wallet-provider.interface';
import { AccountModule } from '../account.module';
import { AccountService } from '../account.service';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../wawu-id-account.gateway';

/**
 * SWEEP-MONEY-6 (FX-A deletion, the freeze gap): a foreign account cannot be frozen, so a deletion request reads the foreign accounts
 * once more after it has taken its claim. Money that lands between the first look and the claim blocks the deletion; it is no longer
 * scheduled with money in a foreign account.
 */
describe('a deletion request and money landing in a foreign account between the check and the claim', () => {
  jest.setTimeout(60_000);
  const people: string[] = [];
  /** What the provider says each read of the account holds, in order; the last one repeats. */
  const reads = new Map<string, bigint[]>();
  const asked: string[] = [];
  const provider = {
    name: 'nuvion',
    label: 'Nuvion',
    configured: true,
    timings: { retryAfterSeconds: 3 },
    getBalance: () => Promise.resolve({ availableKobo: 0n, bookedKobo: 0n }),
    fx: {
      readAccount: (_person: unknown, id: string) => {
        asked.push(id);
        const seq = reads.get(id) ?? [0n];
        const held = seq.length > 1 ? seq.shift()! : seq[0];
        return Promise.resolve({
          accountId: id,
          currency: 'USD',
          ban: null,
          availableMinor: held,
          bookedMinor: held,
        });
      },
    },
  } as unknown as WalletProvider;
  const gateway = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  let app: INestApplication;
  let prisma: PrismaService;
  let accounts: AccountService;

  async function person(sequence: bigint[]) {
    const id = randomUUID();
    people.push(id);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: `c-${id}`,
        walletId: `nw-${id}`,
        accountNumber: `8${Math.floor(Math.random() * 1e9)
          .toString()
          .padStart(9, '0')}`,
        provider: 'nuvion',
      },
    });
    const providerAccountId = `acct-${randomUUID()}`;
    await prisma.fxAccount.create({
      data: {
        wawuUserId: id,
        currency: 'USD',
        providerCustomerId: 'cust-x',
        providerAccountId,
        status: 'open',
      },
    });
    reads.set(providerAccountId, [...sequence]);
    return { id, providerAccountId };
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AccountModule,
      ],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .overrideProvider(WALLET_PROVIDER)
      .useValue(provider)
      .compile();
    app = m.createNestApplication();
    await app.init();
    prisma = m.get(PrismaService);
    accounts = m.get(AccountService);
  });

  afterAll(async () => {
    await prisma.accountDeletionContent.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.accountDeletion.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.pushStoppedAccount.deleteMany({
      where: { userWawuId: { in: people } },
    });
    await prisma.fxAccount.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await app.close();
  });

  beforeEach(() => {
    asked.length = 0;
    gateway.scheduleAccountDeletion.mockClear();
  });

  it('money that lands after the first look is seen when the claim is taken: 409 fx_balance and nothing scheduled', async () => {
    const p = await person([0n, 7_500n]);
    await expect(accounts.deleteAccount(p.id)).rejects.toMatchObject({
      status: 409,
      response: {
        reason: { code: 'account_deletion_blocked', blockers: ['fx_balance'] },
      },
    });
    const row = await prisma.accountDeletion.findUnique({
      where: { wawuUserId: p.id },
    });
    expect(row?.status ?? null).not.toBe('scheduled');
    expect(gateway.scheduleAccountDeletion).not.toHaveBeenCalled();
    // The account was read twice: before the claim and inside it.
    expect(asked.filter((a) => a === p.providerAccountId)).toHaveLength(2);
  });

  it('an account that stays empty is scheduled as before', async () => {
    const p = await person([0n]);
    expect(await accounts.deleteAccount(p.id)).toHaveProperty(
      'deletionScheduledAt',
    );
    expect(
      (
        await prisma.accountDeletion.findUnique({
          where: { wawuUserId: p.id },
        })
      )?.status,
    ).toBe('scheduled');
    expect(await accounts.cancelDeletion(p.id)).toMatchObject({
      cancelled: true,
    });
  });
});
