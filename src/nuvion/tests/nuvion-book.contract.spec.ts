import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  NuvionAccountsStandin,
  type StandinAccount,
} from '../../../test/nuvion/accounts-standin';
import {
  type BookMode,
  NuvionBookStandin,
} from '../../../test/nuvion/book-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  ProviderTransaction,
  ProviderTransferReceipt,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { nuvionWalletId } from '../areas/accounts';
import { NuvionBookArea } from '../areas/book';
import { PrismaNuvionBookStore } from '../areas/book-store';
import { NuvionClient } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';

/**
 * NUV-05's book transfer area against the Nuvion stand-in over a real
 * socket (NUV-01's `NuvionStandin` with NUV-04's accounts and NUV-05's
 * transfers: test/nuvion/book-standin.ts) and a real database (the log of
 * book transfers, the person's account records). The real client, the real
 * area, the real store. No Nuvion, Fintava or wawuafrica.com host is
 * reached: every connection but loopback is refused (outbound-guard.ts).
 */

jest.setTimeout(60_000);

const RUN = `n5-${randomUUID().slice(0, 8)}`;
const KEY = 'nv_test_sk_NUV05bookKEY0000000000000000';
let seq = 0;
const ref = (what: string) => `${RUN}-${what}-${(seq += 1)}`;
let numberSeq = 0;
const nuban = () =>
  `7${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

describe('NUV-05: book transfers and the operational account', () => {
  const standin = new NuvionStandin();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let store: PrismaNuvionBookStore;
  let area: NuvionBookArea;
  const wallets: string[] = [];
  const clock = { now: Date.now() };

  interface Person {
    wawuUserId: string;
    accountNumber: string;
    account: StandinAccount;
  }

  async function person(kobo: number, withBan = true): Promise<Person> {
    const wawuUserId = randomUUID();
    const accountNumber = nuban();
    const account = book.openPerson(kobo, accountNumber);
    wallets.push(wawuUserId);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId,
        customerId: account.entity_id,
        walletId: nuvionWalletId(account.entity_id, account.id),
        accountNumber,
        provider: 'nuvion',
      },
    });
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId,
        entityId: account.entity_id,
        accountId: account.id,
        nuvionBan: withBan ? account.nuvion_ban : null,
        accountNumber,
        status: 'approved',
        currency: 'NGN',
      },
    });
    return { wawuUserId, accountNumber, account };
  }

  const operationalBan = () => book.operational.nuvion_ban;

  function newArea(over: ConstructorParameters<typeof NuvionBookArea>[3] = {}) {
    const client = new NuvionClient(
      standin.settings({
        operationalAccountId: book.operational.id,
        moneyTimeoutMs: 1_500,
      }),
      KEY,
    );
    return new NuvionBookArea(client, client.settings, store, {
      settleStepsMs: [10, 20, 40],
      now: () => new Date(clock.now),
      ...over,
    });
  }

  const sendFrom = (
    p: Person,
    toNumber: string,
    kobo: number,
    reference: string,
    a: NuvionBookArea = area,
  ) =>
    a.walletToWallet({
      fromAccountNumber: p.accountNumber,
      toAccountNumber: toNumber,
      amountKobo: BigInt(kobo),
      reference,
      narration: 'WAWU purchase',
    });

  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );

  async function failure(p: Promise<unknown>): Promise<WalletProviderError> {
    const r = await outcome(p);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected a failure');
    expect(r.e).toBeInstanceOf(WalletProviderError);
    return r.e as WalletProviderError;
  }

  beforeAll(async () => {
    guard = guardOutbound();
    await standin.start();
    accounts.install();
    book.install();
    book.fundOperational(10_000_000);
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    store = new PrismaNuvionBookStore(prisma);
    area = newArea();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.nuvionBookTransfer.deleteMany({
        where: { reference: { startsWith: RUN } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: wallets } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: wallets } },
      });
    }
    await moduleRef?.close();
    await standin.stop();
    guard.restore();
  });

  beforeEach(() => {
    standin.reset();
    book.mode = 'successful';
    book.duplicateAs = '409';
    book.feeKobo = () => 0;
    book.extraKobo = 0;
    book.createRequests.length = 0;
  });

  // -------------------------------------------------------------------------
  // WAWU's operational account
  // -------------------------------------------------------------------------

  describe('getPlatformAccount', () => {
    it('reads the operational account from Nuvion, with no entity, and answers its nuvion_ban and balance', async () => {
      const before = Number(book.operational.balance.available);
      const a = await area.getPlatformAccount();
      expect(a.accountNumber).toBe('NVXYT1GUCM');
      expect(a.accountName).toBe('WAWU Operational');
      expect(a.availableKobo).toBe(BigInt(before));
      const gets = standin.seen.filter(
        (r) =>
          r.method === 'GET' && r.path === `/accounts/${book.operational.id}`,
      );
      expect(gets).toHaveLength(1);
      expect(gets[0].query.entity_id).toBeUndefined();
      expect(gets[0].headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it('reads the balance on every call: Nuvion moving money is seen at once', async () => {
      const p = await person(500_000);
      const first = await area.getPlatformAccount();
      await sendFrom(p, operationalBan(), 100_000, ref('bal'));
      const second = await area.getPlatformAccount();
      expect(second.availableKobo - first.availableKobo).toBe(100_000n);
    });

    it.each([
      ['a deleted account', { deleted: 1 }, 'merchant_inactive'],
      ['a person account', { type: 'checking' }, 'bad_response'],
      ['a dollar account', { currency: 'USD' }, 'bad_response'],
      ['a garbled nuvion_ban', { nuvion_ban: 'x y' }, 'bad_response'],
      ['no nuvion_ban', { nuvion_ban: '' }, 'bad_response'],
      [
        'a fractional balance',
        { balance: { available: 10.5, current: 11, overdraft_used: 0 } },
        'bad_response',
      ],
      [
        'a negative balance',
        { balance: { available: -1, current: 0, overdraft_used: 0 } },
        'bad_response',
      ],
    ])('refuses %s', async (_what, patch, kind) => {
      const saved = { ...book.operational };
      Object.assign(book.operational, patch);
      try {
        const e = await failure(newArea().getPlatformAccount());
        expect(e.kind).toBe(kind);
        expect(e.recordMayExist).toBe(false);
      } finally {
        Object.assign(book.operational, saved);
      }
    });
  });

  // -------------------------------------------------------------------------
  // A payment from a wallet into WAWU's operational account
  // -------------------------------------------------------------------------

  describe('a payment from a person to WAWU', () => {
    it('is one book transfer, sent as Nuvion receives it, and a receipt at the fee Nuvion states', async () => {
      book.feeKobo = () => 1500;
      const p = await person(1_000_000);
      const opBefore = book.availableOf(book.operational.id);
      const reference = ref('pay');
      const receipt = await sendFrom(p, operationalBan(), 100_000, reference);

      expect(book.createRequests).toHaveLength(1);
      expect(book.createRequests[0]).toEqual({
        account_id: p.account.id,
        entity_id: p.account.entity_id,
        amount: 100_000,
        currency: 'NGN',
        payment_type: 'book-transfer',
        nuvion_ban: 'NVXYT1GUCM',
        narration: 'WAWU purchase',
        unique_reference: reference,
      });
      expect(reference.length).toBeLessThanOrEqual(64);
      const t = book.byReference(reference);
      expect(t).toHaveLength(1);
      expect(receipt).toEqual<ProviderTransferReceipt>({
        ourReference: reference,
        providerReference: t[0].id,
        secondaryReference: null,
        transactionId: t[0].id,
        amountKobo: 100_000n,
        totalKobo: 101_500n,
        feeKobo: 1_500n,
        sourceAvailableKobo: null,
      });
      // The money: the payer paid the price and the fee, WAWU got the price.
      expect(book.availableOf(p.account.id)).toBe(1_000_000 - 101_500);
      expect(book.availableOf(book.operational.id)).toBe(opBefore + 100_000);
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(row).toMatchObject({
        nuvionId: t[0].id,
        status: 'successful',
        fromAccountId: p.account.id,
        fromEntityId: p.account.entity_id,
        fromOperational: false,
        fromAccountNumber: p.accountNumber,
        toOperational: true,
        toNuvionBan: 'NVXYT1GUCM',
        amountKobo: 100_000n,
        feeKobo: 1_500n,
      });
    });

    it('the same reference sent twice moves once: the second is answered from Nuvion, nothing is sent', async () => {
      const p = await person(1_000_000);
      const reference = ref('twice');
      const a = await sendFrom(p, operationalBan(), 100_000, reference);
      const b = await sendFrom(p, operationalBan(), 100_000, reference);
      expect(b).toEqual(a);
      expect(book.createRequests).toHaveLength(1);
      expect(book.byReference(reference)).toHaveLength(1);
      expect(book.availableOf(p.account.id)).toBe(900_000);
    });

    it('the same reference sent twice at once, from two servers, moves once', async () => {
      const p = await person(1_000_000);
      const reference = ref('race');
      const [x, y] = await Promise.all([
        outcome(sendFrom(p, operationalBan(), 100_000, reference, newArea())),
        outcome(sendFrom(p, operationalBan(), 100_000, reference, newArea())),
      ]);
      expect(book.byReference(reference)).toHaveLength(1);
      expect(book.availableOf(p.account.id)).toBe(900_000);
      // Each caller got the transfer, or was told it may exist: never a
      // refusal, never a second transfer.
      for (const r of [x, y]) {
        if (r.ok) expect(r.v.amountKobo).toBe(100_000n);
        else {
          expect(r.e).toBeInstanceOf(WalletProviderError);
          expect((r.e as WalletProviderError).recordMayExist).toBe(true);
        }
      }
      expect([x, y].some((r) => r.ok)).toBe(true);
    });

    it.each(['409', 'original'] as const)(
      'a repeat after the log lost the answer finds the original (Nuvion answers a repeated reference with %s)',
      async (duplicateAs) => {
        book.duplicateAs = duplicateAs;
        const p = await person(1_000_000);
        const reference = ref(`lostlog-${duplicateAs}`);
        const first = await sendFrom(p, operationalBan(), 100_000, reference);
        // The answer was never read: the log row has no Nuvion id.
        await prisma.nuvionBookTransfer.update({
          where: { reference },
          data: { nuvionId: null, status: 'sending', answeredAt: null },
        });
        const again = await sendFrom(p, operationalBan(), 100_000, reference);
        expect(again).toEqual(first);
        expect(book.byReference(reference)).toHaveLength(1);
        expect(book.availableOf(p.account.id)).toBe(900_000);
        const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
          where: { reference },
        });
        expect(row.nuvionId).toBe(first.transactionId);
      },
    );

    it('a transfer Nuvion has not finished is read again, and is a receipt when it finishes inside the wait', async () => {
      book.mode = 'pending_then_successful';
      book.settleAfterMs = 30;
      const p = await person(1_000_000);
      const reference = ref('slow');
      const receipt = await sendFrom(p, operationalBan(), 100_000, reference);
      expect(receipt.amountKobo).toBe(100_000n);
      const gets = standin.seen.filter(
        (r) => r.method === 'GET' && r.path.startsWith('/transfers/'),
      );
      expect(gets.length).toBeGreaterThanOrEqual(1);
      expect(book.createRequests).toHaveLength(1);
    });

    it('a transfer still pending after the wait is accepted-not-finished: money may move, nothing is sent again, the id is kept', async () => {
      book.mode = 'pending';
      const p = await person(1_000_000);
      const reference = ref('pending');
      const e = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(e.kind).toBe('not_confirmed');
      expect(e.recordMayExist).toBe(true);
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(row.status).toBe('pending');
      expect(row.nuvionId).toBe(book.byReference(reference)[0].id);
      // Asked again later (the sweep): found, still pending; then done.
      const r1 = await area.reconcileSend(
        reference,
        { kind: 'customer', customerId: p.account.entity_id },
        new Date(clock.now),
      );
      expect(r1).toMatchObject({
        state: 'found',
        source: 'lookup',
        transaction: { outcome: 'pending', amountKobo: 100_000n },
      });
      expect(
        area.decideRetry('wallet_to_wallet', r1, {
          attemptedAt: new Date(),
          now: new Date(),
          resendAfterMs: 0,
        }),
      ).toEqual({ action: 'wait', why: 'pending' });
      book.settle(reference, 'successful');
      const r2 = await area.reconcileSend(reference, {
        kind: 'customer',
        customerId: p.account.entity_id,
      });
      expect(r2).toMatchObject({
        state: 'found',
        transaction: { outcome: 'completed', feeKobo: 0n },
      });
      expect(
        area.decideRetry('wallet_to_wallet', r2, {
          attemptedAt: new Date(),
          now: new Date(),
          resendAfterMs: 0,
        }).action,
      ).toBe('settled');
      expect(book.createRequests).toHaveLength(1);
      const done = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(done.status).toBe('successful');
    });

    it('a parameter other than the log holds for the reference is never sent', async () => {
      const p = await person(1_000_000);
      const other = await person(1_000_000);
      const reference = ref('reuse');
      await sendFrom(p, operationalBan(), 100_000, reference);
      const sent = book.createRequests.length;
      const amount = await failure(
        sendFrom(p, operationalBan(), 100_001, reference),
      );
      expect(amount.kind).toBe('duplicate_reference');
      expect(amount.recordMayExist).toBe(true);
      const account = await failure(
        sendFrom(other, operationalBan(), 100_000, reference),
      );
      expect(account.kind).toBe('duplicate_reference');
      const to = await failure(
        sendFrom(p, other.accountNumber, 100_000, reference),
      );
      expect(to.kind).toBe('duplicate_reference');
      expect(book.createRequests).toHaveLength(sent);
    });

    it('Nuvion moving another amount than asked is a stop: the id is not kept, nothing is read as a receipt', async () => {
      book.extraKobo = 5;
      const p = await person(1_000_000);
      const reference = ref('extra');
      const e = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(e.kind).toBe('not_confirmed');
      expect(e.recordMayExist).toBe(true);
      expect(e.messages.join(' ')).toMatch(/100005 kobo/);
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(row.nuvionId).toBeNull();
      expect(row.status).toBe('sending');
    });

    it("the fee comes from Nuvion's record: a transfer whose record states none is not a receipt", async () => {
      const p = await person(1_000_000);
      const reference = ref('nofee');
      standin.next((req) => {
        // The real answer, with `applicable_fee` taken out.
        const made = book.createRequests.length;
        void made;
        return {
          status: 201,
          body: {
            status: 'success',
            message: 'ok',
            data: {
              id: '01HXYZNOFEE000000000000001',
              amount: 100_000,
              currency: 'NGN',
              unique_reference: String(
                (req.body as { unique_reference: string }).unique_reference,
              ),
              account_id: p.account.id,
              entity_id: p.account.entity_id,
              status: 'successful',
              status_reason: 'processing_complete',
              type: 'outflow',
              payment_type: 'book-transfer',
              created: Date.now(),
              updated: Date.now(),
            },
          },
        };
      });
      const e = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(e.kind).toBe('not_confirmed');
      expect(e.recordMayExist).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Release and refund out of the operational account
  // -------------------------------------------------------------------------

  describe('a release and a refund from the operational account', () => {
    it("a release is a book transfer from the operational account, no entity named, to the person's nuvion_ban, once", async () => {
      const payee = await person(0);
      const opBefore = book.availableOf(book.operational.id);
      const reference = ref('release');
      const receipt = await area.walletToWallet({
        fromAccountNumber: operationalBan(),
        toAccountNumber: payee.accountNumber,
        amountKobo: 85_000n,
        reference,
        narration: 'WAWU release',
      });
      expect(book.createRequests[0]).toEqual({
        account_id: book.operational.id,
        amount: 85_000,
        currency: 'NGN',
        payment_type: 'book-transfer',
        nuvion_ban: payee.account.nuvion_ban,
        narration: 'WAWU release',
        unique_reference: reference,
      });
      expect(receipt.amountKobo).toBe(85_000n);
      expect(book.availableOf(payee.account.id)).toBe(85_000);
      expect(book.availableOf(book.operational.id)).toBe(opBefore - 85_000);
      // Again, twice at once: still once.
      await Promise.all([
        area.walletToWallet({
          fromAccountNumber: operationalBan(),
          toAccountNumber: payee.accountNumber,
          amountKobo: 85_000n,
          reference,
          narration: 'WAWU release',
        }),
        newArea().walletToWallet({
          fromAccountNumber: operationalBan(),
          toAccountNumber: payee.accountNumber,
          amountKobo: 85_000n,
          reference,
          narration: 'WAWU release',
        }),
      ]);
      expect(book.byReference(reference)).toHaveLength(1);
      expect(book.availableOf(payee.account.id)).toBe(85_000);
    });

    it('a refund is the same move to the payer, under its own reference', async () => {
      const payer = await person(0);
      const reference = ref('refund');
      const r = await area.walletToWallet({
        fromAccountNumber: operationalBan(),
        toAccountNumber: payer.accountNumber,
        amountKobo: 100_000n,
        reference,
        narration: 'WAWU refund',
      });
      expect(r.totalKobo).toBe(100_000n);
      expect(book.availableOf(payer.account.id)).toBe(100_000);
    });

    it('the operational account named by its id, or in lower case, is the same account', async () => {
      const payee = await person(0);
      const r = await area.walletToWallet({
        fromAccountNumber: book.operational.id,
        toAccountNumber: payee.account.nuvion_ban.toLowerCase(),
        amountKobo: 1_000n,
        reference: ref('names'),
        narration: 'WAWU release',
      });
      expect(r.amountKobo).toBe(1_000n);
      const second = await person(0);
      const r2 = await area.walletToWallet({
        fromAccountNumber: operationalBan().toLowerCase(),
        toAccountNumber: second.accountNumber,
        amountKobo: 1_000n,
        reference: ref('names'),
        narration: 'WAWU release',
      });
      expect(r2.amountKobo).toBe(1_000n);
    });

    it('a person who has no nuvion_ban on record has it read from Nuvion', async () => {
      const payee = await person(0, false);
      const r = await area.walletToWallet({
        fromAccountNumber: operationalBan(),
        toAccountNumber: payee.accountNumber,
        amountKobo: 1_000n,
        reference: ref('noban'),
        narration: 'WAWU release',
      });
      expect(r.amountKobo).toBe(1_000n);
      expect(book.createRequests.at(-1)?.nuvion_ban).toBe(
        payee.account.nuvion_ban,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Naming the accounts
  // -------------------------------------------------------------------------

  describe('which account a name is', () => {
    it("a name that is none of WAWU's Nuvion accounts sends nothing", async () => {
      const p = await person(1_000_000);
      const e = await failure(
        area.walletToWallet({
          fromAccountNumber: p.accountNumber,
          toAccountNumber: '9999999999',
          amountKobo: 1_000n,
          reference: ref('nobody'),
          narration: 'x',
        }),
      );
      expect(e.kind).toBe('not_found');
      expect(e.recordMayExist).toBe(false);
      expect(book.createRequests).toHaveLength(0);
    });

    it('a transfer from an account to itself sends nothing', async () => {
      const p = await person(1_000_000);
      const e = await failure(
        sendFrom(p, p.account.nuvion_ban, 1_000, ref('self')),
      );
      expect(e.kind).toBe('validation');
      const o = await failure(
        area.walletToWallet({
          fromAccountNumber: operationalBan(),
          toAccountNumber: book.operational.id,
          amountKobo: 1_000n,
          reference: ref('self-op'),
          narration: 'x',
        }),
      );
      expect(o.kind).toBe('validation');
      expect(book.createRequests).toHaveLength(0);
    });

    it.each([
      ['an empty reference', '', 1_000n],
      ['a reference of 65 characters', 'r'.repeat(65), 1_000n],
      ['a reference with a space', 'two words', 1_000n],
      ['an amount of zero', 'ok', 0n],
      ['a negative amount', 'ok', -1n],
      ['an amount past what a number holds', 'ok', 2n ** 60n],
    ])(
      'refuses %s before anything is sent',
      async (_what, reference, amount) => {
        const p = await person(1_000_000);
        const e = await failure(
          area.walletToWallet({
            fromAccountNumber: p.accountNumber,
            toAccountNumber: operationalBan(),
            amountKobo: amount,
            reference,
            narration: 'x',
          }),
        );
        expect(e.kind).toBe('validation');
        expect(e.recordMayExist).toBe(false);
        expect(book.createRequests).toHaveLength(0);
      },
    );

    it('isSameAccount knows one account by its account number, id and nuvion_ban in any case', async () => {
      const p = await person(0);
      const q = await person(0);
      const same = (a: string, b: string) => area.isSameAccount(a, b);
      expect(await same(p.accountNumber, p.account.nuvion_ban)).toBe(true);
      expect(await same(p.account.nuvion_ban.toLowerCase(), p.account.id)).toBe(
        true,
      );
      expect(
        await same(
          p.account.id,
          nuvionWalletId(p.account.entity_id, p.account.id),
        ),
      ).toBe(true);
      expect(await same(p.accountNumber, q.accountNumber)).toBe(false);
      expect(await same('NVXYT1GUCM', 'nvxyt1gucm')).toBe(true);
      expect(await same(operationalBan(), book.operational.id)).toBe(true);
      expect(
        await same(operationalBan().toLowerCase(), book.operational.id),
      ).toBe(true);
      expect(await same(p.accountNumber, operationalBan())).toBe(false);
      expect(await same('0000000000', operationalBan())).toBe(false);
      expect(await same('', operationalBan())).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Refusals, and answers that prove nothing
  // -------------------------------------------------------------------------

  describe('what Nuvion refuses', () => {
    it('its own insufficient funds is a refusal, nothing moved, and the same reference is sent again once the money is there', async () => {
      const p = await person(50_000);
      const reference = ref('short');
      const e = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(e.kind).toBe('insufficient_funds');
      expect(e.recordMayExist).toBe(false);
      expect(
        book.all().filter((t) => t.unique_reference === reference),
      ).toHaveLength(0);
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(row.status).toBe('refused');
      // Funded: the same reference goes out, once.
      book.fundOperational(Number(book.operational.balance.available));
      p.account.balance.available = 500_000;
      const r = await sendFrom(p, operationalBan(), 100_000, reference);
      expect(r.amountKobo).toBe(100_000n);
      expect(book.byReference(reference)).toHaveLength(1);
    });

    it.each([
      ['error_transfer_account_not_active', 'wallet_inactive'],
      ['error_transfer_compliance_rejected', 'refused'],
    ])('%s is %s and moved nothing', async (type, kind) => {
      const p = await person(1_000_000);
      const reference = ref(type.slice(-8));
      standin.failNext(type);
      const e = await failure(sendFrom(p, operationalBan(), 1_000, reference));
      expect(e.kind).toBe(kind);
      expect(e.recordMayExist).toBe(false);
      expect(book.byReference(reference)).toHaveLength(0);
    });

    it('its three limit refusals reach the caller as limits, nothing moved', async () => {
      for (const type of [
        'error_transfer_transaction_limit_exceeded',
        'error_transfer_daily_limit_exceeded',
        'error_transfer_monthly_volume_exceeded',
      ]) {
        const p = await person(1_000_000);
        standin.failNext(type);
        const e = await failure(
          sendFrom(p, operationalBan(), 1_000, ref('lim')),
        );
        expect(e.recordMayExist).toBe(false);
        expect(e.constructor.name).toBe('WalletProviderLimitError');
      }
    });

    it('a transfer Nuvion made and then failed is a refusal each time it is asked about, never a second transfer', async () => {
      book.mode = 'pending';
      const p = await person(1_000_000);
      const reference = ref('failed');
      await failure(sendFrom(p, operationalBan(), 100_000, reference));
      book.settle(reference, 'failed');
      // The payer is given back.
      expect(book.availableOf(p.account.id)).toBe(1_000_000);
      const again = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(again.kind).toBe('refused');
      expect(again.recordMayExist).toBe(false);
      expect(again.messages.join(' ')).toMatch(/failed/);
      expect(book.byReference(reference)).toHaveLength(1);
      const r = await area.reconcileSend(reference, {
        kind: 'customer',
        customerId: p.account.entity_id,
      });
      expect(r).toMatchObject({
        state: 'found',
        transaction: { outcome: 'failed' },
      });
      expect(
        area.decideRetry('wallet_to_wallet', r, {
          attemptedAt: new Date(),
          now: new Date(),
          resendAfterMs: 0,
        }).action,
      ).toBe('settled');
    });

    it("a failed transfer for want of money is the caller's insufficient funds", async () => {
      book.mode = 'pending';
      const p = await person(1_000_000);
      const reference = ref('failed-funds');
      await failure(sendFrom(p, operationalBan(), 100_000, reference));
      book.failReason = 'insufficient_funds';
      book.settle(reference, 'failed');
      book.failReason = 'compliance_hold';
      const again = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(again.kind).toBe('insufficient_funds');
    });

    it('a transfer Nuvion completed and then reversed is not a receipt and not a refusal: asked about, never sent again', async () => {
      book.mode = 'successful';
      const p = await person(1_000_000);
      const reference = ref('reversed');
      await sendFrom(p, operationalBan(), 100_000, reference);
      book.settle(reference, 'reversed');
      const again = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(again.kind).toBe('not_confirmed');
      expect(again.recordMayExist).toBe(true);
      const r = await area.reconcileSend(reference, {
        kind: 'customer',
        customerId: p.account.entity_id,
      });
      expect(r).toMatchObject({
        state: 'found',
        transaction: { outcome: 'reversed' },
      });
      expect(book.createRequests).toHaveLength(1);
      expect(book.availableOf(p.account.id)).toBe(1_000_000);
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(row.status).toBe('reversed');
    });
  });

  // -------------------------------------------------------------------------
  // A lost answer
  // -------------------------------------------------------------------------

  describe('a lost answer', () => {
    it("after Nuvion made the transfer: found again by its reference, by the sender's history, and never sent again", async () => {
      const p = await person(1_000_000);
      const reference = ref('lost');
      book.loseAnswerNext(true);
      const e = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(e.kind).toBe('outcome_unknown');
      expect(e.recordMayExist).toBe(true);
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(row.status).toBe('sending');
      expect(row.nuvionId).toBeNull();
      expect(book.byReference(reference)).toHaveLength(1);

      const found = await area.reconcileSend(
        reference,
        { kind: 'customer', customerId: p.account.entity_id },
        row.sentAt,
      );
      expect(found).toMatchObject({
        state: 'found',
        source: 'history',
        transaction: {
          ourReference: reference,
          amountKobo: 100_000n,
          outcome: 'completed',
        },
      });
      const kept = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(kept.nuvionId).toBe(book.byReference(reference)[0].id);
      expect(kept.status).toBe('successful');
      // Asked about by the reference alone, and by Nuvion's id.
      expect(await area.findTransactionByReference(reference)).toMatchObject({
        state: 'found',
        transaction: { id: kept.nuvionId },
      });
      expect(await area.findTransactionById(kept.nuvionId!)).toMatchObject({
        state: 'found',
        transaction: { ourReference: reference },
      });
      // Sent again under the same reference (a hold's retry): the original.
      const again = await sendFrom(p, operationalBan(), 100_000, reference);
      expect(again.transactionId).toBe(kept.nuvionId);
      expect(book.byReference(reference)).toHaveLength(1);
      expect(book.availableOf(p.account.id)).toBe(900_000);
    });

    it("found again from WAWU's own account by the merchant history", async () => {
      const payee = await person(0);
      const reference = ref('lost-op');
      book.loseAnswerNext(true);
      await failure(
        area.walletToWallet({
          fromAccountNumber: operationalBan(),
          toAccountNumber: payee.accountNumber,
          amountKobo: 85_000n,
          reference,
          narration: 'WAWU release',
        }),
      );
      const r = await area.reconcileSend(reference, { kind: 'merchant' });
      expect(r).toMatchObject({
        state: 'found',
        source: 'history',
        transaction: { amountKobo: 85_000n },
      });
      // The list was asked for the operational account, with no entity.
      const list = standin.seen.filter(
        (q) => q.method === 'GET' && q.path === '/transfers',
      );
      expect(list.at(-1)?.query).toMatchObject({
        account_id: book.operational.id,
      });
      expect(list.at(-1)?.query.entity_id).toBeUndefined();
    });

    it('a reference the log never held is not asked about: it is not a book transfer this area sent', async () => {
      const p = await person(1_000_000);
      const reference = ref('lost-nolog');
      book.loseAnswerNext(true);
      await failure(sendFrom(p, operationalBan(), 100_000, reference));
      await prisma.nuvionBookTransfer.delete({ where: { reference } });
      standin.seen.length = 0;
      const r = await area.reconcileSend(reference, {
        kind: 'customer',
        customerId: p.account.entity_id,
      });
      expect(r).toEqual({ state: 'unknown', why: 'unrecognised' });
      expect(await area.findTransactionByReference(reference)).toEqual({
        state: 'unknown',
      });
      expect(standin.seen).toEqual([]);
    });

    it('after a system error that did make the transfer: found, not failed', async () => {
      const p = await person(1_000_000);
      const reference = ref('sys-made');
      book.systemErrorNext({ created: true, status: 503 });
      const e = await failure(
        sendFrom(p, operationalBan(), 100_000, reference),
      );
      expect(e.kind).toBe('outcome_unknown');
      expect(e.recordMayExist).toBe(true);
      const r = await area.reconcileSend(reference, {
        kind: 'customer',
        customerId: p.account.entity_id,
      });
      expect(r.state).toBe('found');
      expect(book.byReference(reference)).toHaveLength(1);
    });

    it('when Nuvion made nothing: unknown while the send may be in flight, then absent, and never advised to be sent again', async () => {
      const p = await person(1_000_000);
      const reference = ref('lost-none');
      book.loseAnswerNext(false);
      await failure(sendFrom(p, operationalBan(), 100_000, reference));
      expect(book.byReference(reference)).toHaveLength(0);
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      const holder = {
        kind: 'customer',
        customerId: p.account.entity_id,
      } as const;
      // Right after the send: it may still be on its way to Nuvion.
      clock.now = row.sentAt.getTime() + 1_000;
      expect(await area.reconcileSend(reference, holder, row.sentAt)).toEqual({
        state: 'unknown',
        why: 'too_soon',
      });
      // Past the money timeout, a complete walk: nothing at Nuvion.
      clock.now = row.sentAt.getTime() + 60_000;
      const absent = await area.reconcileSend(reference, holder, row.sentAt);
      expect(absent).toEqual({ state: 'absent' });
      // Silence is not proof that no money moved: no resend is advised.
      for (const kind of ['wallet_to_wallet', 'bank_transfer'] as const) {
        expect(
          area.decideRetry(kind, absent, {
            attemptedAt: row.sentAt,
            now: new Date(clock.now + 86_400_000),
            resendAfterMs: 0,
          }),
        ).toEqual({ action: 'wait', why: 'pending' });
      }
      clock.now = Date.now();
      // Sent again under the SAME reference (the log row is reopened by the
      // caller's retry once it chooses to), it makes exactly one transfer.
      const r = await sendFrom(p, operationalBan(), 100_000, reference);
      expect(r.amountKobo).toBe(100_000n);
      expect(book.byReference(reference)).toHaveLength(1);
    });

    it('a walk that does not reach the end proves nothing about absence', async () => {
      const p = await person(10_000_000);
      const reference = ref('walk');
      book.loseAnswerNext(false);
      await failure(sendFrom(p, operationalBan(), 1_000, reference));
      // Five newer transfers from the same sender, read two to a page.
      for (let i = 0; i < 5; i += 1) {
        await sendFrom(p, operationalBan(), 1_000, `${ref('filler')}-${i}`);
      }
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      clock.now = row.sentAt.getTime() + 60_000;
      const holder = {
        kind: 'customer',
        customerId: p.account.entity_id,
      } as const;
      const short = newArea({ historyLimit: 2, historyMaxPages: 1 });
      expect(await short.reconcileSend(reference, holder, row.sentAt)).toEqual({
        state: 'unknown',
        why: 'history_incomplete',
      });
      // Read to the end, the same walk can say absent.
      const whole = newArea({ historyLimit: 2, historyMaxPages: 10 });
      expect(await whole.reconcileSend(reference, holder, row.sentAt)).toEqual({
        state: 'absent',
      });
      clock.now = Date.now();
    });

    it('when Nuvion cannot be asked: unknown, not absent', async () => {
      const p = await person(1_000_000);
      const reference = ref('down');
      book.loseAnswerNext(true);
      await failure(sendFrom(p, operationalBan(), 100_000, reference));
      standin.statusNext(503, {
        status: 'error',
        message: 'x',
        type: 'error_system_service_unavailable',
      });
      const r = await area.reconcileSend(reference, {
        kind: 'customer',
        customerId: p.account.entity_id,
      });
      expect(r).toEqual({ state: 'unknown', why: 'unreachable' });
    });

    it('a request that provably never reached Nuvion is refused in the log, so the reference is not used up', async () => {
      const p = await person(1_000_000);
      const reference = ref('never');
      const client = new NuvionClient(
        standin.settings({ operationalAccountId: book.operational.id }),
        KEY,
      );
      const real = client.post.bind(client);
      jest.spyOn(client, 'post').mockImplementationOnce(() => {
        const err = new NuvionError({
          kind: 'outcome_unknown',
          operation: 'book transfer',
          messages: ['no connection'],
          reference,
        });
        Object.assign(err, { requestNotSent: true });
        return Promise.reject(err);
      });
      const a = new NuvionBookArea(client, client.settings, store, {
        settleStepsMs: [],
      });
      const e = await failure(
        sendFrom(p, operationalBan(), 100_000, reference, a),
      );
      expect(e.kind).toBe('outcome_unknown');
      const row = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(row.status).toBe('refused');
      // Sent again under the same reference: one transfer.
      void real;
      const ok = await sendFrom(p, operationalBan(), 100_000, reference, a);
      expect(ok.amountKobo).toBe(100_000n);
      expect(book.byReference(reference)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  describe('lookups', () => {
    it('findTransactionById and findTransactionByReference place only transfers the log holds', async () => {
      expect(await area.findTransactionById('NOT-AN-ID!')).toEqual({
        state: 'unknown',
      });
      expect(
        await area.findTransactionById('01HXYZNOSUCHTRANSFER00001'),
      ).toEqual({
        state: 'unknown',
      });
      expect(await area.findTransactionByReference(ref('never-sent'))).toEqual({
        state: 'unknown',
      });
      expect(
        await area.secondaryReferenceOf({} as ProviderTransaction),
      ).toBeNull();
    });

    it('confirmMovement places a movement by a reference or an id of ours, and never calls the rest absent', async () => {
      const p = await person(1_000_000);
      const reference = ref('confirm');
      const r = await sendFrom(p, operationalBan(), 100_000, reference);
      const limits = { historyPages: 1, byIdChecks: 4 };
      const around = new Date();
      const byRef = await area.confirmMovement({
        references: [reference],
        sender: null,
        amountKobo: 100_000,
        around,
        limits,
      });
      expect(byRef).toMatchObject({
        state: 'found',
        secondaryReference: null,
        transaction: { id: r.transactionId },
      });
      const byId = await area.confirmMovement({
        references: ['nothing', r.transactionId!],
        sender: null,
        amountKobo: 100_000,
        around,
        limits,
      });
      expect(byId.state).toBe('found');
      const none = await area.confirmMovement({
        references: ['unknown-ref'],
        sender: null,
        amountKobo: 100_000,
        around,
        limits,
      });
      expect(none.state).toBe('unknown');
    });

    it('a transfer read back that is not the one we sent is refused, with the reason', async () => {
      const p = await person(1_000_000);
      const reference = ref('swapped');
      const r = await sendFrom(p, operationalBan(), 100_000, reference);
      // Nuvion's record changes under the id: another amount.
      const t = book.byId(r.transactionId!)!;
      const saved = t.amount;
      t.amount = saved + 1;
      try {
        const out = await area.reconcileSend(reference, {
          kind: 'customer',
          customerId: p.account.entity_id,
        });
        expect(out).toEqual({ state: 'unknown', why: 'unreachable' });
      } finally {
        t.amount = saved;
      }
    });
  });

  // -------------------------------------------------------------------------
  // The rules of the whole spec
  // -------------------------------------------------------------------------

  describe("WAWU's own record failing", () => {
    /** The real store, with some methods failing as a lost database connection does. */
    function flaky(failing: Set<string>): PrismaNuvionBookStore {
      return new Proxy(store, {
        get: (target, key: string) => {
          const fn = (target as unknown as Record<string, unknown>)[key];
          if (typeof fn !== 'function') return fn;
          return (...args: unknown[]) =>
            failing.has(key)
              ? Promise.reject(new Error('the database is gone'))
              : (fn as (...a: unknown[]) => unknown).apply(target, args);
        },
      });
    }
    function areaOver(s: PrismaNuvionBookStore) {
      const client = new NuvionClient(
        standin.settings({ operationalAccountId: book.operational.id }),
        KEY,
      );
      return new NuvionBookArea(client, client.settings, s, {
        settleStepsMs: [],
      });
    }

    it.each(['findPersonAccount', 'begin'])(
      'when %s fails before the send, nothing is sent and the refusal is clean (not an unknown outcome)',
      async (method) => {
        const p = await person(1_000_000);
        const e = await failure(
          sendFrom(
            p,
            operationalBan(),
            100_000,
            ref(`db-${method}`),
            areaOver(flaky(new Set([method]))),
          ),
        );
        expect(e.kind).toBe('unavailable');
        expect(e.recordMayExist).toBe(false);
        expect(book.createRequests).toHaveLength(0);
        expect(book.availableOf(p.account.id)).toBe(1_000_000);
      },
    );

    it("when only the note of Nuvion's answer fails, the receipt is still answered and the transfer is found again later", async () => {
      const p = await person(1_000_000);
      const reference = ref('db-after');
      const a = areaOver(flaky(new Set(['recordRead'])));
      const receipt = await sendFrom(
        p,
        operationalBan(),
        100_000,
        reference,
        a,
      );
      expect(receipt.amountKobo).toBe(100_000n);
      expect(book.byReference(reference)).toHaveLength(1);
      // The log is behind: no id, still `sending`.
      const behind = await prisma.nuvionBookTransfer.findUniqueOrThrow({
        where: { reference },
      });
      expect(behind).toMatchObject({ nuvionId: null, status: 'sending' });
      // The database is back: the transfer is found by its reference, and
      // sent again it is Nuvion's original.
      const found = await area.reconcileSend(
        reference,
        { kind: 'customer', customerId: p.account.entity_id },
        behind.sentAt,
      );
      expect(found).toMatchObject({ state: 'found', source: 'history' });
      const again = await sendFrom(p, operationalBan(), 100_000, reference);
      expect(again.transactionId).toBe(receipt.transactionId);
      expect(book.byReference(reference)).toHaveLength(1);
    });
  });

  describe('the adapter without its record', () => {
    it('sends nothing: not_configured', async () => {
      const client = new NuvionClient(standin.settings(), KEY);
      const bare = new NuvionBookArea(client, client.settings, undefined);
      const p = await person(1_000_000);
      const e = await failure(
        sendFrom(p, operationalBan(), 1_000, ref('bare'), bare),
      );
      expect(e.kind).toBe('not_configured');
      expect(book.createRequests).toHaveLength(0);
    });
  });

  it('no Nuvion, Fintava or wawuafrica.com host was reached', () => {
    expect(guard.violations).toEqual([]);
    expect(
      standin.seen.every((r) => r.headers['x-api-version'] === '2026-02-06'),
    ).toBe(true);
    void (null as unknown as BookMode);
  });
});
