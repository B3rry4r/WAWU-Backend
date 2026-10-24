import { Logger } from '@nestjs/common';
import {
  FX_ENTITY,
  FX_NGN_ACCOUNT,
  FxStandin,
} from '../../../test/nuvion/fx-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { ProviderFxPerson } from '../../wallet-provider/wallet-provider-fx';
import { NuvionFxArea, rateText } from '../areas/fx';
import { NuvionClient } from '../nuvion-client';

/**
 * WALLET-21: Nuvion's foreign accounts through the seam's `fx` port, over a
 * real socket to the stand-in that answers as Nuvion's DEV did on 24 Oct 2026
 * (test/nuvion/fx-standin.ts). Nothing here reaches a Nuvion host.
 */

const KEY = 'nv_test_sk_WALLET21standinKEY0000000000';
const PERSON: ProviderFxPerson = {
  customerId: FX_ENTITY,
  walletId: `${FX_ENTITY}:${FX_NGN_ACCOUNT}`,
};

describe('NuvionFxArea (WALLET-21)', () => {
  const standin = new NuvionStandin();
  const fx = new FxStandin(standin);
  let guard: OutboundGuard;
  let area: NuvionFxArea;
  let seq = 0;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    guard = guardOutbound();
    await standin.start(8310);
    fx.install();
    area = new NuvionFxArea(new NuvionClient(standin.settings(), KEY));
  });
  afterAll(async () => {
    await standin.stop();
    guard.restore();
    expect(guard.violations).toEqual([]);
  });
  beforeEach(() => {
    fx.detailsMode = 'active';
    fx.refuseSends = true;
    fx.transferStatus = 'successful';
    seq += 1;
  });

  const open = (
    currency: string,
    chain: 'eth' | 'base' | 'matic' | 'sol' | null = null,
  ) =>
    area.openAccount({
      person: PERSON,
      currency,
      chain,
      displayName: `WAWU ${currency} ${seq}`,
      holderName: 'Ngozi Eze',
    });

  it('holds nine currencies, the three coins on their chains', () => {
    expect([...area.currencies]).toEqual([
      'USD',
      'EUR',
      'GBP',
      'CAD',
      'AED',
      'GHS',
      'USDT',
      'USDC',
      'RLUSD',
    ]);
  });

  it('opens a dollar account with the US coordinates: account number, routing number, SWIFT', async () => {
    const { account, details } = await open('USD');
    expect(account.currency).toBe('USD');
    expect(account.availableMinor).toBe(0n);
    expect(account.ban).toMatch(/^00/);
    expect(details).toMatchObject({
      status: 'active',
      accountNumber: '9637380001',
      routingNumber: '101019644',
      swiftCode: 'NOWHUS33',
      bankName: 'Bank of Nowhere',
      chain: null,
      address: null,
    });
    const sent = standin.seen.find(
      (r) =>
        r.method === 'POST' &&
        r.path === '/accounts' &&
        (r.body as { currency: string }).currency === 'USD',
    );
    expect(sent?.body).toMatchObject({
      entity_id: FX_ENTITY,
      type: 'checking',
      currency: 'USD',
    });
  });

  it('opens USDT, USDC and RLUSD with their own codes and a wallet address on the chosen chain', async () => {
    const t = await open('USDT', 'eth');
    const c = await open('USDC', 'sol');
    const r = await open('RLUSD', 'eth');
    expect(t.details).toMatchObject({
      chain: 'eth',
      status: 'active',
      accountNumber: null,
    });
    expect(t.details?.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(c.details?.chain).toBe('sol');
    expect(r.details?.chain).toBe('eth');
    const currencies = fx.accounts;
    expect([...currencies.values()].map((a) => a.currency)).toEqual(
      expect.arrayContaining(['UST', 'USC', 'RLD']),
    );
  });

  it('refuses a chain a coin cannot be held on, and a coin with no chain, before it asks the provider', async () => {
    const before = standin.seen.length;
    await expect(open('USDT')).rejects.toBeInstanceOf(WalletProviderError);
    await expect(open('RLUSD', 'sol')).rejects.toBeInstanceOf(
      WalletProviderError,
    );
    await expect(open('USD', 'eth')).rejects.toBeInstanceOf(
      WalletProviderError,
    );
    expect(standin.seen.length).toBe(before);
  });

  it('keeps the account when its details are not issued yet (dev: CAD and AED answered 503), and issues them on a later read', async () => {
    fx.detailsMode = 'unavailable';
    const { account, details, detailsRefusal: refusal } = await open('CAD');
    expect(details).toBeNull();
    expect(refusal).toMatch(/partner services is temporarily unavailable/);
    fx.detailsMode = 'pending';
    const again = await area.readDetails(
      PERSON,
      { accountId: account.accountId, currency: 'CAD', chain: null },
      true,
    );
    expect(again.details?.status).toBe('pending');
    fx.details.get(account.accountId)!.status = 'active';
    const done = await area.readDetails(
      PERSON,
      { accountId: account.accountId, currency: 'CAD', chain: null },
      false,
    );
    expect(done.details?.status).toBe('active');
  });

  it('answers a second chain on one account with the details it has (one account, one wallet)', async () => {
    const { account } = await open('USDC', 'eth');
    const d = await area.readDetails(
      PERSON,
      { accountId: account.accountId, currency: 'USDC', chain: 'base' },
      true,
    );
    expect(d.details?.chain).toBe('eth');
  });

  it("quotes with the provider's real expiry and a decimal rate, from the naira wallet's account", async () => {
    const { account } = await open('USD');
    const q = await area.quote({
      person: PERSON,
      from: { currency: 'NGN', accountId: null },
      to: { currency: 'USD', accountId: account.accountId },
      amountFromMinor: 100_000n,
    });
    expect(q.amountFromMinor).toBe(100_000n);
    expect(q.amountToMinor).toBe(74n);
    expect(q.rate).toBe('0.000741');
    expect(q.feeMinor).toBeNull();
    const held = q.expiresAt.getTime() - Date.now();
    expect(held).toBeGreaterThan(170_000);
    expect(held).toBeLessThanOrEqual(180_000);
    const body = standin.seen
      .filter((r) => r.path === '/fx-quotes')
      .pop()?.body;
    expect(body).toMatchObject({
      from_currency: 'NGN',
      to_currency: 'USD',
      amount_from: 100_000,
      account_id: FX_NGN_ACCOUNT,
      entity_id: FX_ENTITY,
    });
  });

  it('holds a stablecoin pair for two minutes, not three', async () => {
    const a = await open('USDT', 'eth');
    const b = await open('USDC', 'eth');
    const q = await area.quote({
      person: PERSON,
      from: { currency: 'USDT', accountId: a.account.accountId },
      to: { currency: 'USDC', accountId: b.account.accountId },
      amountFromMinor: 1_000n,
    });
    const held = q.expiresAt.getTime() - Date.now();
    expect(held).toBeLessThanOrEqual(120_000);
    expect(held).toBeGreaterThan(110_000);
  });

  it("swaps naira to dollars: a book transfer in the SOURCE currency, the quoted amount, the quote id and the receiver's nuvion_ban", async () => {
    const { account } = await open('USD');
    const q = await area.quote({
      person: PERSON,
      from: { currency: 'NGN', accountId: null },
      to: { currency: 'USD', accountId: account.accountId },
      amountFromMinor: 100_000n,
    });
    const t = await area.swap({
      person: PERSON,
      reference: `wawu-fx-test-${seq}`,
      quoteId: q.id,
      from: { currency: 'NGN', accountId: null },
      to: { currency: 'USD', accountId: account.accountId, ban: account.ban },
      amountFromMinor: q.amountFromMinor,
    });
    expect(t.status).toBe('completed');
    expect(t.feeMinor).toBe(0n);
    const sent = standin.seen
      .filter((r) => r.path === '/transfers' && r.method === 'POST')
      .pop()?.body;
    expect(sent).toMatchObject({
      account_id: FX_NGN_ACCOUNT,
      amount: 100_000,
      currency: 'NGN',
      payment_type: 'book-transfer',
      nuvion_ban: account.ban,
      fx_quote_id: q.id,
      unique_reference: `wawu-fx-test-${seq}`,
      entity_id: FX_ENTITY,
    });
    const read = await area.readAccount(PERSON, account.accountId);
    expect(read.availableMinor).toBe(74n);
  });

  it("swaps dollars back to naira by reading the naira wallet's routing number", async () => {
    const { account } = await open('USD');
    fx.fund(account.accountId, 500);
    const q = await area.quote({
      person: PERSON,
      from: { currency: 'USD', accountId: account.accountId },
      to: { currency: 'NGN', accountId: null },
      amountFromMinor: 100n,
    });
    const t = await area.swap({
      person: PERSON,
      reference: `wawu-fx-back-${seq}`,
      quoteId: q.id,
      from: { currency: 'USD', accountId: account.accountId },
      to: { currency: 'NGN', accountId: null },
      amountFromMinor: q.amountFromMinor,
    });
    expect(t.status).toBe('completed');
    const sent = standin.seen
      .filter((r) => r.path === '/transfers' && r.method === 'POST')
      .pop()?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      currency: 'USD',
      nuvion_ban: '0011110001',
      account_id: account.accountId,
    });
  });

  it("moves WAWU's fee as a transfer in one currency, with no quote id", async () => {
    const { account } = await open('USD');
    fx.fund(account.accountId, 500);
    const other = await open('USD');
    void other;
    await area.swap({
      person: PERSON,
      reference: `wawu-fx-fee-${seq}`,
      quoteId: null,
      from: { currency: 'USD', accountId: account.accountId },
      to: { currency: 'USD', accountId: null, ban: '0011110001' },
      amountFromMinor: 25n,
      narration: 'WAWU fee',
    });
    const sent = standin.seen
      .filter((r) => r.path === '/transfers' && r.method === 'POST')
      .pop()?.body as Record<string, unknown>;
    expect(sent.fx_quote_id).toBeUndefined();
    expect(sent).toMatchObject({
      narration: 'WAWU fee',
      amount: 25,
      currency: 'USD',
    });
  });

  it("sends WAWU's fee out of the naira wallet to the collector's routing number, never to the payer's own account (verifier H1)", async () => {
    const collector = fx.addCollector('0099990009', 'NGN');
    const ref = `wawu-fx-h1-${seq}`;
    const t = await area.swap({
      person: PERSON,
      reference: ref,
      quoteId: null,
      from: { currency: 'NGN', accountId: null },
      to: { currency: 'NGN', accountId: null, ban: '0099990009' },
      amountFromMinor: 500n,
      narration: 'WAWU fee',
    });
    expect(t.status).toBe('completed');
    const sent = standin.seen
      .filter((r) => r.path === '/transfers' && r.method === 'POST')
      .pop()?.body;
    expect(sent).toMatchObject({
      account_id: FX_NGN_ACCOUNT,
      nuvion_ban: '0099990009',
      currency: 'NGN',
      amount: 500,
    });
    expect(fx.balanceOf(collector.id)).toBe(500);
  });

  it('reads a pending transfer as pending, and finds one again by its reference', async () => {
    const { account } = await open('USD');
    fx.fund(account.accountId, 500);
    fx.transferStatus = 'pending';
    const ref = `wawu-fx-pend-${seq}`;
    const t = await area.swap({
      person: PERSON,
      reference: ref,
      quoteId: null,
      from: { currency: 'USD', accountId: account.accountId },
      to: { currency: 'USD', accountId: null, ban: '0011110001' },
      amountFromMinor: 10n,
    });
    expect(t.status).toBe('pending');
    const found = await area.findTransferByReference(
      PERSON,
      account.accountId,
      ref,
    );
    expect(found).toMatchObject({
      state: 'found',
      transfer: { transferId: t.transferId, status: 'pending' },
    });
    const none = await area.findTransferByReference(
      PERSON,
      account.accountId,
      'wawu-fx-nothing',
    );
    expect(none.state).toBe('absent');
    const again = await area.readTransfer(PERSON, t.transferId);
    expect(again.state).toBe('found');
  });

  it('answers a repeated reference with the original transfer, never a second one', async () => {
    const { account } = await open('USD');
    fx.fund(account.accountId, 500);
    const ref = `wawu-fx-dup-${seq}`;
    const input = {
      person: PERSON,
      reference: ref,
      quoteId: null,
      from: { currency: 'USD', accountId: account.accountId },
      to: { currency: 'USD', accountId: null, ban: '0011110001' },
      amountFromMinor: 10n,
    };
    const first = await area.swap(input);
    const second = await area.swap(input);
    expect(second.transferId).toBe(first.transferId);
    expect(fx.transfers.filter((t) => t.unique_reference === ref)).toHaveLength(
      1,
    );
  });

  it("answers dev's refusal of a stablecoin send as a refusal in Nuvion's words, with the payee made once", async () => {
    const { account } = await open('USDT', 'eth');
    fx.fund(account.accountId, 1_000);
    const send = () =>
      area.send({
        person: PERSON,
        reference: `wawu-fx-send-${seq}-${Math.random()}`,
        accountId: account.accountId,
        currency: 'USDT',
        chain: 'eth',
        address: `0x${'cd'.repeat(20)}`,
        amountMinor: 100n,
        holderName: 'Outside wallet',
      });
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletProviderError);
    expect((err as WalletProviderError).kind).toBe('refused');
    expect((err as WalletProviderError).messages.join(' ')).toMatch(
      /can't perform this action/,
    );
    await send().catch(() => undefined);
    expect(fx.counterparties).toHaveLength(1);
    expect(fx.paymentDetails).toHaveLength(1);
    expect(fx.paymentDetails[0]).toMatchObject({
      payment_method: 'stablecoin-transfer',
      currency: 'UST',
      blockchain_network: 'ETH_MAINNET',
      account_holder_name: 'Outside wallet',
    });
    expect(fx.balanceOf(account.accountId)).toBe(1_000);
  });

  it("sends a stablecoin once Nuvion takes it, in the coin's own currency code", async () => {
    fx.refuseSends = false;
    const { account } = await open('USDC', 'base');
    fx.fund(account.accountId, 1_000);
    const t = await area.send({
      person: PERSON,
      reference: `wawu-fx-ok-${seq}`,
      accountId: account.accountId,
      currency: 'USDC',
      chain: 'base',
      address: `0x${'ef'.repeat(20)}`,
      amountMinor: 250n,
      holderName: 'Outside wallet',
    });
    expect(t.status).toBe('completed');
    const sent = standin.seen
      .filter((r) => r.path === '/transfers' && r.method === 'POST')
      .pop()?.body;
    expect(sent).toMatchObject({
      currency: 'USC',
      payment_type: 'stablecoin-transfer',
      amount: 250,
    });
    expect(fx.balanceOf(account.accountId)).toBe(750);
  });

  it('reads a statement line with its running balance', async () => {
    fx.refuseSends = false;
    const { account } = await open('USDT', 'matic');
    fx.fund(account.accountId, 1_000);
    await area.send({
      person: PERSON,
      reference: `wawu-fx-st-${seq}`,
      accountId: account.accountId,
      currency: 'USDT',
      chain: 'matic',
      address: `0x${'12'.repeat(20)}`,
      amountMinor: 100n,
      holderName: 'Outside wallet',
    });
    const page = await area.statement(
      PERSON,
      { accountId: account.accountId, currency: 'USDT' },
      { year: 2026, month: 10, cursor: null, limit: 100 },
    );
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]).toMatchObject({
      direction: 'out',
      status: 'completed',
      amountMinor: 100n,
      balanceAfterMinor: 900n,
    });
    expect(page.nextCursor).toBeNull();
  });

  it('writes a rate as plain decimal text, never an exponent', () => {
    expect(rateText(0.000741)).toBe('0.000741');
    expect(rateText(1315.440043)).toBe('1315.440043');
    expect(rateText(1)).toBe('1');
    expect(rateText(1e-7)).toBe('0.0000001');
    expect(rateText(0)).toBeNull();
    expect(rateText('1')).toBeNull();
  });

  it("puts only ids of Nuvion's form in a path", async () => {
    await expect(area.readAccount(PERSON, '../etc')).rejects.toBeInstanceOf(
      WalletProviderError,
    );
    await expect(area.readTransfer(PERSON, 'a/b')).rejects.toBeInstanceOf(
      WalletProviderError,
    );
  });
});
