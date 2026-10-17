import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  HOST_SHARE_KIND,
  hostShareReference,
} from '../../money/earnings/earning-rules';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  AccountDeletionBlockedError,
  AccountDeletionMoneyService,
} from '../account-deletion-money.service';

/**
 * WALLET-17 round 3: a creator who is owed a community host's share cannot
 * delete the account (R-11). `waiting_earnings` used to count sales only
 * (`WalletPayment`), so a host with owed shares and no sale got 200 and a
 * deletion date; after the purge the money stayed in WAWU's account with no
 * one to land it to.
 *
 * The people here have no wallet, so the provider is never asked anything: a
 * stand-in that fails on any call proves it. Nothing here touches a provider.
 */

describe('Deleting an account while a community host share is owed (WALLET-17)', () => {
  const people: string[] = [];
  const rooms: string[] = [];
  const payments: string[] = [];
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
    await prisma.earningSettlement.deleteMany({
      where: { payeeWawuUserId: { in: people } },
    });
    await prisma.walletPayment.deleteMany({ where: { id: { in: payments } } });
    await prisma.community.deleteMany({ where: { id: { in: rooms } } });
    await close();
  });

  const person = () => {
    const id = randomUUID();
    people.push(id);
    return id;
  };

  /** One spent-credit share the host is owed (or was paid), as the sweep makes it. */
  async function share(host: string, status: 'owed' | 'landed' = 'owed') {
    const room = await prisma.community.create({
      data: {
        name: 'Night shoots',
        description: 'FIXTURE: account-deletion-host-share.contract.spec.ts',
        hostWawuId: host,
        kind: 'open',
      },
    });
    rooms.push(room.id);
    const spend = await prisma.creditSpend.create({
      data: {
        userWawuId: randomUUID(),
        communityId: room.id,
        creatorWawuId: host,
        creditsSpent: 12,
      },
    });
    const earning = await prisma.creditSpendEarning.create({
      data: {
        creditSpendId: spend.id,
        creatorWawuId: host,
        communityId: room.id,
        creditsSpent: 12,
        creditsFunded: 12,
        grossKobo: 10_000,
        hostShareKobo: 8_500,
        platformShareKobo: 1_500,
        lotIds: [],
      },
    });
    return prisma.earningSettlement.create({
      data: {
        creditSpendEarningId: earning.id,
        payeeWawuUserId: host,
        kind: HOST_SHARE_KIND,
        targetId: room.id,
        title: 'Community credits',
        earnedAt: new Date(),
        amountKobo: 8_500n,
        merchantAccountNumber: '0000000000',
        provider: 'nuvion',
        customerReference: hostShareReference(earning.id, 1),
        status,
        ...(status === 'landed'
          ? {
              settledAt: new Date(),
              sentAt: new Date(),
              destinationAccountNumber: '0000000001',
            }
          : {}),
      },
    });
  }

  /** A completed sale whose share has not landed, with its earning made. */
  async function sale(payee: string) {
    const payment = await prisma.walletPayment.create({
      data: {
        payerWawuUserId: randomUUID(),
        payeeWawuUserId: payee,
        kind: 'tip',
        targetId: randomUUID(),
        title: 'FIXTURE: account-deletion-host-share.contract.spec.ts',
        priceKobo: 10_000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 10_000n,
        payeeShareKobo: 8_500n,
        wawuShareKobo: 1_500n,
        customerReference: `wawu-pay-test-${randomUUID()}`,
        merchantAccountNumber: '0000000000',
        provider: 'nuvion',
        status: 'completed',
        completedAt: new Date(),
      },
    });
    payments.push(payment.id);
    await prisma.earningSettlement.create({
      data: {
        paymentId: payment.id,
        payeeWawuUserId: payee,
        kind: 'tip',
        targetId: payment.targetId,
        title: payment.title,
        earnedAt: new Date(),
        amountKobo: 8_500n,
        merchantAccountNumber: '0000000000',
        provider: 'nuvion',
        customerReference: `wawu-earn-${payment.id}`,
      },
    });
  }

  it('a host with an owed share and no wallet is blocked: waiting_earnings, counted', async () => {
    const host = person();
    await share(host);
    await share(host);
    const check = await money.check(host);
    expect(check.blockers).toEqual(['waiting_earnings']);
    expect(check.waitingEarnings).toBe(2);
    expect(check.wallet).toBeNull();

    const refused = new AccountDeletionBlockedError(check);
    expect(refused.getStatus()).toBe(409);
    expect(JSON.stringify(refused.getResponse())).toContain('waiting_earnings');
    expect(JSON.stringify(refused.getResponse())).not.toContain('\u2014');
  });

  it('a share that has landed, or is owed to someone else, blocks nobody', async () => {
    const paid = person();
    await share(paid, 'landed');
    const other = person();
    await share(other);
    const check = await money.check(paid);
    expect(check.blockers).toEqual([]);
    expect(check.waitingEarnings).toBe(0);
  });

  it('a sale and a share together count each once, and a sale is not counted twice', async () => {
    const creator = person();
    await sale(creator);
    expect((await money.check(creator)).waitingEarnings).toBe(1);
    await share(creator);
    const check = await money.check(creator);
    expect(check.blockers).toEqual(['waiting_earnings']);
    expect(check.waitingEarnings).toBe(2);
  });

  it('a person owed nothing is not blocked', async () => {
    const check = await money.check(person());
    expect(check.blockers).toEqual([]);
    expect(check.waitingEarnings).toBe(0);
  });
});
