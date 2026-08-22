import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CreditPurchaseModule } from '../../credit-purchase/credit-purchase.module';
import { CreditPurchaseService } from '../../credit-purchase/credit-purchase.service';
import { MOCK_FAILURE_TRANSACTION_ID } from '../../credit-purchase/mock-flutterwave.adapter';
import { CreditsStateModule } from '../../credits-state/credits-state.module';
import { CommunityMessageModule } from '../../community-message/community-message.module';
import { CommunityMessageService } from '../../community-message/community-message.service';
import { CreatorEarningsModule } from '../../creator-earnings/creator-earnings.module';
import { CreditSpendModule } from '../credit-spend.module';
import {
  CREDITS_HOST_SHARE_DENOMINATOR,
  CREDITS_HOST_SHARE_NUMERATOR,
  CreditSpendService,
} from '../credit-spend.service';

/**
 * CONTRACT: A COMMUNITY HOST GETS PAID FOR THE CREDITS SPENT IN THEIR ROOM.
 *
 * docs/01_SPEC.md §1 row 4 sells WAWU Credits at "Creator 90% / WAWU 10%",
 * §3 calls that "deliberately a better split than every other stream", and
 * six live app surfaces repeat "you keep 90% of every credit spent in it".
 * Before this suite existed, no code in this backend multiplied anything by
 * 0.9: CreditSpend stored a credit count and no money, and the earnings
 * endpoint excluded credits from `total`, `payable` and `held` outright. A
 * host could run a busy community for a year and earn nothing.
 *
 * These tests pin the model that fixes it (per-pack cost basis, consumed
 * FIFO — see src/credit-spend/credit-spend.service.ts §"THE COST-BASIS
 * MODEL") and, just as importantly, pin the two things that must NOT change
 * with it: a member's credits stay a COUNT everywhere they are shown, and
 * WAWU can never pay out more naira than it actually banked.
 *
 * Buyers are synthetic per-run UUIDs, never the seeded users. Credit lots
 * are per-buyer FIFO state, so borrowing a shared fixture would make every
 * cost-basis assertion depend on what other suites left behind. Hosts have
 * to be the seeded creators (the earnings endpoint is creator-gated) but
 * every earnings assertion is a DELTA, matching the precedent set in
 * src/creator-earnings/tests/creator-earnings.contract.spec.ts.
 */

const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic tier
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Pro tier, hosts the seeded community
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const SEEDED_COMMUNITY_ID = '20000000-0000-4000-8000-000000000001'; // open, hosted by the Pro creator

/** docs/01_SPEC.md §1 row 4 — the locked pack table, restated here as the test's own oracle. */
const PACKS = {
  starter: { naira: 500, credits: 50 }, // ₦10.00 a credit
  popular: { naira: 1000, credits: 120 }, // ₦8.33… a credit
  pro: { naira: 2000, credits: 300 }, // ₦6.66… a credit
} as const;

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('Credit host earnings (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creditPurchases: CreditPurchaseService;
  let creditSpends: CreditSpendService;
  let communityMessages: CommunityMessageService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let basicCreatorToken: string;
  let plainUserToken: string;

  /** Every synthetic buyer this suite invents, so teardown is exact. */
  const buyers: string[] = [];
  /** Communities this suite creates (the seeded one is never mutated). */
  const createdCommunityIds: string[] = [];

  function newBuyer(): string {
    const id = randomUUID();
    buyers.push(id);
    return id;
  }

  /** Buys a pack the way a real member does: init the charge, then verify it. */
  async function buyPack(
    userWawuId: string,
    pack: keyof typeof PACKS,
  ): Promise<string> {
    const init = await creditPurchases.createPurchase(userWawuId, { pack });
    await creditPurchases.verifyPurchase(userWawuId, {
      tx_ref: init.flutterwaveConfig.txRef,
      transaction_id: `mock-tx-${randomUUID()}`,
    });
    return init.flutterwaveConfig.txRef;
  }

  async function earningFor(creditSpendId: string) {
    const earning = await prisma.creditSpendEarning.findUnique({
      where: { creditSpendId },
    });
    if (!earning) throw new Error(`no CreditSpendEarning for ${creditSpendId}`);
    return earning;
  }

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) throw new Error('mock-wawu-id did not become healthy in time');
    }

    basicCreatorToken = await login('creator-basic@test.wawu.dev');
    plainUserToken = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CreditPurchaseModule,
        CreditSpendModule,
        CreditsStateModule,
        CommunityMessageModule,
        CreatorEarningsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    creditPurchases = moduleRef.get(CreditPurchaseService);
    creditSpends = moduleRef.get(CreditSpendService);
    communityMessages = moduleRef.get(CommunityMessageService);
  });

  afterAll(async () => {
    // Exact teardown, by the ids this suite owns — never a broad
    // deleteMany-by-creator, which would delete a concurrently-running
    // suite's rows too (law 16: a spec restores what it mutates).
    if (buyers.length) {
      // CreditSpendEarning cascades off CreditSpend; CreditLot cascades off
      // CreditPurchase. Deleting the two parents is enough.
      await prisma.creditSpend.deleteMany({
        where: { userWawuId: { in: buyers } },
      });
      await prisma.creditPurchase.deleteMany({
        where: { userWawuId: { in: buyers } },
      });
      await prisma.communityMembership.deleteMany({
        where: { userWawuId: { in: buyers } },
      });
      await prisma.communityMessage.deleteMany({
        where: { senderWawuId: { in: buyers } },
      });
      await prisma.creditsState.deleteMany({
        where: { userWawuId: { in: buyers } },
      });
    }
    if (createdCommunityIds.length) {
      await prisma.community.deleteMany({
        where: { id: { in: createdCommunityIds } },
      });
    }
    await app?.close();
    if (ownedMockWawuId) mockWawuId?.kill();
  });

  // -------------------------------------------------------------------
  // The lot: money in
  // -------------------------------------------------------------------

  describe('a completed purchase opens a cost-basis lot', () => {
    it('records the exact kobo WAWU banked and the credits it bought', async () => {
      const buyer = newBuyer();
      await buyPack(buyer, 'popular');

      const lots = await prisma.creditLot.findMany({
        where: { userWawuId: buyer },
      });
      expect(lots).toHaveLength(1);
      expect(lots[0]).toMatchObject({
        creditsGranted: PACKS.popular.credits,
        creditsRemaining: PACKS.popular.credits,
        grossKobo: PACKS.popular.naira * 100,
        allocatedKobo: 0,
      });
    });

    it('opens NO lot for a charge that has not been verified — a host share can never be counted against money that has not cleared', async () => {
      const buyer = newBuyer();
      await creditPurchases.createPurchase(buyer, { pack: 'starter' });

      expect(
        await prisma.creditLot.count({ where: { userWawuId: buyer } }),
      ).toBe(0);
    });

    it('opens NO lot when Flutterwave says the charge failed', async () => {
      const buyer = newBuyer();
      const init = await creditPurchases.createPurchase(buyer, {
        pack: 'starter',
      });
      await expect(
        creditPurchases.verifyPurchase(buyer, {
          tx_ref: init.flutterwaveConfig.txRef,
          transaction_id: MOCK_FAILURE_TRANSACTION_ID,
        }),
      ).rejects.toThrow();

      expect(
        await prisma.creditLot.count({ where: { userWawuId: buyer } }),
      ).toBe(0);
    });

    it('cannot open a second lot if the same purchase is verified twice — no minting free host earnings by replaying a callback', async () => {
      const buyer = newBuyer();
      const init = await creditPurchases.createPurchase(buyer, {
        pack: 'starter',
      });
      const verify = {
        tx_ref: init.flutterwaveConfig.txRef,
        transaction_id: `mock-tx-${randomUUID()}`,
      };
      await creditPurchases.verifyPurchase(buyer, verify);
      await creditPurchases.verifyPurchase(buyer, verify);

      expect(
        await prisma.creditLot.count({ where: { userWawuId: buyer } }),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // The split: money out
  // -------------------------------------------------------------------

  describe('a spent credit pays the host 90% of what that credit actually cost', () => {
    it('₦500/50 pack -> ₦10.00 a credit -> ₦9.00 to the host, ₦1.00 to WAWU', async () => {
      const buyer = newBuyer();
      await buyPack(buyer, 'starter');

      const spend = await creditSpends.record({
        userWawuId: buyer,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });
      const earning = await earningFor(spend.id);

      expect(earning.creditsSpent).toBe(1);
      expect(earning.creditsFunded).toBe(1);
      expect(earning.grossKobo).toBe(1000); // ₦10.00
      expect(earning.hostShareKobo).toBe(900); // ₦9.00
      expect(earning.platformShareKobo).toBe(100); // ₦1.00
      expect(earning.hostShareKobo / earning.grossKobo).toBeCloseTo(0.9, 10);
      expect(earning.lotIds).toHaveLength(1);
    });

    it('carries EACH pack its own cost basis — ₦8.33 and ₦6.67 a credit, never one blended platform rate', async () => {
      const popularBuyer = newBuyer();
      await buyPack(popularBuyer, 'popular');
      const popularSpend = await creditSpends.record({
        userWawuId: popularBuyer,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });
      const popular = await earningFor(popularSpend.id);

      const proBuyer = newBuyer();
      await buyPack(proBuyer, 'pro');
      const proSpend = await creditSpends.record({
        userWawuId: proBuyer,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });
      const proPack = await earningFor(proSpend.id);

      // ₦1,000 / 120 = 833.33 kobo; ₦2,000 / 300 = 666.67 kobo.
      expect(popular.grossKobo).toBe(833);
      expect(proPack.grossKobo).toBe(666);
      // The whole point: the same "1 credit" is worth different money, and
      // the host's share tracks the money, not the count.
      expect(popular.grossKobo).not.toBe(proPack.grossKobo);
      expect(popular.hostShareKobo).toBe(Math.floor(833 * 0.9)); // 749
      expect(proPack.hostShareKobo).toBe(Math.floor(666 * 0.9)); // 599
    });

    it('never pays out more than was banked — the residual kobo of the 90% stays with WAWU', async () => {
      const buyer = newBuyer();
      await buyPack(buyer, 'popular');
      const spend = await creditSpends.record({
        userWawuId: buyer,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });
      const earning = await earningFor(spend.id);

      expect(earning.hostShareKobo + earning.platformShareKobo).toBe(
        earning.grossKobo,
      );
      expect(earning.hostShareKobo).toBeLessThanOrEqual(
        (earning.grossKobo * CREDITS_HOST_SHARE_NUMERATOR) /
          CREDITS_HOST_SHARE_DENOMINATOR,
      );
      expect(earning.platformShareKobo).toBeGreaterThanOrEqual(
        earning.grossKobo * 0.1,
      );
    });

    it('draws the OLDEST lot first (FIFO), so the first credit of a member who bought starter-then-pro is worth ₦10, not ₦6.67', async () => {
      const buyer = newBuyer();
      await buyPack(buyer, 'starter');
      await buyPack(buyer, 'pro');

      const spend = await creditSpends.record({
        userWawuId: buyer,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });
      const earning = await earningFor(spend.id);
      expect(earning.grossKobo).toBe(1000);

      const [older, newer] = await prisma.creditLot.findMany({
        where: { userWawuId: buyer },
        orderBy: { purchasedAt: 'asc' },
      });
      expect(older.creditsRemaining).toBe(PACKS.starter.credits - 1);
      expect(newer.creditsRemaining).toBe(PACKS.pro.credits);
    });

    it('a fully drained lot allocates EXACTLY the naira banked — no kobo invented, none lost, on a pack whose per-credit price does not divide evenly', async () => {
      const buyer = newBuyer();
      await buyPack(buyer, 'popular'); // ₦1,000 / 120 credits = 833.33… kobo

      let grossTotal = 0;
      let hostTotal = 0;
      for (let i = 0; i < PACKS.popular.credits; i += 1) {
        const spend = await creditSpends.record({
          userWawuId: buyer,
          communityId: SEEDED_COMMUNITY_ID,
          creatorWawuId: USER_CREATOR_PRO,
        });
        const earning = await earningFor(spend.id);
        grossTotal += earning.grossKobo;
        hostTotal += earning.hostShareKobo;
      }

      const lot = await prisma.creditLot.findFirstOrThrow({
        where: { userWawuId: buyer },
      });
      expect(lot.creditsRemaining).toBe(0);
      expect(lot.allocatedKobo).toBe(PACKS.popular.naira * 100);
      expect(grossTotal).toBe(PACKS.popular.naira * 100); // exactly ₦1,000

      // 90% of ₦1,000 is ₦900. Flooring per spend can only cost the host
      // sub-kobo dust, never a naira, and never the other way.
      expect(hostTotal).toBeLessThanOrEqual(90000);
      expect(hostTotal).toBeGreaterThan(90000 - PACKS.popular.credits);
    });

    it('stops paying once the lot is empty — an unfunded credit is worth ₦0 because it cost ₦0', async () => {
      const buyer = newBuyer();
      await buyPack(buyer, 'starter');
      for (let i = 0; i < PACKS.starter.credits; i += 1) {
        await creditSpends.record({
          userWawuId: buyer,
          communityId: SEEDED_COMMUNITY_ID,
          creatorWawuId: USER_CREATOR_PRO,
        });
      }

      const overspend = await creditSpends.record({
        userWawuId: buyer,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });
      const earning = await earningFor(overspend.id);
      expect(earning.creditsSpent).toBe(1);
      expect(earning.creditsFunded).toBe(0);
      expect(earning.grossKobo).toBe(0);
      expect(earning.hostShareKobo).toBe(0);
      expect(earning.lotIds).toEqual([]);
    });
  });

  describe('the credits split is 90/10 for EVERY tier — it is not the Pro override', () => {
    it('a Basic-tier host and a Pro-tier host earn the identical share on an identical credit', async () => {
      // docs/01_SPEC.md §1 row 8 scopes the Pro upgrade to "streams 1, 2, 3,
      // 5, 6" — credits are stream 4 and are deliberately absent from it;
      // §3 says the 90% is "deliberately a better split than every other
      // stream". So tier must make no difference here.
      const basicCommunity = await prisma.community.create({
        data: {
          name: 'TEST: basic-hosted room',
          description: 'credit-earnings contract fixture',
          hostWawuId: USER_CREATOR_BASIC,
          kind: 'open',
        },
      });
      createdCommunityIds.push(basicCommunity.id);

      const buyerA = newBuyer();
      await buyPack(buyerA, 'starter');
      const toBasic = await creditSpends.record({
        userWawuId: buyerA,
        communityId: basicCommunity.id,
        creatorWawuId: USER_CREATOR_BASIC,
      });

      const buyerB = newBuyer();
      await buyPack(buyerB, 'starter');
      const toPro = await creditSpends.record({
        userWawuId: buyerB,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });

      const basicEarning = await earningFor(toBasic.id);
      const proEarning = await earningFor(toPro.id);

      expect(basicEarning.hostShareKobo).toBe(900);
      expect(proEarning.hostShareKobo).toBe(900);
      expect(basicEarning.hostShareKobo).toBe(proEarning.hostShareKobo);
    });
  });

  // -------------------------------------------------------------------
  // The real send path, including the trial
  // -------------------------------------------------------------------

  describe('sending a real message in a community', () => {
    async function joinedBuyer(
      communityId: string,
      pack?: keyof typeof PACKS,
    ): Promise<string> {
      const buyer = newBuyer();
      await prisma.communityMembership.create({
        data: {
          userWawuId: buyer,
          communityId,
          status: 'joined',
          joinedAt: new Date(),
        },
      });
      if (pack) await buyPack(buyer, pack);
      return buyer;
    }

    it('pays the host their 90% end to end, from POST-shaped send through to the earnings ledger', async () => {
      const buyer = await joinedBuyer(SEEDED_COMMUNITY_ID, 'starter');

      await communityMessages.create(SEEDED_COMMUNITY_ID, buyer, {
        text: 'Paying for this one with a real credit.',
      });

      const spend = await prisma.creditSpend.findFirstOrThrow({
        where: { userWawuId: buyer },
      });
      const earning = await earningFor(spend.id);
      expect(earning.creatorWawuId).toBe(USER_CREATOR_PRO);
      expect(earning.creditsFunded).toBe(1);
      expect(earning.hostShareKobo).toBe(900);

      // The member's balance still moved by exactly one credit.
      const state = await prisma.creditsState.findUniqueOrThrow({
        where: { userWawuId: buyer },
      });
      expect(state.creditBalance).toBe(PACKS.starter.credits - 1);
    });

    it('a TRIAL-covered message earns the host ₦0 — WAWU banked nothing, so there is no 90% of anything — but it still counts as a credit spent', async () => {
      // docs/01_SPEC.md §3: a 7-day free trial precedes any purchase. The
      // sender pays nothing, so the platform receives nothing, so the host's
      // share of it is nothing. Paying a notional value would have WAWU
      // handing out real naira against revenue it never received. The
      // activity is still visible to the host as a credit COUNT.
      const buyer = await joinedBuyer(SEEDED_COMMUNITY_ID);

      await communityMessages.create(SEEDED_COMMUNITY_ID, buyer, {
        text: 'Sent inside my free trial.',
      });

      const state = await prisma.creditsState.findUniqueOrThrow({
        where: { userWawuId: buyer },
      });
      expect(state.creditBalance).toBe(0);
      expect(state.trialEndsAt.getTime()).toBeGreaterThan(Date.now());

      const spend = await prisma.creditSpend.findFirstOrThrow({
        where: { userWawuId: buyer },
      });
      expect(spend.creditsSpent).toBe(1); // the COUNT is unaffected

      const earning = await earningFor(spend.id);
      expect(earning.creditsSpent).toBe(1);
      expect(earning.creditsFunded).toBe(0);
      expect(earning.grossKobo).toBe(0);
      expect(earning.hostShareKobo).toBe(0);
      expect(earning.platformShareKobo).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------

  describe('GET /content/mine/earnings', () => {
    it('adds the host’s credit share to payable and total, keeps the breakdown amount a COUNT, and reports the money in earningsNaira', async () => {
      const before = await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      const community = await prisma.community.create({
        data: {
          name: 'TEST: earnings rollup room',
          description: 'credit-earnings contract fixture',
          hostWawuId: USER_CREATOR_BASIC,
          kind: 'open',
        },
      });
      createdCommunityIds.push(community.id);

      const buyer = newBuyer();
      await buyPack(buyer, 'starter'); // ₦10.00 a credit
      for (let i = 0; i < 3; i += 1) {
        await creditSpends.record({
          userWawuId: buyer,
          communityId: community.id,
          creatorWawuId: USER_CREATOR_BASIC,
        });
      }

      const after = await request(app.getHttpServer())
        .get('/content/mine/earnings')
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      const b = before.body.data;
      const a = after.body.data;

      // 3 credits x ₦10.00 x 90% = ₦27.00 — the thing that used to be ₦0.
      expect(a.payable - b.payable).toBeCloseTo(27, 5);
      expect(a.total - b.total).toBeCloseTo(27, 5);
      // Never held: the member's money cleared at purchase and the message
      // was delivered instantly. There is no DM-style response escrow.
      expect(a.held - b.held).toBeCloseTo(0, 5);

      interface BreakdownEntry {
        stream: string;
        amount: number;
        earningsNaira: number;
      }
      const entry = (body: { streamBreakdown: BreakdownEntry[] }) => {
        const found = body.streamBreakdown.find(
          (e) => e.stream === 'community_credits',
        );
        if (!found) throw new Error('no community_credits breakdown entry');
        return found;
      };

      // `amount` is still the COUNT the shipped app prints as "N credits".
      expect(entry(a).amount - entry(b).amount).toBe(3);
      // `earningsNaira` is the money, and it is the 90%.
      expect(entry(a).earningsNaira - entry(b).earningsNaira).toBeCloseTo(
        27,
        5,
      );

      // Every stream carries an earningsNaira; for the naira streams it is
      // simply the same figure, so a client can total one field safely.
      for (const e of a.streamBreakdown as BreakdownEntry[]) {
        expect(typeof e.earningsNaira).toBe('number');
        if (e.stream !== 'community_credits') {
          expect(e.earningsNaira).toBeCloseTo(e.amount, 5);
        }
      }

      const creditSale = a.recentSales.find(
        (s: { source: string }) => s.source === 'community_credits',
      );
      expect(creditSale).toBeDefined();
      // The sale row keeps its count in `amount` (the app renders
      // `${amount} credits`) and puts the naira in `earningsNaira`.
      expect(creditSale.amount).toBe(1);
      expect(creditSale.earningsNaira).toBeCloseTo(9, 5);
    });
  });

  describe('nothing user-facing turns a credit into naira', () => {
    it('GET /credits still answers with a plain count and no money field anywhere', async () => {
      const res = await request(app.getHttpServer())
        .get('/credits')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      const body = res.body.data;
      expect(body.userWawuId).toBe(USER_PLAIN);
      expect(Number.isInteger(body.creditBalance)).toBe(true);
      expect(Object.keys(body).sort()).toEqual([
        'creditBalance',
        'trialEndsAt',
        'userWawuId',
      ]);
    });

    it('keeps the naira out of the credit tables a member can reach — CreditsState holds a count and nothing else', async () => {
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'CreditsState'
      `;
      expect(columns.map((c) => c.column_name).sort()).toEqual([
        'creditBalance',
        'trialEndsAt',
        'userWawuId',
      ]);
    });
  });
});
