import { EXPORT_EXCLUDED, EXPORT_SECTIONS } from '../data-export-sections';

/**
 * STORE-BUY-HUB: what the export shows of a price-ladder purchase. The map
 * spec checks models; this reads the columns the store section really asks
 * for, the way the AITOOLS-07 checks do.
 */
describe('data export of a price-ladder purchase', () => {
  async function selectOf(key: string): Promise<string[]> {
    const section = EXPORT_SECTIONS.find((s) => s.key === key);
    if (!section) throw new Error(`no export section ${key}`);
    let seen: Record<string, unknown> | undefined;
    const model = new Proxy(
      {},
      {
        get: () => (args: { select?: Record<string, unknown> }) => {
          seen = args.select;
          return Promise.resolve([]);
        },
      },
    );
    const prisma = new Proxy({}, { get: () => model });
    await section.load(prisma as never, 'someone');
    return Object.entries(seen ?? {})
      .filter(([, on]) => on === true)
      .map(([column]) => column);
  }

  it("shows what a purchase was for and which one, and never the intent, the store transaction or the creator's share", async () => {
    const columns = await selectOf('storePurchases');
    expect(columns).toEqual(expect.arrayContaining(['buyKind', 'targetId']));
    for (const never of [
      'intentId',
      'storeTransactionId',
      'subscriptionKey',
      'creatorWawuUserId',
      'creatorShareKobo',
      'grant',
    ])
      expect(columns).not.toContain(never);
  });

  it('leaves the intent and the creator share out on purpose, with a reason', () => {
    const left = Object.fromEntries(
      EXPORT_EXCLUDED.map((e) => [e.model, e.reason]),
    );
    expect(left.StorePurchaseIntent).toContain('storePurchases');
    expect(left.StoreEarning).toContain('EarningSettlement');
  });

  it('shows a store credit as how much, whether it is spent and when, and never the purchase it came from', async () => {
    const columns = await selectOf('storeCredits');
    expect(columns).toEqual(
      expect.arrayContaining(['amountKobo', 'status', 'createdAt', 'spentAt']),
    );
    for (const never of ['sourcePurchaseId', 'spentPurchaseId', 'wawuUserId'])
      expect(columns).not.toContain(never);
  });
});
