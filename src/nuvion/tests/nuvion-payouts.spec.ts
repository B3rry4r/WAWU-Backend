import { Logger } from '@nestjs/common';
import {
  NuvionAccountsStandin,
  standinId,
} from '../../../test/nuvion/accounts-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import {
  NuvionPayoutsStandin,
  PARENT_ENTITY,
} from '../../../test/nuvion/payouts-standin';
import type {
  ProviderBankTransferInput,
  ProviderTransferReceipt,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import {
  cleanAccountName,
  NUVION_BANK_LIST_TTL_MS,
  NuvionPayoutsArea,
  payeeKey,
  readPayoutTransfer,
  transferProblem,
} from '../areas/payouts';
import {
  decideBankRetry,
  outflowProblem,
  payoutTransaction,
  reconcileBankSend,
} from '../handlers/outflows-bank';
import { NuvionClient } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';

/**
 * NUV-06 without a database: the readers, the payouts area (bank list,
 * account name check, NIP sends) and the reconciliation of a bank send
 * against the Nuvion stand-in over a real socket. No Nuvion host is
 * reached (outbound-guard.ts).
 */

const KEY = 'nv_test_sk_NUV06areaKEY0000000000000';
const NUMBER = '0690000031';
const HOLDER = 'Chidinma Okafor';

describe('NUV-06: the payouts area against the Nuvion stand-in', () => {
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  const pay = new NuvionPayoutsStandin(standin, nuv);
  let guard: OutboundGuard;
  let client: NuvionClient;
  let area: NuvionPayoutsArea;
  let provider: NuvionWalletProvider;
  let now = Date.now();
  let seq = 0;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    guard = guardOutbound();
    await standin.start();
    nuv.install();
    pay.install();
    pay.addAccountAtBank('044', NUMBER, HOLDER);
    client = new NuvionClient(
      standin.settings({
        operationalAccountId: pay.operationalAccountId,
        moneyTimeoutMs: 1_500,
      }),
      KEY,
    );
    area = new NuvionPayoutsArea(client, () => now);
    provider = new NuvionWalletProvider(client);
  });
  afterAll(async () => {
    await standin.stop();
    guard.restore();
    expect(guard.violations).toEqual([]);
  });
  beforeEach(() => {
    standin.reset();
    now = Date.now();
  });

  const ref = () => {
    seq += 1;
    return `wawu-nuv06-${Date.now().toString(36)}-${seq}`;
  };
  const person = (available = 5_000_000) => {
    const entityId = standinId('01ENT');
    const account = nuv.addAccount(entityId, {
      balance: { available, current: available, overdraft_used: 0 },
    });
    return { entityId, account };
  };
  const send = (
    entityId: string,
    over: Partial<ProviderBankTransferInput> = {},
  ): Promise<ProviderTransferReceipt> =>
    area.bankTransfer({
      from: { kind: 'customer', customerId: entityId },
      accountNumber: NUMBER,
      accountName: HOLDER,
      bankCode: '044',
      amountKobo: 250_000n,
      reference: ref(),
      narration: 'Thanks for the lesson',
      ...over,
    });
  const posts = () => standin.seen.filter((r) => r.method === 'POST');
  const postsTo = (path: string) => posts().filter((r) => r.path === path);
  const fails = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(WalletProviderError);
      return e as NuvionError;
    }
    throw new Error('expected a WalletProviderError');
  };

  // -----------------------------------------------------------------------
  // The bank list
  // -----------------------------------------------------------------------

  describe('the bank list', () => {
    it("is Nuvion's Nigerian list, asked once an hour and not once a call", async () => {
      const a = new NuvionPayoutsArea(client, () => now);
      const list = await a.listBanks();
      expect(list).toContainEqual({ code: '044', name: 'Access Bank' });
      expect(list.map((b) => b.code)).toEqual(
        expect.arrayContaining(['058', '090270', '120001', '000014']),
      );
      expect(
        standin.seen.filter((r) => r.path === '/bank-codes/NG'),
      ).toHaveLength(1);
      await a.listBanks();
      expect(
        standin.seen.filter((r) => r.path === '/bank-codes/NG'),
      ).toHaveLength(1);
      now += NUVION_BANK_LIST_TTL_MS + 1;
      await a.listBanks();
      expect(
        standin.seen.filter((r) => r.path === '/bank-codes/NG'),
      ).toHaveLength(2);
    });

    it('calls that arrive together wait for the same answer', async () => {
      const a = new NuvionPayoutsArea(client, () => now);
      await Promise.all([a.listBanks(), a.listBanks(), a.listBanks()]);
      expect(
        standin.seen.filter((r) => r.path === '/bank-codes/NG'),
      ).toHaveLength(1);
    });

    it('a failed fetch is not kept, and an empty or unreadable list is never "no banks"', async () => {
      const a = new NuvionPayoutsArea(client, () => now);
      standin.statusNext(500, {
        status: 'error',
        type: 'error_system_internal_error',
      });
      expect((await fails(a.listBanks())).kind).toBe('unavailable');
      expect(await a.listBanks()).not.toHaveLength(0);

      const saved = pay.banks;
      try {
        pay.banks = [];
        expect(
          (await fails(new NuvionPayoutsArea(client).listBanks())).kind,
        ).toBe('bad_response');
        pay.banks = [
          { bank_code: '', bank_name: 'X', swift_bic: null },
          { bank_name: 'No code' } as never,
        ];
        expect(
          (await fails(new NuvionPayoutsArea(client).listBanks())).kind,
        ).toBe('bad_response');
      } finally {
        pay.banks = saved;
      }
    });

    it('a code listed twice is kept once, with its first name', async () => {
      const saved = pay.banks;
      try {
        pay.banks = [
          { bank_code: '044', bank_name: 'Access Bank', swift_bic: null },
          { bank_code: '044', bank_name: 'Imposter Bank', swift_bic: null },
        ];
        expect(await new NuvionPayoutsArea(client).listBanks()).toEqual([
          { code: '044', name: 'Access Bank' },
        ]);
      } finally {
        pay.banks = saved;
      }
    });
  });

  // -----------------------------------------------------------------------
  // The account name check
  // -----------------------------------------------------------------------

  describe('the account name check', () => {
    it("a ten-digit account at a bank of Nuvion's list answers the holder's name", async () => {
      const r = await provider.checkAccountName({
        accountNumber: NUMBER,
        bankCode: '044',
      });
      expect(r).toEqual({
        matched: true,
        accountName: HOLDER,
        accountNumber: NUMBER,
        bankCode: '044',
        outcome: 'matched',
      });
      const lookup = standin.seen.find(
        (x) => x.path === '/counterparty-lookups',
      )!;
      expect(lookup.method).toBe('POST');
      expect(lookup.body).toEqual({
        country: 'NG',
        account_number: NUMBER,
        bank_code: '044',
      });
      expect(lookup.headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it('not found, bank not supported, bad format and several matches are each their own answer', async () => {
      const base = {
        matched: false,
        accountName: null,
        accountNumber: NUMBER,
        bankCode: '044',
      };
      // No such account at the bank (Nuvion's own 404).
      expect(
        await area.checkAccountName({
          accountNumber: '1111111111',
          bankCode: '044',
        }),
      ).toMatchObject({
        matched: false,
        outcome: 'not_found',
        accountNumber: '1111111111',
      });
      // The bank is not in Nuvion's list: nothing is asked.
      const before = standin.seen.length;
      expect(
        await area.checkAccountName({ accountNumber: NUMBER, bankCode: '999' }),
      ).toMatchObject({ matched: false, outcome: 'bank_not_supported' });
      // A number that is not ten digits, or a code no bank has: nothing is asked.
      for (const bad of [
        '069000003',
        '06900000312',
        '06900x0031',
        '',
        ' 0690000031',
      ]) {
        expect(
          await area.checkAccountName({ accountNumber: bad, bankCode: '044' }),
        ).toMatchObject({ ...base, accountNumber: bad, outcome: 'bad_format' });
      }
      expect(
        await area.checkAccountName({
          accountNumber: NUMBER,
          bankCode: '04 4',
        }),
      ).toMatchObject({ outcome: 'bad_format' });
      expect(
        standin.seen
          .slice(before)
          .filter((r) => r.path === '/counterparty-lookups'),
      ).toHaveLength(0);
      // Nuvion's own words for the same three, and several matches.
      for (const [type, outcome] of [
        ['error_resolution_format_invalid', 'bad_format'],
        ['error_resolution_bank_not_supported', 'bank_not_supported'],
        ['error_resolution_account_not_found', 'not_found'],
        ['error_resolution_multiple_matches', 'multiple_matches'],
      ] as const) {
        standin.next({
          status:
            type === 'error_resolution_account_not_found'
              ? 404
              : type === 'error_resolution_multiple_matches'
                ? 400
                : 422,
          body: { status: 'error', message: 'x', type },
        });
        // the bank list is cached by `area`, so the next request is the lookup
        expect(
          await area.checkAccountName({
            accountNumber: NUMBER,
            bankCode: '044',
          }),
        ).toMatchObject({ matched: false, accountName: null, outcome });
      }
    });

    it('a timeout, a service that is down and a cut connection are the timeout answer, not a wrong account', async () => {
      for (const type of [
        'error_resolution_timeout',
        'error_resolution_service_unavailable',
      ]) {
        pay.failNext(/counterparty-lookups/, type);
        expect(
          await area.checkAccountName({
            accountNumber: NUMBER,
            bankCode: '044',
          }),
        ).toMatchObject({
          matched: false,
          accountName: null,
          outcome: 'timeout',
        });
      }
      // Our own deadline (1.5 s) passes before Nuvion answers.
      standin.slowNext(2_500);
      expect(
        await area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' }),
      ).toMatchObject({ outcome: 'timeout' });
      // The connection is cut with no answer.
      standin.loseNext();
      expect(
        await area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' }),
      ).toMatchObject({ outcome: 'timeout' });
    });

    it('nothing is sent that moves money or makes anything, in any outcome', async () => {
      await area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' });
      await area.checkAccountName({
        accountNumber: '1111111111',
        bankCode: '044',
      });
      await area.checkAccountName({ accountNumber: 'x', bankCode: '044' });
      expect(posts().every((r) => r.path === '/counterparty-lookups')).toBe(
        true,
      );
    });

    it('a key problem, a rate limit or a server error is thrown, not an answer about the account', async () => {
      pay.failNext(
        /counterparty-lookups/,
        'error_auth_credentials_invalid',
        401,
      );
      expect(
        (
          await fails(
            area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' }),
          )
        ).kind,
      ).toBe('auth');
      standin.rateLimitNext(7);
      expect(
        (
          await fails(
            area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' }),
          )
        ).kind,
      ).toBe('rate_limited');
      pay.failNext(/counterparty-lookups/, 'error_system_internal_error', 500);
      expect(
        (
          await fails(
            area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' }),
          )
        ).kind,
      ).toBe('unavailable');
    });

    it('an answer with no name, with a blank one, or for another account is never a match', async () => {
      const ok = { account_number: NUMBER, bank_code: '044' };
      const bodies: unknown[] = [
        {},
        { ...ok },
        { ...ok, account_name: '   ' },
        { ...ok, account_name: 42 },
        { ...ok, account_name: 'X'.repeat(300) },
        {
          account_number: '2222222222',
          bank_code: '044',
          account_name: 'Someone Else',
        },
        {
          account_number: NUMBER,
          bank_code: '058',
          account_name: 'Someone Else',
        },
        null,
      ];
      for (const data of bodies) {
        standin.next({
          status: 200,
          body: { status: 'success', message: 'ok', data },
        });
        expect(
          (
            await fails(
              area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' }),
            )
          ).kind,
        ).toBe('bad_response');
      }
    });

    it("the holder's name is read from the shapes a lookup may use, one line", async () => {
      for (const data of [
        { account_holder_name: 'Chidinma   Okafor', account_number: NUMBER },
        { account_name: 'Chidinma Okafor\n', account_number: NUMBER },
        { holder_name: 'Chidinma Okafor' },
        { account: { account_name: 'Chidinma Okafor' } },
      ]) {
        standin.next({
          status: 200,
          body: { status: 'success', message: 'ok', data },
        });
        expect(
          (
            await area.checkAccountName({
              accountNumber: NUMBER,
              bankCode: '044',
            })
          ).accountName,
        ).toBe('Chidinma Okafor');
      }
      expect(cleanAccountName('A\u0000B')).toBe('A B');
      expect(cleanAccountName('   ')).toBeNull();
      expect(cleanAccountName(7)).toBeNull();
    });

    it('when the bank list cannot be read the check is not made', async () => {
      const cold = new NuvionPayoutsArea(client);
      standin.statusNext(503, {
        status: 'error',
        type: 'error_system_service_unavailable',
      });
      expect(
        (
          await fails(
            cold.checkAccountName({ accountNumber: NUMBER, bankCode: '044' }),
          )
        ).kind,
      ).toBe('unavailable');
      expect(
        standin.seen.filter((r) => r.path === '/counterparty-lookups'),
      ).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // A send
  // -----------------------------------------------------------------------

  describe('a bank send', () => {
    it('makes the payee once, then the transfer under our reference, and answers what Nuvion took', async () => {
      const { entityId, account } = person();
      const reference = ref();
      standin.reset();
      const r = await send(entityId, { reference });
      expect(r).toMatchObject({
        ourReference: reference,
        providerReference: reference,
        amountKobo: 250_000n,
        feeKobo: BigInt(pay.fee),
        totalKobo: 250_000n + BigInt(pay.fee),
      });
      expect(r.transactionId).toMatch(/^01TRF/);
      expect(r.payee?.counterpartyId).toMatch(/^01CPY/);
      expect(r.payee?.paymentDetailId).toMatch(/^01PDT/);

      expect(pay.counterpartyRequests).toHaveLength(1);
      expect(pay.counterpartyRequests[0]).toMatchObject({
        type: 'individual',
        entity_id: entityId,
        profile: {
          first_name: 'Chidinma',
          last_name: 'Okafor',
          relationship: 'vendor',
        },
      });
      expect(pay.paymentDetailRequests.at(-1)).toMatchObject({
        payment_method: 'bank-transfer',
        currency: 'NGN',
        country: 'NG',
        account_holder_name: HOLDER,
        entity_id: entityId,
        counterparty_id: r.payee?.counterpartyId,
        bank_code: '044',
        account_number: NUMBER,
        bank_name: 'Access Bank',
      });
      expect(pay.transferRequests.at(-1)).toEqual({
        account_id: account.id,
        payment_detail_id: r.payee?.paymentDetailId,
        counterparty_id: r.payee?.counterpartyId,
        amount: 250_000,
        currency: 'NGN',
        narration: 'Thanks for the lesson',
        payment_type: 'bank-transfer',
        unique_reference: reference,
        entity_id: entityId,
      });
      // Money moves only at the transfer: the payee calls came first.
      const order = standin.seen
        .filter((x) => x.method === 'POST')
        .map((x) => x.path);
      expect(order).toEqual([
        '/counterparties',
        '/payment-details',
        '/transfers',
      ]);
      // The balance is Nuvion's: amount and fee left `available`.
      expect(Number(account.balance.available)).toBe(
        5_000_000 - 250_000 - pay.fee,
      );
    });

    it('the same reference twice is one transfer, and the second answers the original', async () => {
      const { entityId, account } = person();
      const reference = ref();
      const a = await send(entityId, { reference });
      const b = await send(entityId, { reference, payee: a.payee });
      expect(b.transactionId).toBe(a.transactionId);
      expect(pay.byReference(reference)).toHaveLength(1);
      expect(Number(account.balance.available)).toBe(
        5_000_000 - 250_000 - pay.fee,
      );
    });

    it('two sends at once under one reference are one transfer', async () => {
      const { entityId, account } = person();
      const reference = ref();
      const [a, b, c] = await Promise.all([
        send(entityId, { reference }),
        send(entityId, { reference }),
        send(entityId, { reference }),
      ]);
      expect(
        new Set([a.transactionId, b.transactionId, c.transactionId]).size,
      ).toBe(1);
      expect(pay.byReference(reference)).toHaveLength(1);
      expect(Number(account.balance.available)).toBe(
        5_000_000 - 250_000 - pay.fee,
      );
    });

    it('a second send to the same account reuses its counterparty and payment detail', async () => {
      const { entityId } = person();
      const first = await send(entityId);
      standin.reset();
      const counterparties = pay.counterpartyRequests.length;
      const details = pay.paymentDetailRequests.length;
      const second = await send(entityId, { payee: first.payee });
      expect(second.payee).toEqual(first.payee);
      expect(pay.counterpartyRequests).toHaveLength(counterparties);
      expect(pay.paymentDetailRequests).toHaveLength(details);
      // Only the kept payment detail is read to confirm it is this account.
      expect(postsTo('/transfers')).toHaveLength(1);
      expect(postsTo('/counterparties')).toHaveLength(0);
      expect(postsTo('/payment-details')).toHaveLength(0);
    });

    it('with the ids lost, the counterparty and payment detail are found again, not made twice', async () => {
      const { entityId } = person();
      const first = await send(entityId);
      const counterparties = pay.counterparties.size;
      const details = pay.paymentDetails.size;
      const second = await send(entityId);
      expect(second.payee).toEqual(first.payee);
      expect(pay.counterparties.size).toBe(counterparties);
      expect(pay.paymentDetails.size).toBe(details);
    });

    it('kept ids that are not this account are never used', async () => {
      const { entityId } = person();
      const other = await send(entityId, {
        accountNumber: '0123456789',
        accountName: 'Someone Else',
      });
      const mine = await send(entityId, { payee: other.payee });
      expect(mine.payee).not.toEqual(other.payee);
      expect(pay.transferRequests.at(-1)).toMatchObject({
        payment_detail_id: mine.payee?.paymentDetailId,
      });
      // Ids Nuvion does not know at all are replaced too.
      const stale = await send(entityId, {
        payee: {
          counterpartyId: standinId('01CPY'),
          paymentDetailId: standinId('01PDT'),
        },
      });
      expect(stale.payee?.paymentDetailId).toBe(mine.payee?.paymentDetailId);
    });

    it("WAWU's own payout leaves the operational account, with no entity named", async () => {
      standin.reset();
      const reference = ref();
      const r = await area.bankTransfer({
        from: { kind: 'merchant' },
        accountNumber: NUMBER,
        accountName: HOLDER,
        bankCode: '044',
        amountKobo: 1_000_000n,
        reference,
      });
      const body = pay.transferRequests.at(-1) as Record<string, unknown>;
      expect(body.account_id).toBe(pay.operationalAccountId);
      expect('entity_id' in body).toBe(false);
      expect('entity_id' in (pay.counterpartyRequests.at(-1) as object)).toBe(
        false,
      );
      expect(pay.transfer(r.transactionId!)).toMatchObject({
        entity_id: PARENT_ENTITY,
        account_id: pay.operationalAccountId,
        unique_reference: reference,
      });
      // The narration is optional.
      expect('narration' in body).toBe(false);
    });

    it('a request that is not a send is refused before anything is sent', async () => {
      const { entityId } = person();
      const bad: Array<Partial<ProviderBankTransferInput>> = [
        { reference: '' },
        { reference: 'x'.repeat(65) },
        { reference: 'has space' },
        { reference: 'a/b' },
        { amountKobo: 0n },
        { amountKobo: -5n },
        { amountKobo: BigInt(Number.MAX_SAFE_INTEGER) + 2n },
        { accountNumber: '069000003' },
        { accountNumber: '06900000311' },
        { accountName: undefined },
        { accountName: '   ' },
        { bankCode: '999' },
      ];
      for (const over of bad) {
        standin.reset();
        const e = await fails(send(entityId, over));
        expect(e.kind).toBe('validation');
        expect(e.recordMayExist).toBe(false);
        expect(e.requestNotSent).toBe(false);
        expect(posts()).toHaveLength(0);
      }
    });

    it('a narration past 100 characters is cut to the 100 Nuvion takes', async () => {
      const { entityId } = person();
      await send(entityId, { narration: 'n'.repeat(180) });
      expect(
        (pay.transferRequests.at(-1) as { narration: string }).narration,
      ).toHaveLength(100);
    });

    it('a person with no naira account, or two, is not a sender', async () => {
      const none = standinId('01ENT');
      expect((await fails(send(none))).kind).toBe('not_found');
      const two = person();
      nuv.addAccount(two.entityId);
      expect((await fails(send(two.entityId))).kind).toBe('refused');
      const dollars = standinId('01ENT');
      nuv.addAccount(dollars, { currency: 'USD' });
      expect((await fails(send(dollars))).kind).toBe('not_found');
      expect(postsTo('/transfers')).toHaveLength(0);
      expect((await fails(send('../x'))).kind).toBe('validation');
    });

    it('not enough money is a refusal that moved nothing, and the payee made stays', async () => {
      const { entityId, account } = person(100_000);
      standin.reset();
      const sent = pay.transferRequests.length;
      const e = await fails(send(entityId, { amountKobo: 250_000n }));
      expect(e.kind).toBe('insufficient_funds');
      expect(e.recordMayExist).toBe(false);
      expect(Number(account.balance.available)).toBe(100_000);
      expect(pay.transferRequests).toHaveLength(sent + 1);
    });

    it('a failure before the transfer is plain: nothing sent, asked again under the same reference', async () => {
      const { entityId } = person();
      const cases: Array<[string, () => void]> = [
        [
          'finding the account',
          () =>
            standin.statusNext(503, {
              status: 'error',
              type: 'error_system_service_unavailable',
            }),
        ],
        [
          'finding the counterparty',
          () =>
            pay.failNext(
              /^\/counterparties$/,
              'error_system_internal_error',
              500,
            ),
        ],
        [
          'making the counterparty',
          () =>
            pay.answerNext('POST', /^\/counterparties$/, {
              status: 500,
              body: {
                status: 'error',
                type: 'error_system_internal_error',
                message: 'x',
              },
            }),
        ],
        [
          'finding the payment detail',
          () =>
            pay.failNext(
              /payment-details$/,
              'error_system_internal_error',
              500,
            ),
        ],
        [
          'making the payment detail',
          () =>
            pay.answerNext('POST', /^\/payment-details$/, {
              status: 504,
              body: {
                status: 'error',
                type: 'error_system_timeout',
                message: 'x',
              },
            }),
        ],
      ];
      let n = 0;
      for (const [what, arm] of cases) {
        n += 1;
        const number = `012345678${n}`;
        standin.reset();
        const sent = pay.transferRequests.length;
        arm();
        const e = await fails(send(entityId, { accountNumber: number }));
        expect([what, e.kind]).toEqual([what, 'unavailable']);
        expect(e.recordMayExist).toBe(false);
        expect(e.requestNotSent).toBe(true);
        expect(pay.transferRequests).toHaveLength(sent);
        // The same send goes through on the next ask.
        await send(entityId, { accountNumber: number });
        expect(pay.transferRequests).toHaveLength(sent + 1);
      }
    });

    it('a refusal before the transfer stays the refusal it is', async () => {
      const { entityId } = person();
      pay.answerNext('POST', /^\/counterparties$/, {
        status: 422,
        body: {
          status: 'error',
          type: 'error_counterparty_sanctions_check_failed',
          message: 'x',
        },
      });
      const e = await fails(send(entityId, { accountNumber: '0123456700' }));
      expect(e.kind).toBe('refused');
      expect(e.recordMayExist).toBe(false);
      expect(e.requestNotSent).toBe(false);
      pay.failNext(/^\/counterparties$/, 'error_auth_credentials_invalid', 401);
      expect(
        (await fails(send(entityId, { accountNumber: '0123456701' }))).kind,
      ).toBe('auth');
    });

    it('a counterparty made whose answer was lost is adopted, not made twice', async () => {
      const { entityId } = person();
      const number = '0123456781';
      standin.reset();
      pay.loseAnswerOn('POST', /^\/counterparties$/);
      const r = await send(entityId, { accountNumber: number });
      const mine = [...pay.counterparties.values()].filter(
        (c) =>
          c.entity_id === entityId &&
          c.meta.wawu_payee === payeeKey(entityId, '044', number),
      );
      expect(mine).toHaveLength(1);
      expect(
        pay.counterpartyRequests.filter(
          (b) =>
            (b as { entity_id?: string }).entity_id === entityId &&
            (b as { meta: { wawu_payee: string } }).meta.wawu_payee ===
              payeeKey(entityId, '044', number),
        ),
      ).toHaveLength(1);
      expect(r.payee?.counterpartyId).toBe(mine[0].id);
    });

    it('a payment detail made whose answer was lost is adopted, not made twice', async () => {
      const { entityId } = person();
      const number = '0123456782';
      standin.reset();
      pay.loseAnswerOn('POST', /^\/payment-details$/);
      const r = await send(entityId, { accountNumber: number });
      const mine = [...pay.paymentDetails.values()].filter(
        (d) => d.entity_id === entityId && d.account_number === number,
      );
      expect(mine).toHaveLength(1);
      expect(r.payee?.paymentDetailId).toBe(mine[0].id);
    });

    it('a lost answer on the transfer is an unknown outcome, found again by the reference, never sent again', async () => {
      const { entityId } = person();
      const reference = ref();
      pay.loseAnswerNext();
      const e = await fails(send(entityId, { reference }));
      expect(e.kind).toBe('outcome_unknown');
      expect(e.recordMayExist).toBe(true);
      expect(e.requestNotSent).toBe(false);
      expect(e.reference).toBe(reference);
      // The transfer exists, once.
      expect(pay.byReference(reference)).toHaveLength(1);
      const sent = pay.transferRequests.length;
      // Found again by its reference, with nothing sent.
      const r = await reconcileBankSend(
        area,
        reference,
        { kind: 'customer', customerId: entityId },
        new Date(Date.now() - 60_000),
      );
      expect(r.state).toBe('found');
      expect(r.state === 'found' && r.transaction.ourReference).toBe(reference);
      expect(r.state === 'found' && r.transaction.outcome).toBe('pending');
      expect(pay.transferRequests).toHaveLength(sent);
    });

    it('a send cut before it reached Nuvion is absent only once the money timeout has passed', async () => {
      const { entityId } = person();
      const reference = ref();
      pay.loseRequestNext();
      const e = await fails(send(entityId, { reference }));
      expect(e.kind).toBe('outcome_unknown');
      expect(pay.byReference(reference)).toHaveLength(0);
      const holder = { kind: 'customer', customerId: entityId } as const;
      // Just now: it may still be on its way.
      expect(
        await reconcileBankSend(area, reference, holder, new Date()),
      ).toEqual({
        state: 'unknown',
        why: 'too_soon',
      });
      // Past the money timeout, the complete list has no row.
      expect(
        await reconcileBankSend(
          area,
          reference,
          holder,
          new Date(Date.now() - 10 * 60_000),
        ),
      ).toEqual({ state: 'absent' });
    });

    it('a request that provably never left says so, and nothing is recorded', async () => {
      const closed = new NuvionClient(
        standin.settings({ baseUrl: 'http://127.0.0.1:9' }),
        KEY,
      );
      const a = new NuvionPayoutsArea(closed);
      const e = await fails(
        a.bankTransfer({
          from: { kind: 'merchant' },
          accountNumber: NUMBER,
          accountName: HOLDER,
          bankCode: '044',
          amountKobo: 100n,
          reference: ref(),
        }),
      );
      expect(e.requestNotSent).toBe(true);
      expect(e.recordMayExist).toBe(false);
    });

    it('a transfer still being processed under the reference is an unknown outcome', async () => {
      const { entityId } = person();
      const reference = ref();
      const first = await send(entityId, { reference });
      pay.processingNext(reference);
      const e = await fails(send(entityId, { reference, payee: first.payee }));
      expect(e.kind).toBe('outcome_unknown');
      expect(e.recordMayExist).toBe(true);
      expect(pay.byReference(reference)).toHaveLength(1);
    });

    it('a conflict for a repeated reference answers the original when it is this very send', async () => {
      const { entityId } = person();
      const reference = ref();
      const first = await send(entityId, { reference });
      pay.failNext(/\/transfers$/, 'error_duplicate_resource', 409);
      const again = await send(entityId, { reference, payee: first.payee });
      expect(again.transactionId).toBe(first.transactionId);
      expect(pay.byReference(reference)).toHaveLength(1);
    });

    it('a reference used for another send, or one that failed, is duplicate_reference, never a receipt', async () => {
      const { entityId } = person();
      const reference = ref();
      const first = await send(entityId, { reference, amountKobo: 100_000n });
      // The same reference for another amount: Nuvion returns the original.
      const other = await fails(
        send(entityId, { reference, amountKobo: 200_000n, payee: first.payee }),
      );
      expect(other.kind).toBe('duplicate_reference');
      expect(other.recordMayExist).toBe(true);
      // The original fails: the reference is used up.
      pay.settle(first.transactionId!, 'failed');
      const used = await fails(
        send(entityId, { reference, amountKobo: 100_000n, payee: first.payee }),
      );
      expect(used.kind).toBe('duplicate_reference');
      expect(pay.byReference(reference)).toHaveLength(1);
      // A new reference sends it again.
      const fresh = await send(entityId, {
        amountKobo: 100_000n,
        payee: first.payee,
      });
      expect(fresh.transactionId).not.toBe(first.transactionId);
    });

    it('a 2xx without the transfer proves nothing: not_confirmed, the money may have moved', async () => {
      const { entityId } = person();
      const reference = ref();
      pay.answerNext('POST', /^\/transfers$/, {
        status: 200,
        body: { status: 'success', message: 'ok', data: { id: 'x' } },
      });
      const e = await fails(send(entityId, { reference }));
      expect(e.kind).toBe('not_confirmed');
      expect(e.recordMayExist).toBe(true);
    });

    it('a figure that is not whole kobo in the transfer answered is refused', () => {
      for (const t of [
        { amount: 100.5 },
        { amount: '100' },
        { applicable_fee: -1 },
        { applicable_fee: 0.5 },
      ]) {
        expect(
          readPayoutTransfer({
            id: standinId('01TRF'),
            amount: 100,
            currency: 'NGN',
            status: 'pending',
            ...t,
          }).ok,
        ).toBe(false);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Pure readers and advice
  // -----------------------------------------------------------------------

  describe('readers and advice', () => {
    const transfer = (over: Record<string, unknown> = {}) => {
      const r = readPayoutTransfer({
        id: standinId('01TRF'),
        amount: 250_000,
        currency: 'NGN',
        unique_reference: 'r1',
        counterparty_id: 'CPY1',
        payment_detail_id: 'PDT1',
        account_id: 'ACC1',
        entity_id: 'ENT1',
        status: 'successful',
        status_reason: 'processing_complete',
        type: 'outflow',
        payment_type: 'bank-transfer',
        applicable_fee: 2345,
        created: 1760434049154,
        ...over,
      });
      if (!r.ok) throw new Error(r.why);
      return r.transfer;
    };

    it('a transfer is read with its payment detail, its reason (masked) and a reversal source', () => {
      const t = transfer({
        status_reason: 'sent to 0690000031 ok',
        meta: { source_payment_id: 'SRC1' },
      });
      expect(t).toMatchObject({
        paymentDetailId: 'PDT1',
        feeStated: true,
        statusReason: 'sent to ******0031 ok',
        sourcePaymentId: 'SRC1',
      });
      expect(transfer({ applicable_fee: undefined }).feeStated).toBe(false);
      expect(
        transfer({ payment_detail_id: '../x' }).paymentDetailId,
      ).toBeNull();
    });

    it('the seam transaction carries the fee only when the record states it', () => {
      const t = payoutTransaction(transfer());
      expect(t).toMatchObject({
        amountKobo: 250_000n,
        outcome: 'completed',
        ourReference: 'r1',
        providerReference: 'r1',
        secondaryReference: null,
        feeKobo: 2345n,
      });
      expect(
        payoutTransaction(transfer({ applicable_fee: undefined })).feeKobo,
      ).toBeNull();
      for (const [status, outcome] of [
        ['pending', 'pending'],
        ['processing', 'pending'],
        ['failed', 'failed'],
        ['reversed', 'reversed'],
        ['settled', null],
      ] as const) {
        expect(payoutTransaction(transfer({ status })).outcome).toBe(outcome);
      }
    });

    it('a repeated reference must be the same send', () => {
      const expect_ = {
        reference: 'r1',
        amountKobo: 250_000,
        source: { accountId: 'ACC1', entityId: 'ENT1' },
        payee: { counterpartyId: 'CPY1', paymentDetailId: 'PDT1' },
      };
      expect(transferProblem(transfer(), expect_)).toBeNull();
      expect(
        transferProblem(transfer({ status: 'pending' }), expect_),
      ).toBeNull();
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ unique_reference: 'r2' }, /another reference/],
        [{ amount: 1 }, /names a transfer of 1 kobo/],
        [{ currency: 'USD' }, /USD/],
        [{ type: 'inflow' }, /not money out/],
        [{ payment_type: 'book-transfer' }, /not a bank transfer/],
        [{ account_id: 'ACC2' }, /another account/],
        [{ counterparty_id: 'CPY2' }, /another payee/],
        [{ payment_detail_id: 'PDT2' }, /another account/],
        [{ status: 'failed' }, /already failed/],
        [{ status: 'reversed' }, /been reversed/],
      ];
      for (const [over, why] of cases) {
        expect(transferProblem(transfer(over), expect_)).toMatch(why);
      }
    });

    it('a delivery is the send it names only when Nuvion records the same one', () => {
      const delivered = transfer();
      expect(
        outflowProblem(transfer({ id: delivered.id }), { delivered }),
      ).toBeNull();
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ id: standinId('01TRF') }, /another transfer/],
        [{ account_id: 'ACC2' }, /another account/],
        [{ entity_id: 'ENT2' }, /another entity/],
        [{ currency: 'USD' }, /not naira/],
        [{ type: 'inflow' }, /not money out/],
        [{ payment_type: 'book-transfer' }, /not a bank transfer/],
        [{ amount: 1 }, /says 1 kobo/],
        [{ applicable_fee: 9 }, /fee 9/],
        [{ unique_reference: 'other' }, /another reference/],
      ];
      for (const [over, why] of cases) {
        expect(
          outflowProblem(transfer({ id: delivered.id, ...over }), {
            delivered,
          }),
        ).toMatch(why);
      }
    });

    it('the advice never resends under a new reference for a lost answer', () => {
      const clock = {
        attemptedAt: new Date('2026-10-11T10:00:00Z'),
        now: new Date('2026-10-11T10:30:00Z'),
        resendAfterMs: 10 * 60_000,
      };
      const found = (status: string) => ({
        state: 'found' as const,
        source: 'history' as const,
        transaction: payoutTransaction(transfer({ status })),
      });
      expect(
        decideBankRetry('bank_transfer', found('successful'), clock).action,
      ).toBe('settled');
      expect(
        decideBankRetry('bank_transfer', found('reversed'), clock).action,
      ).toBe('settled');
      expect(decideBankRetry('bank_transfer', found('pending'), clock)).toEqual(
        { action: 'wait', why: 'pending' },
      );
      expect(
        decideBankRetry('bank_transfer', found('processing'), clock),
      ).toEqual({ action: 'wait', why: 'pending' });
      // Only a record that says failed lets a new reference be used.
      expect(
        decideBankRetry('bank_transfer', found('failed'), clock),
      ).toMatchObject({
        action: 'resend_new_reference',
        why: 'failed',
      });
      // Silence is never a reason to send: absent waits, now or later.
      expect(
        decideBankRetry('bank_transfer', { state: 'absent' }, clock),
      ).toEqual({ action: 'wait', why: 'empty_lookup' });
      expect(
        decideBankRetry(
          'bank_transfer',
          { state: 'absent' },
          { ...clock, now: new Date('2026-10-11T10:05:00Z') },
        ),
      ).toEqual({ action: 'wait', why: 'too_soon' });
      for (const why of [
        'empty_lookup',
        'unreachable',
        'unrecognised',
        'too_soon',
        'history_incomplete',
      ] as const) {
        expect(
          decideBankRetry('bank_transfer', { state: 'unknown', why }, clock),
        ).toEqual({ action: 'wait', why });
      }
    });

    it('a payee marker holds no account number in the clear and differs by sender, bank and account', () => {
      const k = payeeKey('ENT1', '044', NUMBER);
      expect(k).toMatch(/^[0-9a-f]{40}$/);
      expect(k).not.toContain(NUMBER);
      expect(payeeKey('ENT1', '044', NUMBER)).toBe(k);
      expect(payeeKey('ENT2', '044', NUMBER)).not.toBe(k);
      expect(payeeKey('ENT1', '058', NUMBER)).not.toBe(k);
      expect(payeeKey(null, '044', NUMBER)).not.toBe(k);
    });
  });

  // -----------------------------------------------------------------------
  // Finding a send again
  // -----------------------------------------------------------------------

  describe('reconciling a bank send', () => {
    it('finds it among many, on a later page, by its reference only', async () => {
      const { entityId } = person(900_000_000);
      const reference = ref();
      await send(entityId, { reference });
      for (let i = 0; i < 12; i += 1) await send(entityId);
      const r = await area.findTransferByReference(
        { entityId, accountId: null },
        reference,
        null,
        { maxPages: 20 },
      );
      expect(r.state).toBe('found');
      // Another person's transfers are never searched.
      const stranger = person();
      expect(
        (
          await area.findTransferByReference(
            { entityId: stranger.entityId, accountId: null },
            reference,
            null,
          )
        ).state,
      ).toBe('absent');
    });

    it('a walk cut short by the page cap is incomplete, never absent', async () => {
      const { entityId } = person(900_000_000);
      for (let i = 0; i < 4; i += 1) await send(entityId);
      const cap = await area.findTransferByReference(
        { entityId, accountId: null },
        'no-such-reference',
        null,
        { maxPages: 1 },
      );
      // 4 transfers fit one page of 100: the list ends, so it is complete.
      expect(cap).toEqual({ state: 'absent', complete: true });
      const many = person(900_000_000);
      const bigSend = () => send(many.entityId, { amountKobo: 1_000n });
      for (let i = 0; i < 3; i += 1) await bigSend();
      // 150 rows would need two pages; one page then stops.
      for (let i = 0; i < 105; i += 1) {
        const id = standinId('01TRF');
        nuv.transfers.set(id, {
          id,
          entity_id: many.entityId,
          account_id: many.account.id,
          amount: 1,
          currency: 'NGN',
          unique_reference: `filler-${i}`,
          status: 'successful',
          type: 'outflow',
          payment_type: 'bank-transfer',
          applicable_fee: 0,
          created: Date.now() - 1_000_000 - i,
        });
      }
      const short = await area.findTransferByReference(
        { entityId: many.entityId, accountId: null },
        'no-such-reference',
        null,
        { maxPages: 1 },
      );
      expect(short).toEqual({ state: 'incomplete' });
      const holder = { kind: 'customer', customerId: many.entityId } as const;
      const r = await reconcileBankSend(area, 'no-such-reference', holder);
      // Unbounded in time, twenty pages cover it: complete and absent.
      expect(r).toEqual({ state: 'absent' });
    });

    it('stops at the first row older than the send when Nuvion lists newest first', async () => {
      const { entityId } = person(900_000_000);
      const old = await send(entityId);
      pay.age(old.transactionId!, 3 * 60 * 60_000);
      standin.reset();
      const reference = ref();
      const holder = { kind: 'customer', customerId: entityId } as const;
      const r = await reconcileBankSend(
        area,
        reference,
        holder,
        new Date(Date.now() - 20 * 60_000),
      );
      expect(r).toEqual({ state: 'absent' });
      // One page was read and the walk stopped at the old row.
      expect(standin.seen.filter((x) => x.path === '/transfers')).toHaveLength(
        1,
      );
    });

    it('an unreadable list, the key and a bad reference are each handled as what they are', async () => {
      const { entityId } = person();
      const holder = { kind: 'customer', customerId: entityId } as const;
      pay.failNext(/\/transfers$/, 'error_system_internal_error', 500);
      expect(await reconcileBankSend(area, ref(), holder)).toEqual({
        state: 'unknown',
        why: 'unreachable',
      });
      pay.failNext(/\/transfers$/, 'error_auth_credentials_invalid', 401);
      await expect(
        reconcileBankSend(area, ref(), holder),
      ).rejects.toMatchObject({ kind: 'auth' });
      expect(await reconcileBankSend(area, 'has space', holder)).toEqual({
        state: 'unknown',
        why: 'unrecognised',
      });
      expect(
        await reconcileBankSend(area, ref(), {
          kind: 'customer',
          customerId: '../x',
        }),
      ).toEqual({
        state: 'unknown',
        why: 'unrecognised',
      });
    });

    it("WAWU's own sends are looked for on the operational account", async () => {
      const reference = ref();
      await area.bankTransfer({
        from: { kind: 'merchant' },
        accountNumber: NUMBER,
        accountName: HOLDER,
        bankCode: '044',
        amountKobo: 5_000n,
        reference,
      });
      standin.reset();
      const r = await reconcileBankSend(
        area,
        reference,
        { kind: 'merchant' },
        new Date(Date.now() - 60_000),
      );
      expect(r.state).toBe('found');
      const list = standin.seen.find((x) => x.path === '/transfers')!;
      expect(list.query.account_id).toBe(pay.operationalAccountId);
      expect(list.query.entity_id).toBeUndefined();
    });

    it('reads a transfer back with the entity named, and a payment detail for the other side', async () => {
      const { entityId } = person();
      const sent = await send(entityId);
      standin.reset();
      const t = await area.getTransfer(entityId, sent.transactionId!);
      expect(t).toMatchObject({
        id: sent.transactionId,
        status: 'pending',
        amountKobo: 250_000,
      });
      expect(standin.seen[0].query).toEqual({ entity_id: entityId });
      expect(
        await area.getPaymentDetail(entityId, sent.payee!.paymentDetailId!),
      ).toMatchObject({
        bankName: 'Access Bank',
        bankCode: '044',
        accountNumber: NUMBER,
        accountName: HOLDER,
        counterpartyId: sent.payee!.counterpartyId,
      });
      expect(
        (await fails(area.getTransfer(entityId, standinId('01TRF')))).kind,
      ).toBe('not_found');
      expect((await fails(area.getTransfer('../x', 'abc'))).kind).toBe(
        'validation',
      );
      expect(await area.getPaymentDetail(entityId, '../x')).toBeNull();
    });

    it("the operational account's number is its nuvion_ban", async () => {
      expect(await area.operationalBan()).toBe('NVXOPS0001');
    });
  });

  it('every request carries the bearer key and the pinned version, and none leaves this machine', async () => {
    const { entityId } = person();
    standin.reset();
    await send(entityId);
    for (const r of standin.seen) {
      expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(r.headers['x-api-version']).toBe('2026-02-06');
    }
  });
});
