import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { AccountModule } from '../account.module';
import { AccountService } from '../account.service';
import { DeleteAccountDto, LEAVING_REASONS } from '../dto/delete-account.dto';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../wawu-id-account.gateway';

/**
 * Z7's optional "Why are you leaving?" (SETTINGS-05): the Hub keeps the choice
 * on the person's deletion row, takes none as none, refuses a value outside
 * the list, and a request with no body is what it always was. The real
 * AccountModule over a real database; the wallet provider answers a zero
 * balance (the Nuvion shape: no freeze), WAWU ID's gateway is a stand-in.
 */
describe('Delete account: the leaving reason (SETTINGS-05)', () => {
  jest.setTimeout(60000);
  const provider = {
    name: 'nuvion',
    label: 'Nuvion',
    timings: { retryAfterSeconds: 3 },
    getBalance: jest.fn(() =>
      Promise.resolve({ availableKobo: 0n, bookedKobo: 0n }),
    ),
  };
  const gateway = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const people: string[] = [];
  let app: INestApplication;
  let prisma: PrismaService;
  let accounts: AccountService;

  async function person(): Promise<string> {
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
    return id;
  }
  const body = (value: unknown): Promise<DeleteAccountDto> =>
    pipe.transform(value, {
      type: 'body',
      metatype: DeleteAccountDto,
    }) as Promise<DeleteAccountDto>;
  const row = (id: string) =>
    prisma.accountDeletion.findUnique({ where: { wawuUserId: id } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
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
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    accounts = moduleRef.get(AccountService);
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
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await app.close();
  });

  it('a person who picks a reason has it kept on the deletion row', async () => {
    const id = await person();
    const asked = await body({ reason: 'privacy' });
    const answer = await accounts.deleteAccount(id, asked.reason);
    expect(answer).toHaveProperty('deletionScheduledAt');
    expect(await row(id)).toMatchObject({
      status: 'scheduled',
      leavingReason: 'privacy',
    });
  });

  it('a person who does not pick one is scheduled with none stored', async () => {
    const id = await person();
    const asked = await body({});
    await accounts.deleteAccount(id, asked.reason);
    expect(await row(id)).toMatchObject({
      status: 'scheduled',
      leavingReason: null,
    });
    const bare = await person();
    await accounts.deleteAccount(bare);
    expect(await row(bare)).toMatchObject({ leavingReason: null });
  });

  it('every choice the app offers is accepted', async () => {
    for (const reason of LEAVING_REASONS) {
      expect((await body({ reason })).reason).toBe(reason);
    }
  });

  it('a value outside the list, free text and a stray field are refused with 400', async () => {
    await expect(body({ reason: 'because I said so' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(body({ reason: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(body({ reason: 7 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(body({ reason: 'privacy', note: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('asked again while one is waiting, the schedule and the first reason do not move', async () => {
    const id = await person();
    const first = await accounts.deleteAccount(id, 'another_account');
    const second = await accounts.deleteAccount(id, 'privacy');
    const third = await accounts.deleteAccount(id);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    const kept = await row(id);
    expect(kept).toMatchObject({
      status: 'scheduled',
      leavingReason: 'another_account',
    });
    expect(
      await prisma.accountDeletion.count({ where: { wawuUserId: id } }),
    ).toBe(1);
  });

  it('a deletion cancelled and asked for again carries the new reason, or none', async () => {
    const id = await person();
    await accounts.deleteAccount(id, 'too_many_notifications');
    expect((await accounts.cancelDeletion(id)).cancelled).toBe(true);
    await accounts.deleteAccount(id, 'something_else');
    expect(await row(id)).toMatchObject({
      status: 'scheduled',
      leavingReason: 'something_else',
    });
    expect((await accounts.cancelDeletion(id)).cancelled).toBe(true);
    await accounts.deleteAccount(id);
    expect(await row(id)).toMatchObject({
      status: 'scheduled',
      leavingReason: null,
    });
  });

  it('a refused deletion (money in the wallet) stores no reason and no row', async () => {
    const id = await person();
    provider.getBalance.mockResolvedValueOnce({
      availableKobo: 50_000n,
      bookedKobo: 50_000n,
    });
    await expect(accounts.deleteAccount(id, 'privacy')).rejects.toMatchObject({
      status: 409,
    });
    expect(await row(id)).toBeNull();
  });
});
