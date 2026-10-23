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
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { NuvionPayoutsArea, payeeKey } from '../areas/payouts';
import { NuvionClient } from '../nuvion-client';
import type { NuvionError } from '../nuvion-error';

/**
 * FIX-98 fix 1: the counterparty's address carries `state_or_province` and
 * `postal_code` as well as line 1, city and country. Nuvion DEV took a
 * counterparty without them (201) and then refused the transfer to it: 422
 * "counterparty.address.state: The 'counterparty.address.state' field is
 * required" and the same for `counterparty.address.postal_code` (request
 * 01M5MJABG4WBBV51HMQC8YZ52C, 23 Oct 2026, a bank send from a funded wallet
 * to bank 044, the account ending 0031). The stand-in refuses that transfer
 * with dev's 422, so these fail on a build that sends the old address.
 * The sending side's entity holds `address.state` and `address.postal_code`
 * (dev's entity answer); nothing here is ever made up.
 */

const KEY = 'nv_test_sk_FIX98stateKEY0000000000000';
const NUMBER = '0690000031';
const HOLDER = 'Forrest Green';

const entityAddress = (over: Record<string, unknown> = {}) => ({
  id: standinId('01ADR'),
  line_1: '11 Opebi Road',
  city: 'Victoria Island',
  state: 'Lagos',
  postal_code: '101241',
  country_code: 'NG',
  label: 'registered_address',
  ...over,
});

describe('FIX-98: the counterparty carries the sender state and postal code', () => {
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  const pay = new NuvionPayoutsStandin(standin, nuv);
  let guard: OutboundGuard;
  let client: NuvionClient;
  let area: NuvionPayoutsArea;
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
    area = new NuvionPayoutsArea(client);
  });
  afterAll(async () => {
    await standin.stop();
    guard.restore();
    expect(guard.violations).toEqual([]);
  });
  beforeEach(() => {
    standin.reset();
    pay.contacts.clear();
    pay.counterparties.clear();
    pay.paymentDetails.clear();
    pay.counterpartyRequests.length = 0;
    pay.paymentDetailRequests.length = 0;
    pay.transferRequests.length = 0;
  });

  const ref = () => {
    seq += 1;
    return `wawu-fix98-${Date.now().toString(36)}-${seq}`;
  };
  const person = (address?: Record<string, unknown> | null) => {
    const entityId = standinId('01ENT');
    nuv.addAccount(entityId, {
      balance: { available: 5_000_000, current: 5_000_000, overdraft_used: 0 },
    });
    if (address !== undefined) pay.contacts.set(entityId, { address });
    return entityId;
  };
  const send = (entityId: string | null) =>
    area.bankTransfer({
      from:
        entityId === null
          ? { kind: 'merchant' }
          : { kind: 'customer', customerId: entityId },
      accountNumber: NUMBER,
      accountName: HOLDER,
      bankCode: '044',
      amountKobo: 250_000n,
      reference: ref(),
    });
  const fails = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(WalletProviderError);
      return e as NuvionError;
    }
    throw new Error('expected a WalletProviderError');
  };
  const postsTo = (path: string) =>
    standin.seen.filter((r) => r.method === 'POST' && r.path === path);

  it("a person's send gives the counterparty their entity's state and postal code, and Nuvion takes the transfer", async () => {
    const entityId = person(entityAddress());
    const r = await send(entityId);
    expect(r.transactionId).toMatch(/^01TRF/);
    expect(pay.counterpartyRequests).toHaveLength(1);
    expect(pay.counterpartyRequests[0]).toMatchObject({
      entity_id: entityId,
      profile: {
        address: {
          line1: '11 Opebi Road',
          city: 'Victoria Island',
          state_or_province: 'Lagos',
          postal_code: '101241',
          country: 'NG',
        },
      },
    });
    expect(postsTo('/transfers')).toHaveLength(1);
  });

  it("WAWU's own send gives the operational account's entity state and postal code", async () => {
    pay.contacts.set(PARENT_ENTITY, {
      address: entityAddress({ state: 'Abuja', postal_code: '900001' }),
    });
    const r = await send(null);
    expect(r.transactionId).toMatch(/^01TRF/);
    expect(pay.counterpartyRequests[0]).toMatchObject({
      profile: {
        address: { state_or_province: 'Abuja', postal_code: '900001' },
      },
    });
  });

  /** A counterparty as the build before FIX-98 made it, with its payment detail. */
  const earlierBuildPayee = async (entityId: string) => {
    const op = { name: 'spec counterparty', call: 'write' } as const;
    const cp = await client.post<{ id: string }>(op, '/counterparties', {
      type: 'individual',
      entity_id: entityId,
      profile: {
        first_name: 'Forrest',
        last_name: 'Green',
        relationship: 'vendor',
        email: 'sender@example.test',
        address: {
          line1: '11 Opebi Road',
          city: 'Victoria Island',
          country: 'NG',
        },
      },
      meta: { wawu_payee: payeeKey(entityId, '044', NUMBER) },
    });
    const pd = await client.post<{ id: string }>(op, '/payment-details', {
      entity_id: entityId,
      counterparty_id: cp.data.id,
      payment_method: 'bank-transfer',
      currency: 'NGN',
      country: 'NG',
      account_holder_name: HOLDER,
      bank_code: '044',
      bank_name: 'Access Bank',
      account_number: NUMBER,
    });
    return { counterpartyId: cp.data.id, paymentDetailId: pd.data.id };
  };

  it('the stand-in refuses a transfer to a counterparty without them, with dev 422', async () => {
    const entityId = person(entityAddress());
    const kept = await earlierBuildPayee(entityId);
    const account = [...nuv.accounts.values()].find(
      (a) => a.entity_id === entityId,
    )!;
    const op = { name: 'spec transfer', call: 'write' } as const;
    const e = await fails(
      client.post(op, '/transfers', {
        entity_id: entityId,
        account_id: account.id,
        counterparty_id: kept.counterpartyId,
        payment_detail_id: kept.paymentDetailId,
        amount: 250_000,
        currency: 'NGN',
        payment_type: 'bank-transfer',
        unique_reference: ref(),
        narration: 'spec',
      }),
    );
    expect(e.kind).toBe('validation');
    expect(e.messages.join(' ')).toContain('counterparty.address.state');
    expect(e.messages.join(' ')).toContain('counterparty.address.postal_code');
  });

  it('kept payee ids whose counterparty lacks them are not used: a complete counterparty is made and Nuvion takes the transfer (round 2)', async () => {
    const entityId = person(entityAddress());
    const kept = await earlierBuildPayee(entityId);
    pay.counterpartyRequests.length = 0;
    const r = await area.bankTransfer({
      from: { kind: 'customer', customerId: entityId },
      accountNumber: NUMBER,
      accountName: HOLDER,
      bankCode: '044',
      amountKobo: 250_000n,
      reference: ref(),
      payee: kept,
    });
    expect(r.transactionId).toMatch(/^01TRF/);
    expect(pay.counterpartyRequests).toHaveLength(1);
    expect(r.payee?.counterpartyId).not.toBe(kept.counterpartyId);
    expect(pay.counterpartyRequests[0]).toMatchObject({
      profile: {
        address: { state_or_province: 'Lagos', postal_code: '101241' },
      },
    });
  });

  it('kept payee ids whose counterparty has them are reused: no counterparty is made', async () => {
    const entityId = person(entityAddress());
    const first = await send(entityId);
    pay.counterpartyRequests.length = 0;
    const again = await area.bankTransfer({
      from: { kind: 'customer', customerId: entityId },
      accountNumber: NUMBER,
      accountName: HOLDER,
      bankCode: '044',
      amountKobo: 100_000n,
      reference: ref(),
      payee: first.payee,
    });
    expect(again.payee).toEqual(first.payee);
    expect(pay.counterpartyRequests).toHaveLength(0);
  });

  it('a counterparty from the earlier build (no state or postal code) is not adopted: a complete one is made', async () => {
    const entityId = person(entityAddress());
    const op = { name: 'spec counterparty', call: 'write' } as const;
    await client.post(op, '/counterparties', {
      type: 'individual',
      entity_id: entityId,
      profile: {
        first_name: 'Forrest',
        last_name: 'Green',
        relationship: 'vendor',
        email: 'sender@example.test',
        address: {
          line1: '11 Opebi Road',
          city: 'Victoria Island',
          country: 'NG',
        },
      },
      meta: { wawu_payee: payeeKey(entityId, '044', NUMBER) },
    });
    pay.counterpartyRequests.length = 0;
    const r = await send(entityId);
    expect(r.transactionId).toMatch(/^01TRF/);
    expect(pay.counterpartyRequests).toHaveLength(1);
  });

  describe('either one missing stops the send before any counterparty, payment detail or transfer', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['no state', entityAddress({ state: undefined }), 'state'],
      ['a blank state', entityAddress({ state: '  ' }), 'state'],
      [
        'no postal code',
        entityAddress({ postal_code: undefined }),
        'postal code',
      ],
      [
        'neither',
        entityAddress({ state: undefined, postal_code: undefined }),
        'state and postal code',
      ],
    ];
    it.each(cases)('%s', async (_name, address, named) => {
      const entityId = person(address);
      const e = await fails(send(entityId));
      expect(e.kind).toBe('validation');
      expect(e.recordMayExist).toBe(false);
      expect(e.messages.join(' ')).toContain(`no ${named} on file`);
      expect(postsTo('/counterparties')).toHaveLength(0);
      expect(postsTo('/payment-details')).toHaveLength(0);
      expect(postsTo('/transfers')).toHaveLength(0);
    });

    it("WAWU's own entity without a postal code stops the same way", async () => {
      pay.contacts.set(PARENT_ENTITY, {
        address: entityAddress({ postal_code: undefined }),
      });
      const e = await fails(send(null));
      expect(e.messages.join(' ')).toContain('no postal code on file');
      expect(postsTo('/counterparties')).toHaveLength(0);
      expect(postsTo('/transfers')).toHaveLength(0);
    });
  });
});
