import type { ProviderReconciliation } from '../../wallet-provider/wallet-provider.interface';
import { NuvionPayoutsArea } from '../areas/payouts';
import type { NuvionAreas } from '../nuvion-wallet-provider';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionClient } from '../nuvion-client';

/**
 * The seam's `reconcileSend` finds a bank send again (WALLET-09, NUV-06's
 * `reconcileBankSend`): a reference the book log never held is another
 * rail's and is asked of the payouts area; a book transfer is answered by
 * the book area and the payouts area is never asked.
 */

const HOLDER = { kind: 'customer', customerId: 'ent_1' } as const;
const REF = 'wawu-bank-3f6b1d1e-0000-4000-8000-000000000001';

function provider(book: ProviderReconciliation) {
  const client = {
    settings: { moneyTimeoutMs: 1_000, operationalAccountId: 'acc_op' },
  } as unknown as NuvionClient;
  const payouts = new NuvionPayoutsArea(client, () => 1_000_000);
  const find = jest.spyOn(payouts, 'findTransferByReference');
  const reconcileSend = jest.fn().mockResolvedValue(book);
  const areas = {
    book: { reconcileSend },
    payouts,
  } as unknown as NuvionAreas;
  return { p: new NuvionWalletProvider(client, areas), find, reconcileSend };
}

describe('NuvionWalletProvider.reconcileSend (WALLET-09)', () => {
  it("a reference the book log never held is asked of the payouts area by the sender's transfers", async () => {
    const { p, find } = provider({ state: 'unknown', why: 'unrecognised' });
    find.mockResolvedValue({ state: 'incomplete' });
    // An incomplete walk is unknown, never "no money moved".
    await expect(p.reconcileSend(REF, HOLDER, new Date(0))).resolves.toEqual({
      state: 'unknown',
      why: 'history_incomplete',
    });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toEqual({
      entityId: 'ent_1',
      accountId: null,
    });
    expect(find.mock.calls[0][1]).toBe(REF);

    // A complete walk long after the send finds nothing: absent.
    find.mockResolvedValue({ state: 'absent', complete: true });
    await expect(p.reconcileSend(REF, HOLDER, new Date(0))).resolves.toEqual({
      state: 'absent',
    });
  });

  it('a send to another WAWU user that the book log never held is not asked of the payouts area', async () => {
    const { p, find } = provider({ state: 'unknown', why: 'unrecognised' });
    await expect(
      p.reconcileSend('wawu-send-3f6b1d1e-0000-4000-8000-000000000001', HOLDER),
    ).resolves.toEqual({ state: 'unknown', why: 'unrecognised' });
    expect(find).not.toHaveBeenCalled();
  });

  it("a book transfer is the book area's answer and the payouts area is not asked", async () => {
    const found: ProviderReconciliation = { state: 'absent' };
    const { p, find } = provider(found);
    await expect(p.reconcileSend(REF, HOLDER)).resolves.toEqual(found);
    expect(find).not.toHaveBeenCalled();
  });

  it('a book answer of unreachable is not turned into a payouts lookup', async () => {
    const { p, find } = provider({ state: 'unknown', why: 'unreachable' });
    await expect(p.reconcileSend(REF, HOLDER)).resolves.toEqual({
      state: 'unknown',
      why: 'unreachable',
    });
    expect(find).not.toHaveBeenCalled();
  });
});
