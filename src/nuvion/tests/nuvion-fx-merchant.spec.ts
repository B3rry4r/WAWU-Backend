import { Logger } from '@nestjs/common';
import { FxStandin } from '../../../test/nuvion/fx-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import type { ProviderFxPerson } from '../../wallet-provider/wallet-provider-fx';
import { NuvionFxArea } from '../areas/fx';
import { NuvionClient } from '../nuvion-client';

/**
 * PAY-FX (R-91): the foreign-accounts area when a person with NO naira account
 * pays a naira price, and when WAWU's own naira account pays them back, over a
 * real socket to the stand-in that answers as Nuvion's DEV did on 26 Oct 2026
 * (a quote from the operational account names no entity_id; a quote for an
 * exact naira amount is rounded up to whole cents). Nothing reaches a Nuvion host.
 */

const KEY = 'nv_test_sk_PAYFXstandinKEY00000000000000';
const OPERATIONAL = '01HXYZOPERATIONAL000000001';
const OP_BAN = '0011875002';
const ENTITY = '01PFXWORLDENTITY000000001';
const WORLD: ProviderFxPerson = { customerId: ENTITY, walletId: '' };

describe('NuvionFxArea for PAY-FX', () => {
  const standin = new NuvionStandin();
  const fx = new FxStandin(standin, ENTITY);
  let guard: OutboundGuard;
  let area: NuvionFxArea;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    guard = guardOutbound();
    await standin.start(9891);
    fx.install();
    area = new NuvionFxArea(new NuvionClient(standin.settings(), KEY));
  });
  afterAll(async () => {
    await standin.stop();
    guard.restore();
    expect(guard.violations).toEqual([]);
  });

  it('a person with no naira wallet gets a quote to naira for an exact naira amount, and pays WAWU with it', async () => {
    const op = fx.addOperational(OPERATIONAL, OP_BAN, 50_000);
    const usd = await area.openAccount({
      person: WORLD,
      currency: 'USD',
      chain: null,
      displayName: 'US dollars',
      holderName: 'Sam Buyer',
    });
    fx.fund(usd.account.accountId, 500);
    const q = await area.quote({
      person: WORLD,
      from: { currency: 'USD', accountId: usd.account.accountId },
      to: { currency: 'NGN', accountId: null },
      amountToMinor: 30_000n,
    });
    expect(q.amountToMinor).toBe(30_000n);
    expect(q.amountFromMinor).toBeGreaterThan(0n);
    expect(q.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const t = await area.swap({
      person: WORLD,
      reference: 'wawu-pay-pfx-1',
      quoteId: q.id,
      from: { currency: 'USD', accountId: usd.account.accountId },
      to: { currency: 'NGN', accountId: null, ban: OP_BAN },
      amountFromMinor: q.amountFromMinor,
    });
    expect(t.status).toBe('completed');
    expect(fx.balanceOf(op.id)).toBe(80_000);
    expect(fx.balanceOf(usd.account.accountId)).toBe(
      500 - Number(q.amountFromMinor),
    );
  });

  it("WAWU's naira account pays it back: a quote with no entity, the move, and a lookup by reference", async () => {
    const op = fx.addOperational(OPERATIONAL, OP_BAN, 100_000);
    const usd = await area.openAccount({
      person: WORLD,
      currency: 'USD',
      chain: null,
      displayName: 'US dollars',
      holderName: 'Sam Buyer',
    });
    const to = {
      currency: 'USD',
      accountId: usd.account.accountId,
      ban: usd.account.ban,
    };
    const q = await area.quoteFromMerchant({ to, amountToMinor: 23n });
    expect(q.amountToMinor).toBe(23n);
    const t = await area.swapFromMerchant({
      reference: 'wawu-ref-pfx-1',
      quoteId: q.id,
      to,
      amountFromMinor: q.amountFromMinor,
    });
    expect(t.status).toBe('completed');
    expect(fx.balanceOf(usd.account.accountId)).toBe(23);
    expect(fx.balanceOf(op.id)).toBe(100_000 - Number(q.amountFromMinor));
    const found = await area.findMerchantTransfer('wawu-ref-pfx-1');
    expect(found.state).toBe('found');
    expect((await area.findMerchantTransfer('wawu-ref-none')).state).toBe(
      'absent',
    );
  });
});
