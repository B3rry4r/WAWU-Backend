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
 * WAWU Credits pay the community host 85% of what was actually spent in
 * their room, and WAWU keeps 15%. That is the same split as every other
 * stream: the product owner collapsed the credits rate from 90/10 to 85/15
 * on 21 Sep 2026 ("Credits follow 85 15"), so there is now exactly one split
 * in the product and no tier or stream overrides it.
 *
 * Before this suite existed, no code in this backend multiplied anything at
 * all: CreditSpend stored a credit count and no money, and the earnings
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

  describe('a spent credit pays the host 85% of what that credit actually cost', () => {
    it('₦500/50 pack -> ₦10.00 a credit -> ₦8.50 to the host, ₦1.50 to WAWU', async () => {
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
      // 1000 x 17 / 20 = 850 exactly, nothing to floor.
      expect(earning.hostShareKobo).toBe(850); // ₦8.50
      expect(earning.platformShareKobo).toBe(150); // ₦1.50
      expect(earning.hostShareKobo / earning.grossKobo).toBeCloseTo(0.85, 10);
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
      // Integer maths, not `* 0.85`, for the same reason the service uses a
      // numerator/denominator: 833 x 17 / 20 = 708.05 -> 708 kobo, and
      // 666 x 17 / 20 = 566.1 -> 566 kobo.
      expect(popular.hostShareKobo).toBe(Math.floor((833 * 17) / 20)); // 708
      expect(proPack.hostShareKobo).toBe(Math.floor((666 * 17) / 20)); // 566
    });

    it('never pays out more than was banked — the residual kobo of the 85% stays with WAWU', async () => {
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
        earning.grossKobo * 0.15,
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

      // 85% of ₦1,000 is ₦850 (85,000 kobo). Flooring per spend can only
      // cost the host sub-kobo dust, never a naira, and never the other way.
      //
      // The exact figure, recomputed by hand for the 85/15 split: the lot
      // allocates 100,000 kobo across 120 credits by largest remainder, so
      // each spend draws either 833 or 834 kobo. floor(833 x 17 / 20) =
      // floor(708.05) = 708 and floor(834 x 17 / 20) = floor(708.9) = 708,
      // so every one of the 120 spends pays the host exactly 708 kobo:
      // 708 x 120 = 84,960 kobo, 40 kobo of dust short of the round 85,000.
      expect(hostTotal).toBe(84960);
      expect(hostTotal).toBeLessThanOrEqual(85000);
      expect(hostTotal).toBeGreaterThan(85000 - PACKS.popular.credits);
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

  describe('the credits split is 85/15 for EVERY host, whatever their tier', () => {
    it('a Basic-tier host and a Pro-tier host earn the identical share on an identical credit', async () => {
      // This used to guard a 90/10 credits rate against being collapsed into
      // the 85/15 everything-else rate. The product owner collapsed it
      // deliberately on 21 Sep 2026, so what is left to guard is the part
      // that never depended on the rate: tier must make no difference here,
      // and CreditSpendService must not consult CreatorState.tier.
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

      expect(basicEarning.hostShareKobo).toBe(850);
      expect(proEarning.hostShareKobo).toBe(850);
      expect(basicEarning.hostShareKobo).toBe(proEarning.hostShareKobo);
    });
  });

  // -------------------------------------------------------------------
  // The real send path
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

    it('pays the host their 85% end to end, from POST-shaped send through to the earnings ledger', async () => {
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
      expect(earning.hostShareKobo).toBe(850); // 1000 kobo x 17 / 20

      // The member's balance still moved by exactly one credit.
      const state = await prisma.creditsState.findUniqueOrThrow({
        where: { userWawuId: buyer },
      });
      expect(state.creditBalance).toBe(PACKS.starter.credits - 1);
    });

    /**
     * REWRITTEN ON 21 SEP 2026. This used to be "a TRIAL-covered message
     * earns the host ₦0". The 7-day free trial is gone, so a sender with no
     * credits at all no longer reaches this path: they are 402'd (covered in
     * community-message.contract.spec.ts).
     *
     * The rule the test actually pinned survives the trial, because the
     * trial was only one way to hold a credit nobody paid for. A balance
     * with no CreditLot behind it — seeded, admin-granted or legacy — is
     * still spendable and still cost WAWU nothing, so 85% of nothing is
     * nothing. That is the fixture now, and it keeps the ₦0-earning case
     * covered through the REAL send path rather than only through
     * CreditSpendService.record directly.
     */
    it('an UNFUNDED credit earns the host ₦0 — WAWU banked nothing, so there is no 85% of anything — but it still counts as a credit spent', async () => {
      const buyer = await joinedBuyer(SEEDED_COMMUNITY_ID);
      // A balance with no purchase behind it: no CreditLot is created.
      await prisma.creditsState.create({
        data: { userWawuId: buyer, creditBalance: 1 },
      });

      await communityMessages.create(SEEDED_COMMUNITY_ID, buyer, {
        text: 'Sent with a credit nobody ever paid for.',
      });

      const state = await prisma.creditsState.findUniqueOrThrow({
        where: { userWawuId: buyer },
      });
      // The balance is still debited: the credit was real to the sender.
      expect(state.creditBalance).toBe(0);
      // No trial is opened on this path any more.
      expect(state.trialEndsAt).toBeNull();
      expect(
        await prisma.creditLot.count({ where: { userWawuId: buyer } }),
      ).toBe(0);

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

      // 3 credits x ₦10.00 x 85% = ₦25.50 — the thing that used to be ₦0.
      // Per credit: 1000 kobo x 17 / 20 = 850 kobo exactly (nothing to
      // floor), so 3 x 850 = 2,550 kobo = ₦25.50.
      expect(a.payable - b.payable).toBeCloseTo(25.5, 5);
      expect(a.total - b.total).toBeCloseTo(25.5, 5);
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
      // `earningsNaira` is the money, and it is the 85%.
      expect(entry(a).earningsNaira - entry(b).earningsNaira).toBeCloseTo(
        25.5,
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
      expect(creditSale.earningsNaira).toBeCloseTo(8.5, 5); // 850 kobo
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
      // `trialEndsAt` is a LEGACY column: the 21 Sep 2026 migration made it
      // nullable rather than dropping it (an older instance still selects it
      // mid-deploy), so it is still on the wire and still carries no money.
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
