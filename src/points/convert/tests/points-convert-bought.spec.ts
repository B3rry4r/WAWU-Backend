// POINTS-BOUGHT (R-101 point 7): the cash-out quote and the checks before the PIN use
// only earned and bonus points. Real database and the real PointsService and
// PointsConvertService; the wallet, fees and the cash-out mover are stood in by
// plain objects (nothing is sent anywhere, no provider is involved).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { FeeSettings } from '../../../money/fees/fee-config';
import type { FeeQuoteService } from '../../../money/fees/fee-quote.service';
import type { BillingCurrencyService } from '../../../plans/billing-currency.service';
import { loadPlansConfig } from '../../../plans/plans-config';
import { NOT_CASHABLE_WORDS } from '../../points-bought';
import { PointsError } from '../../points-error';
import { purgePersonPoints } from '../../points-purge';
import { PointsService } from '../../points.service';
import { PointsCashOutService } from '../points-cash-out.service';
import { PointsConvertQuoteToken } from '../points-convert-quote-token';
import { PointsConvertService } from '../points-convert.service';

const config = loadPlansConfig();
const MIN = config.cashOut.minimumPoints;
const CLAIMS = { phone: '+2348000000000', country: 'NG' };

describe('POINTS-BOUGHT: points to cash uses earned and bonus points only', () => {
  let prisma: PrismaService;
  let points: PointsService;
  let svc: PointsConvertService;
  const started: Array<{ points: number }> = [];
  const people: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    points = new PointsService(prisma);
    const tokens = new PointsConvertQuoteToken({
      quoteSeconds: 60,
      quoteKey: () => Buffer.alloc(32, 7),
    } as unknown as FeeSettings);
    svc = new PointsConvertService(
      config,
      {
        resolve: () => Promise.resolve({ currency: 'NGN' }),
      } as unknown as BillingCurrencyService,
      points,
      {
        providerFees: { merchantMaxPerTxnKobo: null },
      } as unknown as FeeQuoteService,
      {
        start: (input: { points: number }) => {
          started.push(input);
          return Promise.resolve({ id: 'x', status: 'completed' });
        },
      } as unknown as PointsCashOutService,
      tokens,
    );
  }, 60_000);
  afterAll(async () => {
    for (const id of people) await purgePersonPoints(prisma, id);
    await prisma.$disconnect();
  }, 120_000);

  async function mixed(bought: number, earned: number): Promise<string> {
    const id = `pbc-${randomUUID()}`;
    people.push(id);
    if (bought > 0)
      await points.grant({
        wawuUserId: id,
        source: 'pack',
        sourceRef: `pbc-${randomUUID()}`,
        points: bought,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    if (earned > 0)
      await points.grant({
        wawuUserId: id,
        source: 'tier_bonus',
        sourceRef: `pbc-${randomUUID()}`,
        points: earned,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      });
    return id;
  }
  const refusal = async (p: Promise<unknown>): Promise<PointsError> => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(PointsError);
      return e as PointsError;
    }
    throw new Error('expected a refusal');
  };

  it('the quote shows the balance and the cashable points, and is for the cashable points when none is asked', async () => {
    const me = await mixed(5000, MIN + 40);
    const q = await svc.quote(me, CLAIMS);
    expect(q).toMatchObject({
      balancePoints: 5000 + MIN + 40,
      cashablePoints: MIN + 40,
      points: MIN + 40,
      canConvert: true,
      blockedBy: null,
    });
  });

  it('asking for more than the cashable points (but within the balance) is blocked as not_cashable, not insufficient', async () => {
    const me = await mixed(5000, MIN + 40);
    const q = await svc.quote(me, CLAIMS, MIN + 41);
    expect(q).toMatchObject({ canConvert: false, blockedBy: 'not_cashable' });
    const over = await svc.quote(me, CLAIMS, 9_999_999);
    expect(over.blockedBy).toBe('insufficient_points');
  });

  it('a person with only bought points: nothing cashable, and the quote cannot convert', async () => {
    const me = await mixed(5000, 0);
    const q = await svc.quote(me, CLAIMS);
    expect(q).toMatchObject({
      balancePoints: 5000,
      cashablePoints: 0,
      points: 0,
    });
    expect(q.canConvert).toBe(false);
  });

  it('the checks before the PIN refuse more than the cashable points with points_not_cashable (422), changing nothing', async () => {
    const me = await mixed(5000, MIN + 40);
    const q = await svc.quote(me, CLAIMS, MIN + 41);
    const err = await refusal(
      svc.assertMayConvert(me, CLAIMS, MIN + 41, q.quoteToken),
    );
    expect(err.code).toBe('points_not_cashable');
    expect(err.getStatus()).toBe(422);
    expect(err.message).toBe(NOT_CASHABLE_WORDS);
    expect(err.detail).toEqual({
      balancePoints: 5000 + MIN + 40,
      cashablePoints: MIN + 40,
      neededPoints: MIN + 41,
    });
    expect(started).toHaveLength(0);
    expect(await points.balanceOf(me)).toBe(5000 + MIN + 40);
  });

  it('converting exactly the cashable points goes through to the mover', async () => {
    const me = await mixed(5000, MIN + 40);
    const q = await svc.quote(me, CLAIMS);
    await svc.convert(me, CLAIMS, MIN + 40, q.quoteToken, {} as never);
    expect(started.at(-1)).toMatchObject({ points: MIN + 40 });
  });

  it('more than the whole balance is insufficient_points, as before', async () => {
    const me = await mixed(100, MIN + 40);
    const q = await svc.quote(me, CLAIMS, 9_999_999);
    const err = await refusal(
      svc.assertMayConvert(me, CLAIMS, 9_999_999, q.quoteToken),
    );
    expect(err.code).toBe('insufficient_points');
  });
});
