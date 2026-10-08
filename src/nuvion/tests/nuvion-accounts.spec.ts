import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  NuvionAccountsStandin,
  type StandinAccount,
  standinId,
} from '../../../test/nuvion/accounts-standin';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import {
  nairaDetailsProblem,
  NuvionAccountsArea,
  nuvionWalletId,
  readNuvionAccount,
  readNuvionAccountDetails,
  readNuvionWalletId,
} from '../areas/accounts';
import { NuvionClient } from '../nuvion-client';
import {
  NUVION_LEDGER_DELIVERIES,
  nuvionInflowMovement,
  nuvionInflowProblem,
  nuvionTransferStatus,
  readNuvionTransfer,
} from '../nuvion-ledger-delivery';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';

/**
 * NUV-04 without a database: the readers of Nuvion's account, account
 * details and transfer objects, the inflow's ledger reading, and the
 * accounts area (balance and wallet account) against the Nuvion stand-in
 * over a real socket. No Nuvion host is reached (outbound-guard.ts).
 */

const ENTITY = '01HXYZ1234ABCDEFGHJKMNPQRS';
const ACCOUNT = '01HXYZ5678ABCDEFGHJKMNPQRS';

/** The docs' `inflows.completed` example, in naira. */
function inflow(over: Record<string, unknown> = {}) {
  return {
    id: '01HXYZ5301ABCDEFGHJKMNPQRS',
    amount: 10000,
    currency: 'NGN',
    unique_reference: '01HXYZ5302ABCDEFGHJKMNPQRS-1759504425996',
    counterparty_id: '01HXYZ5304ABCDEFGHJKMNPQRS',
    account_id: ACCOUNT,
    entity_id: ENTITY,
    status: 'successful',
    status_reason: 'Successful.',
    narration: 'Invoice payment received',
    type: 'inflow',
    payment_type: 'bank-transfer',
    applicable_fee: 0,
    meta: {},
    created: 1759860119195,
    updated: 1759860119195,
    ...over,
  };
}

describe('NUV-04: reading Nuvion account, account details and transfers', () => {
  it('a wallet id holds the entity and the account, and only ids in Nuvion form', () => {
    const id = nuvionWalletId(ENTITY, ACCOUNT);
    expect(id).toBe(`${ENTITY}:${ACCOUNT}`);
    expect(readNuvionWalletId(id)).toEqual({
      entityId: ENTITY,
      accountId: ACCOUNT,
    });
    for (const bad of [
      ACCOUNT,
      `${ENTITY}:${ACCOUNT}:x`,
      `${ENTITY}:../x`,
      `:${ACCOUNT}`,
      `${ENTITY}:%2e%2e`,
      'a b:c',
    ]) {
      expect(readNuvionWalletId(bad)).toBeNull();
    }
    expect(() => nuvionWalletId('a/b', ACCOUNT)).toThrow(RangeError);
  });

  it('an account is read from data.account (the docs) or as itself (a list row)', () => {
    const acct = {
      id: ACCOUNT,
      entity_id: ENTITY,
      type: 'checking',
      currency: 'ngn',
      nuvion_ban: '0010759002',
      balance: { available: 150000, current: 175000, overdraft_used: 0 },
      deleted: 0,
    };
    const wrapped = readNuvionAccount({ account: acct, entity: {} });
    const bare = readNuvionAccount(acct);
    expect(wrapped).toEqual(bare);
    expect(bare).toMatchObject({
      id: ACCOUNT,
      currency: 'NGN',
      available: 150000,
      current: 175000,
      deleted: false,
    });
    expect(
      readNuvionAccount({ ...acct, balance: { available: 1.5, current: 2 } })
        ?.available,
    ).toBeNull();
    expect(
      readNuvionAccount({ ...acct, balance: { available: '150000' } })
        ?.available,
    ).toBeNull();
    expect(readNuvionAccount({ account: { type: 'checking' } })).toBeNull();
  });

  it('account details are read from each documented wrapper; the bank is the issuer', () => {
    const d = {
      id: '01HXYZ0050ABCDEFGHJKMNPQRS',
      entity_id: ENTITY,
      account_id: ACCOUNT,
      issuer: {
        name: 'Thornbury Bank',
        code: '040004',
        meta: { bank_name: 'Thornbury Bank PLC' },
      },
      status: 'active',
      asset_type: 'fiat',
      beneficiary_name: 'John Doe',
      currency: 'NGN',
      account_number: '0123456789',
      deleted: 0,
    };
    for (const shape of [{ account_detail: d }, { account_details: d }, d]) {
      expect(readNuvionAccountDetails(shape)).toMatchObject({
        id: d.id,
        status: 'active',
        accountNumber: '0123456789',
        beneficiaryName: 'John Doe',
        issuerName: 'Thornbury Bank PLC',
        issuerCode: '040004',
      });
    }
    const noMeta = readNuvionAccountDetails({
      ...d,
      issuer: { name: 'NUV', code: 'NUV' },
    });
    expect(noMeta?.issuerName).toBe('NUV');
  });

  it('only active, live, naira, fiat details of this entity and account with ten digits are a number to show', () => {
    const base = readNuvionAccountDetails({
      id: 'D1',
      entity_id: ENTITY,
      account_id: ACCOUNT,
      status: 'active',
      asset_type: 'fiat',
      currency: 'NGN',
      account_number: '0123456789',
      deleted: 0,
    })!;
    const expect_ = { entityId: ENTITY, accountId: ACCOUNT };
    expect(nairaDetailsProblem(base, expect_)).toBeNull();
    expect(
      nairaDetailsProblem(
        { ...base, status: 'pending', accountNumber: null },
        expect_,
      ),
    ).toBe('pending');
    expect(
      nairaDetailsProblem({ ...base, entityId: 'OTHER' }, expect_),
    ).toMatch(/another entity/);
    expect(
      nairaDetailsProblem({ ...base, accountId: 'OTHER' }, expect_),
    ).toMatch(/another account/);
    expect(nairaDetailsProblem({ ...base, currency: 'USD' }, expect_)).toMatch(
      /USD/,
    );
    expect(
      nairaDetailsProblem({ ...base, assetType: 'stablecoin' }, expect_),
    ).toMatch(/not a bank account/);
    expect(nairaDetailsProblem({ ...base, deleted: true }, expect_)).toMatch(
      /deleted/,
    );
    for (const n of ['012345678', '01234567890', '01234x6789', null]) {
      expect(
        nairaDetailsProblem({ ...base, accountNumber: n }, expect_),
      ).toMatch(/ten-digit/);
    }
  });

  it('an inflow is read in kobo as Nuvion sends it: no rounding, no float, no strings', () => {
    const ok = readNuvionTransfer(inflow({ amount: 1, applicable_fee: 0 }));
    expect(ok.ok && ok.transfer.amountKobo).toBe(1);
    const big = readNuvionTransfer(
      inflow({ amount: Number.MAX_SAFE_INTEGER - 5, applicable_fee: 5 }),
    );
    expect(big.ok && big.transfer.amountKobo).toBe(Number.MAX_SAFE_INTEGER - 5);
    for (const amount of [
      0,
      -1,
      100.5,
      0.1,
      '10000',
      null,
      NaN,
      Infinity,
      1e21,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const r = readNuvionTransfer(inflow({ amount }));
      expect(r.ok).toBe(false);
    }
    for (const fee of [-1, 0.5, '0', NaN]) {
      expect(readNuvionTransfer(inflow({ applicable_fee: fee })).ok).toBe(
        false,
      );
    }
    expect(
      readNuvionTransfer(
        inflow({ amount: Number.MAX_SAFE_INTEGER, applicable_fee: 1 }),
      ).ok,
    ).toBe(false);
    expect(readNuvionTransfer(inflow({ currency: undefined })).ok).toBe(false);
    expect(readNuvionTransfer(inflow({ id: '../x' })).ok).toBe(false);
    expect(readNuvionTransfer(inflow({ status: '' })).ok).toBe(false);
    const noFee = readNuvionTransfer(inflow({ applicable_fee: undefined }));
    expect(noFee.ok && noFee.transfer.feeKobo).toBe(0);
  });

  it("Nuvion's statuses read as ledger statuses", () => {
    expect(nuvionTransferStatus('successful')).toBe('completed');
    expect(nuvionTransferStatus('pending')).toBe('pending');
    expect(nuvionTransferStatus('processing')).toBe('pending');
    expect(nuvionTransferStatus('failed')).toBe('failed');
    expect(nuvionTransferStatus('reversed')).toBe('reversed');
    expect(nuvionTransferStatus('settled')).toBeNull();
  });

  it('an inflow read back must agree with the delivery and with our account, field by field', () => {
    const t = (o: Record<string, unknown> = {}) => {
      const r = readNuvionTransfer(inflow(o));
      if (!r.ok) throw new Error(r.why);
      return r.transfer;
    };
    const exp = {
      id: t().id,
      entityId: ENTITY,
      accountId: ACCOUNT,
      delivered: t(),
    };
    expect(nuvionInflowProblem(t(), exp)).toBeNull();
    expect(
      nuvionInflowProblem(t({ id: '01OTHERTRANSFER0000000000' }), exp),
    ).toMatch(/another transfer/);
    expect(
      nuvionInflowProblem(t({ account_id: '01OTHERACCOUNT00000000000' }), exp),
    ).toMatch(/another account/);
    expect(
      nuvionInflowProblem(t({ entity_id: '01OTHERENTITY000000000000' }), exp),
    ).toMatch(/another entity/);
    expect(nuvionInflowProblem(t({ currency: 'USD' }), exp)).toMatch(
      /USD, not naira/,
    );
    expect(nuvionInflowProblem(t({ type: 'outflow' }), exp)).toMatch(
      /not money in/,
    );
    expect(nuvionInflowProblem(t({ amount: 10001 }), exp)).toMatch(
      /10001 kobo/,
    );
    expect(nuvionInflowProblem(t({ applicable_fee: 5 }), exp)).toMatch(/fee 5/);
    expect(
      nuvionInflowProblem(t(), { ...exp, delivered: t({ currency: 'USD' }) }),
    ).toMatch(/delivery in USD/);
  });

  it('the ledger reading: money in on the entity, keyed by Nuvion id and unique_reference, never the event id', () => {
    const r = readNuvionTransfer(
      inflow({ amount: 123456, applicable_fee: 50 }),
    );
    if (!r.ok) throw new Error(r.why);
    const m = nuvionInflowMovement(r.transfer);
    expect(m).toMatchObject({
      kind: 'movement',
      status: 'completed',
      amountKobo: 123456,
      feeKobo: 50,
      totalKobo: 123456,
      references: [
        '01HXYZ5301ABCDEFGHJKMNPQRS',
        '01HXYZ5302ABCDEFGHJKMNPQRS-1759504425996',
      ],
      category: 'top_up',
      narration: 'Invoice payment received',
      trustAlone: true,
    });
    expect(m.to).toMatchObject({
      where: 'provider_wallet',
      customerId: ENTITY,
    });
    expect(m.from).toMatchObject({ where: 'bank_account', accountNumbers: [] });

    const read = NUVION_LEDGER_DELIVERIES.read(
      'inflows.completed',
      { event: 'inflows.completed', data: inflow() },
      'EVT1',
    );
    expect(read.kind).toBe('movement');
    expect(read.kind === 'movement' && read.references).not.toContain('EVT1');
    expect(
      NUVION_LEDGER_DELIVERIES.read(
        'inflows.failed',
        { data: inflow({ status: 'failed' }) },
        'E',
      ).kind,
    ).toBe('unreadable');
    expect(
      NUVION_LEDGER_DELIVERIES.read(
        'inflows.completed',
        { data: inflow({ amount: 10.5 }) },
        'E',
      ).kind,
    ).toBe('unreadable');
    expect(NUVION_LEDGER_DELIVERIES.ledgerEvents).toEqual([
      'inflows.completed',
    ]);
  });
});

describe('NUV-04: the balance is never a sum of our rows', () => {
  it('neither the balance route nor the Nuvion balance read adds anything up', () => {
    for (const file of [
      '../areas/accounts.ts',
      '../../money/balance/wallet-balance.service.ts',
      '../../money/balance/money-balance.controller.ts',
    ]) {
      const code = readFileSync(join(__dirname, file), 'utf8');
      expect(code).not.toMatch(
        /_sum|aggregate\(|groupBy\(|SUM\(|\.reduce\(|fintavaLedgerEntry/,
      );
    }
  });
});

describe('NUV-04: the accounts area against the Nuvion stand-in', () => {
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  let guard: OutboundGuard;
  let area: NuvionAccountsArea;
  let provider: NuvionWalletProvider;

  beforeAll(async () => {
    guard = guardOutbound();
    await standin.start();
    nuv.install();
    const client = new NuvionClient(
      standin.settings(),
      'nv_test_sk_NUV04areaKEY0000000000000',
    );
    area = new NuvionAccountsArea(client);
    provider = new NuvionWalletProvider(client);
  });
  afterAll(async () => {
    await standin.stop();
    guard.restore();
    expect(guard.violations).toEqual([]);
  });
  beforeEach(() => standin.reset());

  it("the balance is Nuvion's available, asked with the entity, never current", async () => {
    const entity = standinId('01ENT');
    const a = nuv.addAccount(entity, {
      balance: { available: 104727, current: 999999, overdraft_used: 0 },
    });
    const b = await provider.getBalance({
      walletId: nuvionWalletId(entity, a.id),
    });
    expect(b).toEqual({ availableKobo: 104727n, bookedKobo: 999999n });
    expect(standin.seen).toHaveLength(1);
    expect(standin.seen[0]).toMatchObject({
      method: 'GET',
      path: `/accounts/${a.id}`,
      query: { entity_id: entity },
    });
    // Asked again on every call: a new figure is the new answer.
    a.balance.available = 5;
    expect(
      (await provider.getBalance({ walletId: nuvionWalletId(entity, a.id) }))
        .availableKobo,
    ).toBe(5n);
    expect(standin.seen).toHaveLength(2);
  });

  it('a balance Nuvion cannot vouch for is refused, never shown', async () => {
    const entity = standinId('01ENT');
    const cases: Array<[Partial<StandinAccount>, string]> = [
      [{ currency: 'USD' }, 'bad_response'],
      [
        { balance: { available: 10.5, current: 11, overdraft_used: 0 } },
        'bad_response',
      ],
      [
        { balance: { available: '100', current: 100, overdraft_used: 0 } },
        'bad_response',
      ],
      [
        { balance: { available: -1, current: 0, overdraft_used: 0 } },
        'bad_response',
      ],
      [{ balance: { available: 100, overdraft_used: 0 } }, 'bad_response'],
      [{ deleted: 1 }, 'not_found'],
    ];
    for (const [over, kind] of cases) {
      const a = nuv.addAccount(entity, over);
      await expect(
        provider.getBalance({ walletId: nuvionWalletId(entity, a.id) }),
      ).rejects.toMatchObject({ kind });
    }
    // Another entity's account: Nuvion's 404, never a figure.
    const other = nuv.addAccount(standinId('01ENT'));
    await expect(
      provider.getBalance({ walletId: nuvionWalletId(entity, other.id) }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    // An answer for another account than asked.
    const asked = nuv.addAccount(entity);
    standin.next({
      status: 200,
      body: {
        status: 'success',
        message: 'ok',
        data: {
          account: {
            ...nuv.addAccount(entity),
            balance: { available: 1, current: 1 },
          },
        },
      },
    });
    await expect(
      provider.getBalance({ walletId: nuvionWalletId(entity, asked.id) }),
    ).rejects.toMatchObject({ kind: 'bad_response' });
    // A stored id that is not a Nuvion wallet id: nothing sent.
    const before = standin.seen.length;
    await expect(
      provider.getBalance({ walletId: 'fintava-wallet-1' }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(standin.seen.length).toBe(before);
    // Nuvion unreachable: an error, never 0.
    standin.statusNext(503, {
      status: 'error',
      type: 'error_system_internal_error',
      message: 'x',
    });
    await expect(
      provider.getBalance({ walletId: nuvionWalletId(entity, asked.id) }),
    ).rejects.toBeInstanceOf(WalletProviderError);
  });

  it('the wallet account is null until the number is active, then the number, the holder and the composite id', async () => {
    const entity = standinId('01ENT');
    expect(await provider.getWalletAccount(entity)).toBeNull();
    const a = nuv.addAccount(entity);
    expect(await provider.getWalletAccount(entity)).toBeNull();
    const d = await area.createAccountDetails(entity, a.id);
    expect(d.status).toBe('pending');
    expect(await provider.getWalletAccount(entity)).toBeNull();
    nuv.activate(d.id, '0123456789');
    expect(await provider.getWalletAccount(entity)).toEqual({
      customerId: entity,
      walletId: nuvionWalletId(entity, a.id),
      accountNumber: '0123456789',
      accountName: 'Ada Lovelace',
    });
    // A USD account beside it is not the naira wallet.
    nuv.addAccount(entity, { currency: 'USD' });
    expect((await provider.getWalletAccount(entity))?.accountNumber).toBe(
      '0123456789',
    );
    // Two naira accounts: a stop, never a guess.
    nuv.addAccount(entity);
    await expect(provider.getWalletAccount(entity)).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('account details: created once, found again, read back; a second request is refused as already existing', async () => {
    const entity = standinId('01ENT');
    const a = nuv.addAccount(entity);
    expect(await area.findAccountDetails(entity, a.id)).toBeNull();
    const d = await area.createAccountDetails(entity, a.id);
    expect(standin.seen.at(-1)).toMatchObject({
      method: 'POST',
      path: '/account-details',
      body: { account_id: a.id, entity_id: entity },
    });
    expect((await area.findAccountDetails(entity, a.id))?.id).toBe(d.id);
    expect((await area.getAccountDetails(entity, d.id)).id).toBe(d.id);
    const again = await area
      .createAccountDetails(entity, a.id)
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(WalletProviderError);
    expect((again as WalletProviderError).recordMayExist).toBe(true);
    // A lost answer is an unknown outcome, never "nothing made".
    standin.loseNext();
    const lost = await area
      .createAccountDetails(entity, nuv.addAccount(entity).id)
      .catch((e: unknown) => e);
    expect((lost as WalletProviderError).recordMayExist).toBe(true);
    // Ids that are not Nuvion's are refused before anything is sent.
    const n = standin.seen.length;
    await expect(area.getTransfer(entity, '%2e%2e')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(area.createAccountDetails('a/b', a.id)).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(standin.seen.length).toBe(n);
  });
});
