import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  clearCommunities,
  parseArgs,
  phraseFor,
  type Deps,
  type Options,
} from '../../../scripts/ops/clear-communities';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { InboxModule } from '../../inbox/inbox.module';
import { InboxService } from '../../inbox/inbox.service';
import { MeModule } from '../../me/me.module';
import { MeEarningsService } from '../../me/me-earnings.service';
import { MeNotificationsService } from '../../me/me-notifications.service';
import { SearchHistoryService } from '../../search-response/search-history.service';
import { SearchResponseModule } from '../../search-response/search-response.module';
import { CommunityModule } from '../community.module';
import { CommunityService } from '../community.service';
import { CommunityRoomsService } from '../rooms/community-rooms.service';

/**
 * OPS-CLEAR-ROOMS (R-136): the one-off command that clears every community on the Hub, on the owner's word.
 * Made-up people and rooms only, on the test database. The wallet provider's settings the command reads (`getEnv`)
 * are given sandbox-looking or live-looking values; no provider is called.
 */
const SANDBOX_ENV: Record<string, string> = {
  WALLET_PROVIDER: 'fintava',
  FINTAVA_BASE_URL: 'https://dev.fintavapay.com',
};
const LIVE_ENV: Record<string, string> = {
  WALLET_PROVIDER: 'fintava',
  FINTAVA_BASE_URL: 'https://live.fintavapay.com',
};
const MERCHANT = '1102038668';

describe('clear-communities (OPS-CLEAR-ROOMS)', () => {
  let prisma: PrismaService;
  let closeApp: () => Promise<void>;
  let inbox: InboxService;
  let rooms: CommunityRoomsService;
  let communities: CommunityService;
  let notifications: MeNotificationsService;
  let earnings: MeEarningsService;
  let search: SearchHistoryService;

  const host = randomUUID();
  const member = randomUUID();
  const tag = `ocr-${randomUUID().slice(0, 8)}`;
  const ids: Record<string, string> = {};
  const paymentIds: string[] = [];
  const notificationIds: string[] = [];

  async function room(key: string, kind: 'open' | 'private' = 'open') {
    const id = randomUUID();
    ids[key] = id;
    await prisma.community.create({
      data: {
        id,
        name: `${tag} ${key}`,
        description: 'FIXTURE: ops-clear-communities.contract.spec.ts',
        hostWawuId: host,
        kind,
        imageUrl: key === 'plain' ? 'https://storage.test/ocr-cover.jpg' : null,
      },
    });
    await prisma.communityMembership.create({
      data: { userWawuId: member, communityId: id, joinedAt: new Date() },
    });
    return id;
  }

  async function payment(provider: string, status = 'completed') {
    const id = randomUUID();
    paymentIds.push(id);
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: member,
        payeeWawuUserId: host,
        kind: 'community_pass',
        targetId: id,
        title: 'A room pass',
        priceKobo: 100000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 100000n,
        payeeShareKobo: 85000n,
        wawuShareKobo: 15000n,
        customerReference: `ocr-${id}`,
        merchantAccountNumber: MERCHANT,
        provider,
        status,
      },
    });
    return id;
  }

  async function pass(communityId: string, paymentId: string) {
    await prisma.communityPass.create({
      data: {
        communityId,
        userWawuId: member,
        walletPaymentId: paymentId,
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 20 * 86400000),
        priceKobo: 100000n,
      },
    });
  }

  /** Credits spent in a room: a purchase (wallet when `walletPaymentId`, else Flutterwave), its lot, a spend, the host's earning. */
  async function fundedSpend(
    communityId: string,
    walletPaymentId: string | null,
    settlement: 'landed' | 'owed' | 'none',
  ) {
    const purchaseId = randomUUID();
    await prisma.creditPurchase.create({
      data: {
        id: purchaseId,
        userWawuId: member,
        pack: 'starter',
        creditsGranted: 50,
        flutterwaveTxRef: walletPaymentId
          ? `wallet:${walletPaymentId}`
          : `ocr-fw-${purchaseId}`,
        amount: 500,
        status: 'completed',
        walletPaymentId,
      },
    });
    const lot = await prisma.creditLot.create({
      data: {
        creditPurchaseId: purchaseId,
        userWawuId: member,
        creditsGranted: 50,
        creditsRemaining: 49,
        grossKobo: 50000,
        allocatedKobo: 1000,
      },
    });
    const spend = await prisma.creditSpend.create({
      data: {
        userWawuId: member,
        communityId,
        creditsSpent: 1,
        creatorWawuId: host,
      },
    });
    const earning = await prisma.creditSpendEarning.create({
      data: {
        creditSpendId: spend.id,
        creatorWawuId: host,
        communityId,
        creditsSpent: 1,
        creditsFunded: 1,
        grossKobo: 1000,
        hostShareKobo: 850,
        platformShareKobo: 150,
        lotIds: [lot.id],
      },
    });
    if (settlement !== 'none') {
      await prisma.earningSettlement.create({
        data: {
          creditSpendEarningId: earning.id,
          payeeWawuUserId: host,
          kind: 'community_credits',
          targetId: communityId,
          title: 'Credits',
          earnedAt: new Date(),
          amountKobo: 850n,
          merchantAccountNumber: MERCHANT,
          customerReference: `wawu-earn-cs-${earning.id}`,
          status: settlement,
          settledAt: settlement === 'landed' ? new Date() : null,
          sentAt: settlement === 'landed' ? new Date() : null,
          destinationAccountNumber:
            settlement === 'landed' ? '8000000001' : null,
        },
      });
    }
    return { purchaseId, lotId: lot.id, earningId: earning.id };
  }

  async function notice(
    communityId: string,
    kind: string,
    withNotice: boolean,
    userWawuId = member,
  ) {
    const id = randomUUID();
    notificationIds.push(id);
    await prisma.notification.create({
      data: { id, userWawuId, kind, title: 'T', body: 'B', tone: 'info' },
    });
    await prisma.notificationTarget.create({
      data: {
        notificationId: id,
        targetKind: 'community',
        targetId: communityId,
      },
    });
    if (withNotice) {
      await prisma.communityMessageNotice.create({
        data: {
          notificationId: id,
          userWawuId,
          communityId,
          messageCount: 3,
          lastMessageAt: new Date(),
          countedUpTo: new Date(),
        },
      });
    }
    return id;
  }

  /** Row count of every table: the proof that a run wrote nothing. */
  async function snapshot(): Promise<Record<string, number>> {
    const rows = await prisma.$queryRawUnsafe<{ t: string; c: number }[]>(
      `select table_name as t, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as c
       from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    return Object.fromEntries(rows.map((r) => [r.t, r.c]));
  }

  async function run(
    over: Partial<Options> = {},
    env: Record<string, string> = SANDBOX_ENV,
  ) {
    const lines: string[] = [];
    const deps: Deps = {
      prisma,
      getEnv: (k) => env[k],
      out: (l) => lines.push(l),
      onlyIds: Object.values(ids),
    };
    const code = await clearCommunities(deps, { apply: false, ...over });
    return { code, text: lines.join('\n') };
  }

  const phraseOf = (text: string) => /Confirmation phrase: (.*)/.exec(text)![1];
  const exists = (key: string) =>
    prisma.community.count({ where: { id: ids[key] } }).then((n) => n === 1);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        CommunityModule,
        InboxModule,
        MeModule,
        SearchResponseModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    closeApp = () => app.close();
    prisma = moduleRef.get(PrismaService);
    const get = <T>(t: new (...a: never[]) => T) =>
      moduleRef.get(t, { strict: false });
    inbox = get(InboxService);
    rooms = get(CommunityRoomsService);
    communities = get(CommunityService);
    notifications = get(MeNotificationsService);
    earnings = get(MeEarningsService);
    search = get(SearchHistoryService);

    // Cleared in a sandbox: a plain room with everything that cascades, and the rows that do not.
    const plain = await room('plain');
    await prisma.communityMessage.createMany({
      data: [
        { communityId: plain, senderWawuId: host, text: 'one' },
        { communityId: plain, senderWawuId: member, text: 'two' },
      ],
    });
    await prisma.communityReadMarker.create({
      data: { userWawuId: member, communityId: plain, lastReadAt: new Date() },
    });
    await prisma.communityMute.create({
      data: { communityId: plain, userWawuId: member, mutedByWawuId: host },
    });
    await prisma.communityLink.create({
      data: { communityId: plain, slug: `${tag}-plain` },
    });
    await prisma.communityPassPrice.create({
      data: { communityId: plain, priceKobo: 100000n },
    });
    await prisma.communityModerationLog.create({
      data: {
        communityId: plain,
        actorWawuId: host,
        action: 'member_muted',
        targetWawuId: member,
      },
    });
    await prisma.communityNoticeRetry.create({
      data: {
        communityId: plain,
        fromAt: new Date(),
        retryAt: new Date(Date.now() + 60000),
      },
    });
    // A spend from before the earning ledger existed: no earning row, no money record.
    await prisma.creditSpend.create({
      data: {
        userWawuId: member,
        communityId: plain,
        creditsSpent: 1,
        creatorWawuId: host,
      },
    });
    await notice(plain, 'community_messages', true);
    await notice(plain, 'community_join_approved', false);
    await notice(plain, 'community_join_declined', false);

    // Cleared in a sandbox: a pass paid at the provider this server runs, with its payment.
    const sandboxPass = await room('sandboxPass', 'private');
    await prisma.communityPassPrice.create({
      data: { communityId: sandboxPass, priceKobo: 100000n },
    });
    await pass(sandboxPass, await payment('fintava'));
    // Cleared: credits bought from the wallet, the host's earning landed.
    const walletCredits = await room('walletCredits');
    const walletPay = await payment('fintava');
    await fundedSpend(walletCredits, walletPay, 'landed');
    // Cleared: a refund that settled stays as money history.
    const settled = await room('settledRefund', 'private');
    await prisma.communityPassRefund.create({
      data: {
        communityId: settled,
        userWawuId: member,
        hostWawuId: host,
        removedAt: new Date(),
        unusedDays: 10,
        amountKobo: 30000n,
        hostShareKobo: 25500n,
        merchantAccountNumber: MERCHANT,
        customerReference: `ocr-ref-${settled}`,
        status: 'refunded',
        settledAt: new Date(),
      },
    });
    // Kept: credits bought through Flutterwave.
    const fw = await room('flutterwave');
    await fundedSpend(fw, null, 'none');
    // Kept: a pass paid at the other provider.
    const other = await room('otherProviderPass', 'private');
    await pass(other, await payment('nuvion'));
    // Kept: a refund still pending.
    const pending = await room('pendingRefund', 'private');
    await prisma.communityPassRefund.create({
      data: {
        communityId: pending,
        userWawuId: member,
        hostWawuId: host,
        removedAt: new Date(),
        unusedDays: 10,
        amountKobo: 30000n,
        hostShareKobo: 25500n,
        merchantAccountNumber: MERCHANT,
        customerReference: `ocr-ref-${pending}`,
      },
    });
    // Kept: a pass payment still in flight.
    const flight = await room('inFlight', 'private');
    const flightPay = await payment('fintava', 'pending');
    await prisma.walletPayment.update({
      where: { id: flightPay },
      data: { targetId: flight },
    });
    // Kept: the host's earning has not landed yet.
    const owed = await room('owedEarning');
    await fundedSpend(owed, await payment('fintava'), 'owed');
    // A notice for a room that stays.
    await notice(other, 'community_messages', true);
  });

  afterAll(async () => {
    if (prisma) {
      const all = Object.values(ids);
      await prisma.earningSettlement.deleteMany({
        where: { payeeWawuUserId: host },
      });
      await prisma.notification.deleteMany({
        where: { userWawuId: member },
      });
      await prisma.communityPassRefund.deleteMany({
        where: { hostWawuId: host },
      });
      await prisma.community.deleteMany({ where: { id: { in: all } } });
      await prisma.communityNoticeRetry.deleteMany({
        where: { communityId: { in: all } },
      });
      await prisma.communityModerationLog.deleteMany({
        where: { actorWawuId: host },
      });
      await prisma.creditLot.deleteMany({ where: { userWawuId: member } });
      await prisma.creditPurchase.deleteMany({
        where: { userWawuId: member },
      });
      await prisma.walletPayment.deleteMany({
        where: { id: { in: paymentIds } },
      });
    }
    if (closeApp) await closeApp();
  });

  it('a dry run writes nothing and lists every room, the money it keeps and the phrase', async () => {
    const before = await snapshot();
    const { code, text } = await run();
    expect(code).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(text).toContain('DRY RUN (nothing is written)');
    expect(text).toContain('Communities on the Hub: 9');
    for (const k of Object.keys(ids)) expect(text).toContain(`${tag} ${k}`);
    expect(text).toContain('-> would clear');
    expect(text).toContain('-> KEPT, real money:');
    expect(text).toContain('flutterwave');
    expect(text).toContain('passes 1 (active 1, paid 100000 kobo)');
    expect(text).toContain('cover yes (stays in storage)');
    expect(text).toContain('1 with no earning record');
    expect(phraseOf(text)).toBe(phraseFor(4));
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it('refuses without the phrase, with a wrong phrase and with an unknown flag', async () => {
    const before = await snapshot();
    const none = await run({ apply: true });
    expect(none.code).toBe(1);
    const wrong = await run({ apply: true, confirm: 'CLEAR 1 COMMUNITIES' });
    expect(wrong.code).toBe(1);
    expect(wrong.text).toContain('REFUSED');
    expect(await snapshot()).toEqual(before);
    expect(typeof parseArgs(['--apply', '--force'])).toBe('string');
    expect(typeof parseArgs(['--allow-money'])).toBe('string');
    expect(parseArgs(['--apply', '--confirm', 'CLEAR 4 COMMUNITIES'])).toEqual({
      apply: true,
      confirm: 'CLEAR 4 COMMUNITIES',
    });
  });

  it('on live keys the passes and wallet credits are real money, so only the room with none is cleared', async () => {
    const dry = await run({}, LIVE_ENV);
    expect(dry.text).toContain('NOT proven to be on test credentials');
    // plain and settledRefund have no pass and no funded credit.
    expect(phraseOf(dry.text)).toBe(phraseFor(2));
    const bad = await run({ apply: true, confirm: phraseFor(4) }, LIVE_ENV);
    expect(bad.code).toBe(1);
    expect(await exists('sandboxPass')).toBe(true);
    expect(await exists('walletCredits')).toBe(true);
  });

  it('apply clears exactly the listed rooms and keeps every room with real money', async () => {
    const { code, text } = await run({
      apply: true,
      confirm: phraseFor(4),
    });
    expect(code).toBe(0);
    expect(text).toContain('Cleared');
    for (const k of ['plain', 'sandboxPass', 'walletCredits', 'settledRefund'])
      expect(await exists(k)).toBe(false);
    for (const k of [
      'flutterwave',
      'otherProviderPass',
      'pendingRefund',
      'inFlight',
      'owedEarning',
    ])
      expect(await exists(k)).toBe(true);
    const gone = [
      ids.plain,
      ids.sandboxPass,
      ids.walletCredits,
      ids.settledRefund,
    ];
    const where = { communityId: { in: gone } };
    expect(await prisma.communityMembership.count({ where })).toBe(0);
    expect(await prisma.communityMessage.count({ where })).toBe(0);
    expect(await prisma.communityReadMarker.count({ where })).toBe(0);
    expect(await prisma.communityMute.count({ where })).toBe(0);
    expect(await prisma.communityLink.count({ where })).toBe(0);
    expect(await prisma.communityPassPrice.count({ where })).toBe(0);
    expect(await prisma.communityPass.count({ where })).toBe(0);
    expect(await prisma.creditSpend.count({ where })).toBe(0);
    expect(await prisma.creditSpendEarning.count({ where })).toBe(0);
    expect(await prisma.communityModerationLog.count({ where })).toBe(0);
    expect(await prisma.communityNoticeRetry.count({ where })).toBe(0);
    expect(await prisma.communityMessageNotice.count({ where })).toBe(0);
    expect(
      await prisma.communityMessageNotice.count({
        where: { communityId: ids.otherProviderPass },
      }),
    ).toBe(1);
    expect(
      await prisma.earningSettlement.count({
        where: { payeeWawuUserId: host, targetId: ids.walletCredits },
      }),
    ).toBe(0);
    // Money history stays: the payments, the settled refund, the credit purchases.
    expect(
      await prisma.walletPayment.count({ where: { id: { in: paymentIds } } }),
    ).toBe(paymentIds.length);
    expect(
      await prisma.communityPassRefund.count({
        where: { communityId: ids.settledRefund, status: 'refunded' },
      }),
    ).toBe(1);
    expect(
      await prisma.creditPurchase.count({ where: { userWawuId: member } }),
    ).toBe(3);
    // Notices that only open a room are gone; the one that names a kept room stays; a "declined" notice stays.
    const left = await prisma.notification.findMany({
      where: { userWawuId: member },
      select: { kind: true },
    });
    expect(left.map((n) => n.kind).sort()).toEqual([
      'community_join_declined',
      'community_messages',
    ]);
  });

  it('a second run finds nothing to clear and lists only the kept rooms', async () => {
    const before = await snapshot();
    const { code, text } = await run({ apply: true, confirm: phraseFor(0) });
    expect(code).toBe(0);
    expect(text).toContain('Nothing to clear.');
    expect(text).toContain('Kept for real money: 5');
    expect(await snapshot()).toEqual(before);
  });

  it('the inbox, communities, Me earnings, notifications and search still answer for a member of a cleared room', async () => {
    const inboxPage = await inbox.list(member, undefined, 20);
    const inboxKeys = inboxPage.items.map((i) => JSON.stringify(i));
    for (const k of ['plain', 'sandboxPass', 'walletCredits', 'settledRefund'])
      expect(inboxKeys.some((s) => s.includes(ids[k]))).toBe(false);
    await expect(inbox.unread(member)).resolves.toBeDefined();
    const mine = await rooms.mine(member, 1, 50);
    expect(mine.items.map((r) => r.id)).not.toContain(ids.plain);
    const all = await communities.list(1, 500, member);
    const listed = all.items.map((c) => c.id);
    for (const k of ['plain', 'sandboxPass', 'walletCredits', 'settledRefund'])
      expect(listed).not.toContain(ids[k]);
    const feed = await notifications.list(member, 'all', undefined, 20);
    expect(feed.items.length).toBeGreaterThan(0);
    await expect(earnings.summary(host, undefined)).resolves.toBeDefined();
    await expect(
      earnings.sales(host, undefined, undefined, 20),
    ).resolves.toBeDefined();
    search.resetPopularCache();
    await expect(search.popular()).resolves.toBeDefined();
  });
});
