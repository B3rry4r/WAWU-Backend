import { randomUUID } from 'node:crypto';
import { POINTS_NEVER_EXPIRES } from '../../points-bought';
import request from 'supertest';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  PIN,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { AdminRole } from '../../../../generated/prisma/enums';
import type { AdminActor } from '../../../common/audit/admin-ops-audit.service';
import { lagosNextDayStart } from '../../../money/limits/lagos-window';
import {
  loadPlansConfig,
  priceIn,
  type PlanAction,
} from '../../../plans/plans-config';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { PointsService } from '../../points.service';
import type { MyPointsView } from '../../points-view.type';
import { PointsHoldSweepService } from '../points-hold-sweep.service';
import { DOLLARS_NOTE, NO_WALLET_NOTE } from '../points-shortfall.service';
import { PointsSpendModule } from '../points-spend.module';
import { PointsSpendService, jobHoldReference } from '../points-spend.service';
import type {
  PointsQuoteView,
  PointsSettingsView,
  PointsShortfallView,
} from '../points-spend-view.type';
import { shortfallPriceMinor } from '../points-spend-rules';

/**
 * POINTS-03 over HTTP: the cost of an AI job before it runs, the hold, commit
 * and release of its points, the caps, and paying the shortfall from the
 * wallet, on the real MoneyModule, PlansModule, PointsModule and
 * PointsSpendModule, a real database, real RS256 tokens and the real Fintava
 * client over a socket to the Fintava double. No AI provider and no payment
 * provider host is called. Every cost, cap and rate is read from the plan the
 * Hub reads (the file, then the settings an admin saved).
 */

jest.setTimeout(120_000);

const config = loadPlansConfig();
const DAY = 86_400_000;
const minuteTool = config.actions.find((a) => a.per === 'minute')!;
const dubTool = config.actions.find((a) => a.per === 'minute_per_language')!;
const useTool = config.actions.find((a) => a.per === 'use')!;
const RICH = 1_000_000_000;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'points03@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const costOf = (a: PlanAction, units: number, languages = 1) =>
  a.points * units * languages;

describe('Spend points on AI tools (POINTS-03)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let settings: PlanSettingsService;
  let spend: PointsSpendService;
  let points: PointsService;
  let sweep: PointsHoldSweepService;
  const touched = new Set<string>();

  beforeAll(async () => {
    h = await bootTierApp('p03', { modules: [PointsSpendModule] });
    call = api(h);
    settings = h.get(PlanSettingsService);
    spend = h.get(PointsSpendService);
    points = h.get(PointsService);
    sweep = h.get(PointsHoldSweepService);
  });
  afterAll(async () => {
    for (const key of touched)
      await settings.set(admin, { settings: { [key]: null } });
    await h.prisma.pointsSetting.deleteMany({
      where: { wawuUserId: { in: h.users } },
    });
    // The audit rows of the settings this spec changed would be counted by the
    // admin settings spec, which reads them by key.
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  const data = <T>(res: Response) => body<T>(res).data!;
  const reasonOf = (res: Response) =>
    body<unknown>(res).reason as unknown as Record<string, unknown> & {
      code: string;
      message: string;
    };
  const set = async (key: string, value: number | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const quoteRoute = (p: Person, job: object) =>
    request(h.app.getHttpServer())
      .post('/api/hub/points/quote')
      .set('Authorization', p.auth)
      .send(job);
  async function quoted(p: Person, job: object): Promise<PointsQuoteView> {
    const res = await quoteRoute(p, job);
    expect(res.status).toBe(200);
    return data<PointsQuoteView>(res);
  }
  const useWallet = (p: Person, value: unknown) =>
    request(h.app.getHttpServer())
      .put('/api/hub/me/points/settings')
      .set('Authorization', p.auth)
      .send({ useWallet: value });
  const shortfallRoute = (
    p: Person,
    job: object,
    q: PointsQuoteView,
    opts: { key?: string; pin?: string | null } = {},
  ) => {
    const req = request(h.app.getHttpServer())
      .post('/api/hub/points/shortfall')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.pin !== null) req.set('X-Transaction-Pin', opts.pin ?? PIN);
    return req.send({
      ...job,
      expectedTotalKobo: q.wallet!.payment.totalKobo,
      quoteToken: q.wallet!.payment.quoteToken,
    });
  };
  const give = (p: Person, n: number, daysLeft = 30) =>
    points.grant({
      wawuUserId: p.id,
      // A lot that ends in `daysLeft` days: bought points never end (R-101 point 7), so this is a bonus lot.
      source: 'tier_bonus',
      sourceRef: randomUUID(),
      points: n,
      expiresAt: new Date(Date.now() + daysLeft * DAY),
    });
  const balanceOf = async (p: Person) =>
    data<MyPointsView>(await call.points(p)).balance;
  const sendsFrom = (p: Person) =>
    h.wallets.sends.filter((s) => s.from === p.accountNumber);
  const holdsOf = (p: Person) =>
    h.prisma.pointHold.findMany({ where: { wawuUserId: p.id } });
  const job = (units = 2, over: object = {}) => ({
    action: minuteTool.id,
    units,
    ...over,
  });
  const ref = () => jobHoldReference(randomUUID(), 1);
  const lowCap = async () => {
    // A day's cap just above one two-minute job, so a second job passes it.
    await set('points.daily_cap', costOf(minuteTool, 2) + 10);
  };

  // ---------------------------------------------------------------------------
  // Check 1: the cost first; a hold takes it, a failed job gives all back, a finished job keeps it
  // ---------------------------------------------------------------------------

  it('check 1: shows the cost for 2 minutes from the settings, holds it, gives all of it back on a failed job and keeps it on a finished one', async () => {
    const p = await h.buyer(RICH);
    await give(p, costOf(minuteTool, 2) * 3);
    const total = costOf(minuteTool, 2) * 3;

    const q = await quoted(p, job(2));
    expect(q).toMatchObject({
      action: minuteTool.id,
      per: 'minute',
      units: 2,
      languages: 1,
      perUnitPoints: minuteTool.points,
      costPoints: costOf(minuteTool, 2),
      balancePoints: total,
      shortfallPoints: 0,
      canRun: true,
      cap: null,
      wallet: null,
      useWallet: false,
    });
    // A quote takes nothing.
    expect(await balanceOf(p)).toBe(total);
    expect(await holdsOf(p)).toHaveLength(0);

    // A failed job releases all of it, to the lots it came from.
    const first = await spend.hold({
      wawuUserId: p.id,
      ...job(2),
      reference: ref(),
    });
    expect(first).toMatchObject({
      state: 'held',
      costPoints: costOf(minuteTool, 2),
      replayed: false,
    });
    expect(await balanceOf(p)).toBe(total - costOf(minuteTool, 2));
    await spend.release(first.holdId);
    expect(await balanceOf(p)).toBe(total);

    // A finished job keeps them: the movement list reads "Spent on VoiceOver".
    const second = await spend.hold({
      wawuUserId: p.id,
      ...job(2),
      reference: ref(),
    });
    await spend.commit(second.holdId);
    expect(await balanceOf(p)).toBe(total - costOf(minuteTool, 2));
    const view = data<MyPointsView>(await call.points(p));
    expect(view.movements[0]).toMatchObject({
      pending: false,
    });
    expect(view.movements[0].label).toMatch(/^Spent on /);
    // Again changes nothing; a spent hold cannot be given back.
    await spend.commit(second.holdId);
    await expect(spend.release(second.holdId)).rejects.toMatchObject({
      code: 'points_hold_settled',
    });
  });

  it('dubbing is counted for each language; an action the plan does not price and a count that is not whole are a 400', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p, {
      action: dubTool.id,
      units: 2,
      languages: 3,
    });
    expect(q).toMatchObject({
      languages: 3,
      costPoints: costOf(dubTool, 2, 3),
    });
    for (const bad of [
      { action: 'nope', units: 1 },
      { action: minuteTool.id, units: 0 },
      { action: minuteTool.id, units: 1.5 },
      { action: minuteTool.id, units: 1, languages: 2 },
      { action: minuteTool.id },
      { units: 1 },
    ]) {
      const res = await quoteRoute(p, bad);
      expect(res.status).toBe(400);
    }
    const noAuth = await request(h.app.getHttpServer())
      .post('/api/hub/points/quote')
      .send(job(1));
    expect(noAuth.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Check 2: too few points, "Use wallet" off: the shortfall, nothing taken
  // ---------------------------------------------------------------------------

  it('check 2: with too few points and "Use wallet" off, the quote shows the shortfall and offers no wallet money, and nothing is taken', async () => {
    const p = await h.buyer(RICH);
    const have = 40;
    await give(p, have);
    const q = await quoted(p, job(2));
    expect(q).toMatchObject({
      costPoints: costOf(minuteTool, 2),
      balancePoints: have,
      shortfallPoints: costOf(minuteTool, 2) - have,
      canRun: false,
      useWallet: false,
      wallet: null,
      walletNote: null,
      cap: null,
    });
    // The hold itself never reaches for the wallet: it is the plain 402.
    await expect(
      spend.hold({ wawuUserId: p.id, ...job(2), reference: ref() }),
    ).rejects.toMatchObject({
      code: 'insufficient_points',
      detail: {
        balancePoints: have,
        neededPoints: costOf(minuteTool, 2),
        shortfallPoints: costOf(minuteTool, 2) - have,
      },
    });
    expect(await balanceOf(p)).toBe(have);
    expect(await holdsOf(p)).toHaveLength(0);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Check 3: "Use wallet" on: the wallet money for the shortfall; the debit only on the PIN; once (V8)
  // ---------------------------------------------------------------------------

  it('check 3: "Use wallet" is off by default and on after a PUT; the quote then shows the wallet money for exactly the shortfall at the pack rate, and nothing is debited until the PIN', async () => {
    const p = await h.buyer(RICH);
    const read = await request(h.app.getHttpServer())
      .get('/api/hub/me/points/settings')
      .set('Authorization', p.auth);
    expect(data<PointsSettingsView>(read)).toEqual({ useWallet: false });
    expect(data<PointsSettingsView>(await useWallet(p, true))).toEqual({
      useWallet: true,
    });
    expect(
      data<PointsSettingsView>(
        await request(h.app.getHttpServer())
          .get('/api/hub/me/points/settings')
          .set('Authorization', p.auth),
      ),
    ).toEqual({ useWallet: true });

    const have = 40;
    await give(p, have);
    const short = costOf(minuteTool, 2) - have;
    const q = await quoted(p, job(2));
    const price = shortfallPriceMinor(
      config.points.pricePer1000Points,
      'NGN',
      short,
    )!;
    expect(q).toMatchObject({
      shortfallPoints: short,
      useWallet: true,
      canRun: false,
      walletNote: null,
      wallet: {
        currency: 'NGN',
        points: short,
        priceKobo: price,
        per1000PointsKobo: priceIn(config.points.pricePer1000Points, 'NGN'),
        payment: {
          kind: 'points_shortfall',
          targetId: `shortfall-${short}`,
          priceKobo: price,
        },
      },
    });
    expect(q.wallet!.payment.totalKobo).toBeGreaterThan(price);
    // Nothing debited by a quote, whatever it shows.
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await balanceOf(p)).toBe(have);

    // A wrong PIN takes nothing.
    const wrong = await shortfallRoute(p, job(2), q, { pin: '1111' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(sendsFrom(p)).toHaveLength(0);

    const key = randomUUID();
    const res = await shortfallRoute(p, job(2), q, { key });
    expect(res.status).toBe(201);
    const view = data<PointsShortfallView>(res);
    expect(view).toMatchObject({
      currency: 'NGN',
      status: 'paid',
      statusMessage: null,
      points: short,
      amountKobo: price,
      payment: {
        kind: 'points_shortfall',
        status: 'completed',
        delivered: true,
      },
      grant: { points: short },
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0].amountKobo).toBe(price);
    const lots = await h.prisma.pointLot.findMany({
      where: { wawuUserId: p.id, source: 'shortfall' },
    });
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      sourceRef: view.id,
      quantity: short,
      remaining: short,
    });
    // Topped-up points are bought points: they never end (R-101 point 7).
    expect(lots[0].expiresAt.getTime()).toBe(POINTS_NEVER_EXPIRES.getTime());
    // Exactly the shortfall: the job can run now, with nothing over.
    expect(await balanceOf(p)).toBe(costOf(minuteTool, 2));
    expect((await quoted(p, job(2))).canRun).toBe(true);

    // The same key again answers the first result without a second debit (V8).
    const again = await shortfallRoute(p, job(2), q, { key });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(data<PointsShortfallView>(again).id).toBe(view.id);
    // The same quote under another key is not a second purchase: nothing is short now.
    const other = await shortfallRoute(p, job(2), q);
    expect(other.status).toBe(409);
    expect(reasonOf(other).code).toBe('points_not_short');
    expect(sendsFrom(p)).toHaveLength(1);
    expect(
      await h.prisma.pointLot.count({
        where: { wawuUserId: p.id, source: 'shortfall' },
      }),
    ).toBe(1);

    // The poll answers the same purchase; another person's is a 404.
    const polled = await request(h.app.getHttpServer())
      .get(`/api/hub/points/shortfall/${view.id}`)
      .set('Authorization', p.auth);
    expect(data<PointsShortfallView>(polled)).toMatchObject({
      id: view.id,
      status: 'paid',
    });
    const stranger = await h.buyer(1000);
    const nope = await request(h.app.getHttpServer())
      .get(`/api/hub/points/shortfall/${view.id}`)
      .set('Authorization', stranger.auth);
    expect(nope.status).toBe(404);
  });

  it('check 3, ten taps at once: one debit and one lot, whatever keys they carry', async () => {
    const p = await h.buyer(RICH);
    await useWallet(p, true);
    await give(p, 10);
    const q = await quoted(p, job(2));
    const taps = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        // Half share one key, half have their own.
        shortfallRoute(
          p,
          job(2),
          q,
          i % 2 === 0 ? { key: 'same-key-' + p.id.slice(0, 8) } : {},
        ),
      ),
    );
    const paid = taps.filter((t) => t.status === 201);
    expect(paid.length).toBeGreaterThanOrEqual(1);
    expect(new Set(paid.map((t) => data<PointsShortfallView>(t).id)).size).toBe(
      1,
    );
    for (const t of taps.filter((x) => x.status !== 201))
      expect(t.status).toBeGreaterThanOrEqual(400);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(
      await h.prisma.pointLot.count({
        where: { wawuUserId: p.id, source: 'shortfall' },
      }),
    ).toBe(1);
    expect(await balanceOf(p)).toBe(costOf(minuteTool, 2));
  });

  it('a quote that changed is 409 quote_changed and nothing moves: the balance moved, the rate moved, and a fresh quote buys at the new figures', async () => {
    const p = await h.buyer(RICH);
    await useWallet(p, true);
    await give(p, 40);
    const q = await quoted(p, job(2));

    // The balance moved since the quote (a grant arrived): the shortfall is another amount.
    await give(p, 10);
    const moved = await shortfallRoute(p, job(2), q);
    expect(moved.status).toBe(409);
    expect(reasonOf(moved).code).toBe('quote_changed');
    expect(sendsFrom(p)).toHaveLength(0);

    // The rate moved since the quote.
    const q2 = await quoted(p, job(2));
    const rate = priceIn(config.points.pricePer1000Points, 'NGN');
    await set('points.price_kobo_per_1000', rate + 5_000);
    const changed = await shortfallRoute(p, job(2), q2);
    expect(changed.status).toBe(409);
    expect(reasonOf(changed).code).toBe('quote_changed');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await h.prisma.pointLot.count({
        where: { wawuUserId: p.id, source: 'shortfall' },
      }),
    ).toBe(0);

    // A fresh quote buys at the new rate.
    const q3 = await quoted(p, job(2));
    expect(q3.wallet!.per1000PointsKobo).toBe(rate + 5_000);
    const ok = await shortfallRoute(p, job(2), q3);
    expect(ok.status).toBe(201);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0].amountKobo).toBe(q3.wallet!.priceKobo);
    await set('points.price_kobo_per_1000', null);
  });

  it('no wallet money is offered when there is no wallet, or the person is billed in dollars, or a cap stops the job; the route refuses without taking anything', async () => {
    // No wallet yet.
    const bare = await h.walletless();
    await give(bare, 10);
    await useWallet(bare, true);
    const q = await quoted(bare, job(2));
    expect(q).toMatchObject({
      useWallet: true,
      shortfallPoints: costOf(minuteTool, 2) - 10,
      wallet: null,
    });
    // A walletless Nigerian (no PersonBilling row, nothing fixed) is told to
    // open a wallet, never the dollars note.
    expect(q.walletNote).toBe(NO_WALLET_NOTE);
    const fake = {
      expectedTotalKobo: 1,
      quoteToken: 'x',
    };
    const noWallet = await request(h.app.getHttpServer())
      .post('/api/hub/points/shortfall')
      .set('Authorization', bare.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send({ ...job(2), ...fake });
    expect(noWallet.status).toBe(409);
    expect(reasonOf(noWallet).code).toBe('wallet_not_open');

    // Billed in dollars: priced in the dollar column, no naira wallet money offered.
    const usd = await h.buyer(RICH);
    await h.prisma.personBilling.create({
      data: {
        wawuUserId: usd.id,
        currency: 'USD',
        fixedBy: 'first_purchase',
        purchaseRef: randomUUID(),
      },
    });
    await useWallet(usd, true);
    await give(usd, 10);
    const qu = await quoted(usd, job(2));
    expect(qu).toMatchObject({
      wallet: null,
    });
    expect(qu.walletNote).toBe(DOLLARS_NOTE);
    expect(sendsFrom(usd)).toHaveLength(0);

    // Fixed in dollars with no wallet: the dollars note comes first.
    const usdBare = await h.walletless();
    await h.prisma.personBilling.create({
      data: {
        wawuUserId: usdBare.id,
        currency: 'USD',
        fixedBy: 'first_purchase',
        purchaseRef: randomUUID(),
      },
    });
    await useWallet(usdBare, true);
    await give(usdBare, 10);
    const qub = await quoted(usdBare, job(2));
    expect(qub.wallet).toBeNull();
    expect(qub.walletNote).toBe(DOLLARS_NOTE);

    // Fixed in naira with no wallet: told to open one.
    const ngnBare = await h.walletless();
    await h.prisma.personBilling.create({
      data: {
        wawuUserId: ngnBare.id,
        currency: 'NGN',
        fixedBy: 'first_purchase',
        purchaseRef: randomUUID(),
      },
    });
    await useWallet(ngnBare, true);
    await give(ngnBare, 10);
    const qnb = await quoted(ngnBare, job(2));
    expect(qnb.wallet).toBeNull();
    expect(qnb.walletNote).toBe(NO_WALLET_NOTE);

    // A cap that stops the job: buying points would not let it run.
    const capped = await h.buyer(RICH);
    await useWallet(capped, true);
    await give(capped, 10);
    const bigUnits = config.caps.maxAudioMinPerJob + 1;
    const qc = await quoted(capped, job(bigUnits));
    expect(qc.cap).toMatchObject({ cap: 'minutes_per_job' });
    expect(qc.wallet).toBeNull();
    const refused = await request(h.app.getHttpServer())
      .post('/api/hub/points/shortfall')
      .set('Authorization', capped.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send({ ...job(bigUnits), ...fake });
    expect(refused.status).toBe(422);
    expect(reasonOf(refused).code).toBe('points_cap_reached');
    expect(sendsFrom(capped)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Check 4: the caps name themselves and nothing is held
  // ---------------------------------------------------------------------------

  it('check 4: past the daily cap the answer names the cap and when it resets, and nothing is held; a given-back job frees its points for the day', async () => {
    const p = await h.buyer(RICH);
    await lowCap();
    const live = (await quoted(p, job(2))).cap;
    expect(live).toBeNull();
    await give(p, costOf(minuteTool, 2) * 5);
    const total = costOf(minuteTool, 2) * 5;

    const first = await spend.hold({
      wawuUserId: p.id,
      ...job(2),
      reference: ref(),
    });
    const dailyCap = costOf(minuteTool, 2) + 10;
    // The second job would pass the day's cap.
    const q = await quoted(p, job(2));
    expect(q.canRun).toBe(false);
    expect(q.cap).toMatchObject({
      cap: 'daily',
      limit: dailyCap,
      unit: 'points',
      usedPoints: costOf(minuteTool, 2),
      remainingPoints: 10,
      resetsAt: lagosNextDayStart(new Date()).toISOString(),
    });
    expect(q.cap!.message).not.toMatch(/—|–/);
    expect(q.wallet).toBeNull();
    await expect(
      spend.hold({ wawuUserId: p.id, ...job(2), reference: ref() }),
    ).rejects.toMatchObject({
      code: 'points_cap_reached',
      detail: {
        cap: 'daily',
        capLimit: dailyCap,
        capUnit: 'points',
        usedPoints: costOf(minuteTool, 2),
        remainingPoints: 10,
        resetsAt: lagosNextDayStart(new Date()).toISOString(),
      },
    });
    expect(await holdsOf(p)).toHaveLength(1);
    expect(await balanceOf(p)).toBe(total - costOf(minuteTool, 2));

    // A job given back does not count against the day.
    await spend.release(first.holdId);
    const again = await spend.hold({
      wawuUserId: p.id,
      ...job(2),
      reference: ref(),
    });
    expect(again.state).toBe('held');
    await set('points.daily_cap', null);
  });

  it('check 4: over the characters or minutes a job can take, the answer names the cap and nothing is held', async () => {
    const p = await h.buyer(RICH);
    await give(p, costOf(minuteTool, config.caps.maxAudioMinPerJob + 5));
    const tooLong = config.caps.maxAudioMinPerJob + 1;
    const q = await quoted(p, job(tooLong));
    expect(q.cap).toMatchObject({
      cap: 'minutes_per_job',
      limit: config.caps.maxAudioMinPerJob,
      unit: 'minutes',
      usedPoints: null,
      resetsAt: null,
    });
    await expect(
      spend.hold({ wawuUserId: p.id, ...job(tooLong), reference: ref() }),
    ).rejects.toMatchObject({
      code: 'points_cap_reached',
      detail: {
        cap: 'minutes_per_job',
        capLimit: config.caps.maxAudioMinPerJob,
        capUnit: 'minutes',
      },
    });

    const text = config.caps.maxCharsPerJob + 1;
    const qt = await quoted(p, job(1, { characters: text }));
    expect(qt.cap).toMatchObject({
      cap: 'characters_per_job',
      limit: config.caps.maxCharsPerJob,
      unit: 'characters',
    });
    await expect(
      spend.hold({
        wawuUserId: p.id,
        ...job(1),
        characters: text,
        reference: ref(),
      }),
    ).rejects.toMatchObject({
      code: 'points_cap_reached',
      detail: { cap: 'characters_per_job' },
    });
    // At the cap exactly, the job runs.
    const ok = await quoted(
      p,
      job(config.caps.maxAudioMinPerJob, {
        characters: config.caps.maxCharsPerJob,
      }),
    );
    expect(ok.cap).toBeNull();
    expect(await holdsOf(p)).toHaveLength(0);
    expect(await balanceOf(p)).toBe(
      costOf(minuteTool, config.caps.maxAudioMinPerJob + 5),
    );
  });

  it('a cap is a setting: an admin changes the per-job caps and the next quote reads them', async () => {
    const p = await h.buyer(RICH);
    await give(p, 1000);
    await set('points.max_audio_min_per_job', 1);
    await set('points.max_chars_per_job', 50);
    expect((await quoted(p, job(2))).cap).toMatchObject({
      cap: 'minutes_per_job',
      limit: 1,
    });
    expect((await quoted(p, job(1, { characters: 51 }))).cap).toMatchObject({
      cap: 'characters_per_job',
      limit: 50,
    });
    await set('points.max_audio_min_per_job', null);
    await set('points.max_chars_per_job', null);
    expect((await quoted(p, job(2))).cap).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Check 5: two holds at once never take points below zero
  // ---------------------------------------------------------------------------

  it('check 5: two holds at once never take points below zero, and two jobs at once cannot both pass the daily cap', async () => {
    const p = await h.buyer(RICH);
    const one = costOf(minuteTool, 2);
    await give(p, one + one / 2);
    const results = await Promise.allSettled([
      spend.hold({ wawuUserId: p.id, ...job(2), reference: ref() }),
      spend.hold({ wawuUserId: p.id, ...job(2), reference: ref() }),
      spend.hold({ wawuUserId: p.id, ...job(2), reference: ref() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter(
      (x): x is PromiseRejectedResult => x.status === 'rejected',
    ))
      expect(r.reason).toMatchObject({
        code: 'insufficient_points',
      });
    expect(await balanceOf(p)).toBe(one / 2);

    // The daily cap holds under a burst: ten jobs, a cap for two.
    const q = await h.buyer(RICH);
    await give(q, one * 10);
    await set('points.daily_cap', one * 2);
    const burst = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        spend.hold({ wawuUserId: q.id, ...job(2), reference: ref() }),
      ),
    );
    expect(burst.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of burst.filter(
      (x): x is PromiseRejectedResult => x.status === 'rejected',
    ))
      expect(r.reason).toMatchObject({
        code: 'points_cap_reached',
      });
    expect(await balanceOf(q)).toBe(one * 8);
    await set('points.daily_cap', null);
  });

  it('a fresh reference for each attempt: the same reference after a given-back job is refused, never returned as a hold with nothing in it', async () => {
    const p = await h.buyer(RICH);
    await give(p, 1000);
    const jobId = randomUUID();
    const a = await spend.hold({
      wawuUserId: p.id,
      ...job(1),
      reference: jobHoldReference(jobId, 1),
    });
    // The same attempt asked again while it runs answers the same hold, once.
    const replay = await spend.hold({
      wawuUserId: p.id,
      ...job(1),
      reference: jobHoldReference(jobId, 1),
    });
    expect(replay).toMatchObject({ holdId: a.holdId, replayed: true });
    expect(await holdsOf(p)).toHaveLength(1);
    await spend.release(a.holdId);
    await expect(
      spend.hold({
        wawuUserId: p.id,
        ...job(1),
        reference: jobHoldReference(jobId, 1),
      }),
    ).rejects.toMatchObject({ code: 'points_hold_settled' });
    const b = await spend.hold({
      wawuUserId: p.id,
      ...job(1),
      reference: jobHoldReference(jobId, 2),
    });
    expect(b.holdId).not.toBe(a.holdId);
    expect(await balanceOf(p)).toBe(1000 - costOf(minuteTool, 1));
  });

  it("commit and release only settle an AI job, and a stranger cannot reach another person's points", async () => {
    const p = await h.buyer(RICH);
    const q = await h.buyer(RICH);
    await give(p, 1000);
    await give(q, 1000);
    const cashOut = await points.hold({
      wawuUserId: p.id,
      purpose: 'cash_out',
      reference: randomUUID(),
      points: 10,
    });
    await expect(spend.commit(cashOut.holdId)).rejects.toMatchObject({
      code: 'points_hold_not_found',
    });
    await expect(spend.release(cashOut.holdId)).rejects.toMatchObject({
      code: 'points_hold_not_found',
    });
    await expect(spend.release(randomUUID())).rejects.toMatchObject({
      code: 'points_hold_not_found',
    });
    await spend.hold({ wawuUserId: p.id, ...job(1), reference: ref() });
    expect((await quoted(q, job(1))).balancePoints).toBe(1000);
    expect(await balanceOf(q)).toBe(1000);
  });

  // ---------------------------------------------------------------------------
  // The sweep of stale AI holds
  // ---------------------------------------------------------------------------

  it('the sweep gives back an AI hold left past the longest a job may run, by its id, and touches nothing else', async () => {
    const p = await h.buyer(RICH);
    await give(p, 1000);
    const stale = await spend.hold({
      wawuUserId: p.id,
      ...job(1),
      reference: ref(),
    });
    const cash = await points.hold({
      wawuUserId: p.id,
      purpose: 'cash_out',
      reference: randomUUID(),
      points: 5,
    });
    const done = await spend.hold({
      wawuUserId: p.id,
      ...job(1),
      reference: ref(),
    });
    await spend.commit(done.holdId);
    const before = await balanceOf(p);
    expect(before).toBe(1000 - 2 * costOf(minuteTool, 1) - 5);

    // Not yet past the longest run: nothing moves.
    const maxMinutes = settings.number('points.job_max_run_minutes');
    await sweep.run(new Date(Date.now() + (maxMinutes - 1) * 60_000));
    expect(await balanceOf(p)).toBe(before);

    // Past it: the stale AI hold is given back; the conversion's hold and the finished job stay.
    await sweep.run(new Date(Date.now() + (maxMinutes + 1) * 60_000));
    expect(await balanceOf(p)).toBe(before + costOf(minuteTool, 1));
    const rows = await h.prisma.pointHold.findMany({
      where: { wawuUserId: p.id },
    });
    const byId = new Map(rows.map((r) => [r.id, r.state]));
    expect(byId.get(stale.holdId)).toBe('released');
    expect(byId.get(done.holdId)).toBe('committed');
    expect(byId.get(cash.holdId)).toBe('held');
    // A late commit of the swept job is refused, not honoured.
    await expect(spend.commit(stale.holdId)).rejects.toMatchObject({
      code: 'points_hold_settled',
    });
    // The job's longest run is a setting.
    await set('points.job_max_run_minutes', 7);
    expect(settings.number('points.job_max_run_minutes')).toBe(7);
    await set('points.job_max_run_minutes', null);
  });

  it('a late commit and the sweep cannot both win: exactly one settles the hold and the points are never counted twice', async () => {
    const p = await h.buyer(RICH);
    await give(p, 1000);
    const maxMinutes = settings.number('points.job_max_run_minutes');
    const later = new Date(Date.now() + (maxMinutes + 1) * 60_000);
    for (let i = 0; i < 5; i += 1) {
      const held = await spend.hold({
        wawuUserId: p.id,
        ...job(1),
        reference: ref(),
      });
      const [commit] = await Promise.allSettled([
        spend.commit(held.holdId),
        sweep.run(later),
      ]);
      const row = await h.prisma.pointHold.findUniqueOrThrow({
        where: { id: held.holdId },
      });
      expect(['committed', 'released']).toContain(row.state);
      if (commit.status === 'rejected')
        expect(commit.reason).toMatchObject({ code: 'points_hold_settled' });
      expect(row.state).toBe(
        commit.status === 'fulfilled' ? 'committed' : 'released',
      );
    }
    // Every lot still adds up to its ledger (the database refuses otherwise).
    const lots = await h.prisma.pointLot.findMany({
      where: { wawuUserId: p.id },
    });
    expect(
      lots.every((l) => l.remaining >= 0 && l.remaining <= l.quantity),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Nothing is held across the provider call
  // ---------------------------------------------------------------------------

  it("buying the shortfall waits on the provider holding nothing: while it is slow, the same person's hold and balance answer at once", async () => {
    const p = await h.buyer(RICH);
    await useWallet(p, true);
    await give(p, 10);
    const q = await quoted(p, job(2));
    const provider = h.app.get<WalletProvider>(WALLET_PROVIDER);
    const real = provider.walletToWallet.bind(provider);
    const spy = jest
      .spyOn(provider, 'walletToWallet')
      .mockImplementation(async (...args) => {
        await new Promise((r) => setTimeout(r, 3_000));
        return real(...args);
      });
    try {
      const slow = shortfallRoute(p, job(2), q).then((r) => r);
      // Wait until the provider call is in flight.
      const end = Date.now() + 10_000;
      while (spy.mock.calls.length === 0 && Date.now() < end)
        await new Promise((r) => setTimeout(r, 25));
      expect(spy.mock.calls.length).toBe(1);
      const t0 = Date.now();
      const held = await spend.hold({
        wawuUserId: p.id,
        action: useTool.id,
        units: 1,
        reference: ref(),
      });
      const view = await call.points(p);
      const quote = await quoted(p, job(1));
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(held.state).toBe('held');
      expect(view.status).toBe(200);
      expect(quote.costPoints).toBe(costOf(minuteTool, 1));
      const done = await slow;
      expect(done.status).toBe(201);
    } finally {
      spy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // The settings route
  // ---------------------------------------------------------------------------

  it('"Use wallet" takes a true or false and nothing else, is each person\'s own, and turning it off hides the wallet money again', async () => {
    const p = await h.buyer(RICH);
    const q = await h.buyer(RICH);
    for (const bad of ['yes', 1, null, {}, undefined]) {
      const res = await useWallet(p, bad);
      expect(res.status).toBe(400);
    }
    await give(p, 10);
    await useWallet(p, true);
    expect((await quoted(p, job(2))).wallet).not.toBeNull();
    expect((await quoted(q, job(2))).useWallet).toBe(false);
    await useWallet(p, false);
    expect(await quoted(p, job(2))).toMatchObject({
      useWallet: false,
      wallet: null,
    });
    const unauth = await request(h.app.getHttpServer())
      .put('/api/hub/me/points/settings')
      .send({ useWallet: true });
    expect(unauth.status).toBe(401);
  });
});
