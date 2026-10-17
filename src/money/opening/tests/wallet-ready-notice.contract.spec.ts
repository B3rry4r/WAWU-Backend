import { randomBytes, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotificationService } from '../../../notification/notification.service';
import {
  type ProviderCustomer,
  type ProviderCustomerLookup,
  type ProviderOpenedWallet,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import type { IdentityHasher } from '../../identity/identity-config';
import type { SelfieMatchService } from '../../identity/selfie-match.service';
import type { WalletIdentityService } from '../../identity/wallet-identity.service';
import type { TransactionPinService } from '../../pin/transaction-pin.service';
import type { OpenNairaWalletDto } from '../dto/open-wallet.dto';
import { WalletOpeningService } from '../wallet-opening.service';

/**
 * WALLET-40 (owner answer 31, 17 Oct 2026; BACKEND_GAPS G-823), the provider
 * that answers an account at once or later through the seam
 * (`WALLET_PROVIDER`): one "Your account number is ready" notice for a wallet
 * recorded AFTER its opening began (the sweep finding the account of a lost or
 * late answer), none for a number ready in the request that opened the
 * wallet, none for an opening that ended without a wallet, and exactly one
 * however many servers sweep at once. A real database; the provider is a
 * hand-made object at the seam, so nothing reaches Fintava or any host.
 */

jest.setTimeout(60_000);

const RUN = `w40f-${randomUUID().slice(0, 8)}`;
const TITLE = 'Your account number is ready';
const BODY = 'Tap to see it in your wallet.';

let seq = 0;
const digits = (n: number): string => {
  seq += 1;
  return `${Date.now()}${seq}${Math.floor(Math.random() * 1e9)}`
    .replace(/\D/g, '')
    .slice(-n)
    .padStart(n, '7');
};

interface Person {
  id: string;
  phone: string;
  bvnHash: string;
  customer: ProviderCustomer;
}

describe('WALLET-40: the account number is ready (opening through the provider seam)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let notifications: NotificationService;
  const people: string[] = [];

  /** What the hand-made provider answers, per phone. */
  const looks = new Map<string, ProviderCustomerLookup>();
  const created = new Map<string, ProviderOpenedWallet | WalletProviderError>();

  const provider = {
    name: 'fintava',
    label: 'Fintava',
    configured: true,
    timings: {
      readTimeoutMs: 2_000,
      moneyTimeoutMs: 2_000,
      checkTimeoutMs: 2_000,
      resendSafetyMs: 600_000,
      retryAfterSeconds: 30,
    },
    capabilities: { separateKyc: false },
    walletBankCode: '090',
    findCustomerByPhone: (phone: string): Promise<ProviderCustomerLookup> =>
      Promise.resolve(looks.get(phone) ?? { state: 'absent' }),
    listCustomerSightings: () =>
      Promise.resolve({ items: [], hasNextPage: false }),
    openWallet: (input: { phone: string }): Promise<ProviderOpenedWallet> => {
      const answer = created.get(input.phone);
      if (!answer) return Promise.reject(new Error('no answer prepared'));
      return answer instanceof WalletProviderError
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  } as unknown as WalletProvider;

  /** A service for one "server": the same database, its own flags. */
  function server(p?: Person): WalletOpeningService {
    const identity = {
      // The passed BVN check and selfie the person's request carries.
      proveIdentity: () => {
        if (!p) return Promise.reject(new Error('no request here'));
        return Promise.resolve({
          verifiedAt: new Date(),
          bvnHash: p.bvnHash,
          verifiedPhone: p.phone,
          bvn: '00000000000',
          nin: '00000000000',
        });
      },
    };
    return new WalletOpeningService(
      prisma,
      provider,
      { configured: true, hash: () => 'h' } as unknown as IdentityHasher,
      identity as unknown as WalletIdentityService,
      {
        matchedFor: () => Promise.resolve(new Date()),
      } as unknown as SelfieMatchService,
      {
        state: () => Promise.resolve({ set: false }),
      } as unknown as TransactionPinService,
      {
        bankName: 'Test Bank',
        licenceLine: null,
        depositInsuranceLine: null,
      },
      notifications,
      undefined,
    );
  }

  /** The server whose request opens the wallet for this person. */
  function requestFor(p: Person): {
    service: WalletOpeningService;
    open: () => Promise<unknown>;
  } {
    const service = server(p);
    const input = {
      firstName: 'Ada',
      lastName: 'Obi',
      dateOfBirth: '1990-01-01',
      address: '1 Test Street',
    } as unknown as OpenNairaWalletDto;
    return {
      service,
      open: () => service.open(p.id, `${p.id}@test.wawu.dev`, input, p.phone),
    };
  }

  function person(): Person {
    const id = randomUUID();
    people.push(id);
    const phone = `+23480${digits(8)}`;
    const bvnHash = `${RUN}-${randomBytes(12).toString('hex')}`;
    const customer: ProviderCustomer = {
      customerId: `${RUN}-c-${randomBytes(5).toString('hex')}`,
      walletId: `${RUN}-w-${randomBytes(5).toString('hex')}`,
      accountNumber: `7${digits(9)}`,
      accountName: 'Ada Obi',
    };
    return { id, phone, bvnHash, customer };
  }

  const found = (p: Person, bvnDigest: string | null = p.bvnHash) =>
    looks.set(p.phone, {
      state: 'found',
      customer: p.customer,
      bvnDigest,
    });

  const notices = (p: Person) =>
    prisma.notification.findMany({
      where: { userWawuId: p.id, kind: 'wallet_ready' },
    });
  const wallets = (p: Person) =>
    prisma.fintavaWallet.count({ where: { wawuUserId: p.id } });
  const opening = (p: Person) =>
    prisma.fintavaWalletOpening.findUnique({ where: { wawuUserId: p.id } });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [NotificationService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    notifications = moduleRef.get(NotificationService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: people } },
      });
    }
    if (moduleRef) await moduleRef.close();
  });

  describe('a number ready in the request that opens the wallet tells nobody', () => {
    it('the provider answers the account at once: the wallet is recorded and no notice is written', async () => {
      const p = person();
      created.set(p.phone, { state: 'open', customer: p.customer });
      await requestFor(p).open();
      expect(await wallets(p)).toBe(1);
      expect((await opening(p))?.state).toBe('open');
      expect(await notices(p)).toEqual([]);
    });

    it('the provider already has the account for the phone (found before the create): recorded in the request, no notice', async () => {
      const p = person();
      found(p);
      await requestFor(p).open();
      expect(await wallets(p)).toBe(1);
      expect(await notices(p)).toEqual([]);
    });

    it('a person who taps again while the answer is lost and the account is found by that request sees it there: no notice', async () => {
      const p = person();
      created.set(p.phone, {
        state: 'provisioning',
        customerId: p.customer.customerId,
        walletId: null,
      });
      const { service, open } = requestFor(p);
      await open();
      expect((await opening(p))?.state).toBe('unknown');
      // The account is there now; the person's own request reconciles it.
      found(p);
      const row = (await opening(p))!;
      const settled = await service.reconcile({
        ...row,
        checkedAt: null,
      });
      expect(settled).toBe('open');
      expect(await wallets(p)).toBe(1);
      expect(await notices(p)).toEqual([]);
    });
  });

  describe('a number that becomes ready after the opening began tells the person once', () => {
    it('the provider issues the number later: nothing while it is on its way, one notice when the sweep records it', async () => {
      const p = person();
      created.set(p.phone, {
        state: 'provisioning',
        customerId: p.customer.customerId,
        walletId: null,
      });
      const a = requestFor(p);
      await a.open();
      expect(await wallets(p)).toBe(0);
      expect(await notices(p)).toEqual([]);

      // Still not there: a sweep finds nothing and tells nobody.
      await a.service.sweep();
      expect(await notices(p)).toEqual([]);

      // It is there: the sweep records it and tells the person.
      found(p);
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: p.id },
        data: { checkedAt: null },
      });
      const counts = await a.service.sweep();
      expect(counts.open).toBeGreaterThanOrEqual(1);
      expect(await wallets(p)).toBe(1);
      const sent = await notices(p);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        userWawuId: p.id,
        kind: 'wallet_ready',
        title: TITLE,
        body: BODY,
        tone: 'success',
        read: false,
        actionHref: null,
      });
      const words = `${sent[0].title} ${sent[0].body}`;
      expect(words).not.toContain(p.customer.accountNumber);
      expect(words).not.toMatch(/\d{4,}/);
      expect(words).not.toMatch(new RegExp('[\\u2014\\u2013]'));

      // More sweeps, and a later request: still one.
      await a.service.sweep();
      await a.service.sweep();
      expect(await notices(p)).toHaveLength(1);
    });

    it('five servers sweeping the same lost answer at once make one wallet and one notice', async () => {
      const p = person();
      created.set(p.phone, {
        state: 'provisioning',
        customerId: p.customer.customerId,
        walletId: null,
      });
      await requestFor(p).open();
      found(p);
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: p.id },
        data: { checkedAt: null },
      });
      const servers = [server(), server(), server(), server(), server()];
      await Promise.all(servers.map((s) => s.sweep()));
      await Promise.all(servers.map((s) => s.sweep()));
      expect(await wallets(p)).toBe(1);
      expect(await notices(p)).toHaveLength(1);
    });

    it('two people are told about their own wallets, each once', async () => {
      const a = person();
      const b = person();
      for (const p of [a, b]) {
        created.set(p.phone, {
          state: 'provisioning',
          customerId: p.customer.customerId,
          walletId: null,
        });
        await requestFor(p).open();
      }
      found(a);
      await prisma.fintavaWalletOpening.updateMany({
        where: { wawuUserId: { in: [a.id, b.id] } },
        data: { checkedAt: null },
      });
      await server().sweep();
      expect(await notices(a)).toHaveLength(1);
      expect(await notices(b)).toEqual([]);
      found(b);
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: b.id },
        data: { checkedAt: null },
      });
      await server().sweep();
      expect(await notices(a)).toHaveLength(1);
      expect(await notices(b)).toHaveLength(1);
    });
  });

  describe('no wallet, no notice', () => {
    it('an opening the provider refused ends without a wallet and without a notice, through any number of sweeps', async () => {
      const p = person();
      created.set(
        p.phone,
        new WalletProviderError({
          kind: 'validation',
          provider: 'fintava',
          operation: 'openWallet',
          httpStatus: 400,
        }),
      );
      const a = requestFor(p);
      await expect(a.open()).rejects.toBeDefined();
      expect((await opening(p))?.state).toBe('failed');
      await a.service.sweep();
      await a.service.sweep();
      expect(await wallets(p)).toBe(0);
      expect(await notices(p)).toEqual([]);
    });

    it('an account the provider holds for someone else (another BVN) is stopped for review: no wallet, no notice', async () => {
      const p = person();
      created.set(p.phone, {
        state: 'provisioning',
        customerId: p.customer.customerId,
        walletId: null,
      });
      const a = requestFor(p);
      await a.open();
      found(p, `${RUN}-someone-else`);
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: p.id },
        data: { checkedAt: null },
      });
      await a.service.sweep();
      expect((await opening(p))?.state).toBe('conflict');
      expect(await wallets(p)).toBe(0);
      expect(await notices(p)).toEqual([]);
    });
  });
});
