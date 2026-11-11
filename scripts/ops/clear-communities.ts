/**
 * OPS-CLEAR-ROOMS (R-136): clear every community on the Hub, on the owner's word. WRITTEN, NOT RUN by the task that
 * wrote it: the owner runs it on the server.
 *
 * The Hub has no route that deletes a community. This command lists every one, keeps any that holds real money, and
 * clears the rest.
 *
 *   dry run (default)  writes nothing; prints every community, which would be cleared, which are kept for real money
 *                      (with the record), totals, and the confirmation phrase (it carries the count).
 *   apply              needs --apply AND --confirm "<the exact phrase the dry run printed>". One transaction per room.
 *
 * Real money (scripts/ops/room-money-rows.ts, findRoomMoneyRows; the row shape is real-money-rows.ts's): a pass, credits spent from a lot or a host earning
 * that touch a real-money provider, a payment or refund in flight, a store subscription not ended. The wallet
 * provider's sandbox is proven the way delete-test-account.ts proves it (proveTestProvider); with the provider not
 * proven to be on test keys every pass counts as real money. A room with any such record is KEPT and listed. There is
 * no flag to override it, and no way to clear it with this command.
 *
 * What a clear does, per room, in one transaction (the room row is locked first, so a pass bought mid-run waits, and
 * the money check is run again inside the transaction):
 *   - the host's earning settlements for credits spent in the room (landed, sandbox: test money) are deleted, because
 *     their link to the spend is RESTRICT; the money stays where it landed, the wallet provider's balance is the truth
 *   - notifications that only point at the room (new messages, join approved, pass ending) are deleted, so no tap opens
 *     a room that is gone; their target and notice rows go with them
 *   - the room's notice retry row and moderation log are deleted (no foreign key reaches them)
 *   - the Community row is deleted; the database cascades to memberships, messages (and their idempotency keys), read
 *     markers, mutes, link, pass price, passes and credit spends (and through them the host's earning ledger rows)
 * Left as they are, on purpose (every read of them already works without the room):
 *   - settled CommunityPassRefund rows, WalletPayment rows and their earning settlements (money history; the
 *     payee's share still pays out), StorePurchase and ended StoreSubscription rows
 *   - other notifications that name the room (join declined, pass refunded): GET /me/notifications shows them
 *     without a target when the room is gone
 *   - search history (free text), UgcReport rows about its messages, PriceListMove rows, uploaded files
 *     (cover images and message media stay in storage; the dry run counts the covers), the room's StorageObject rows
 *   - the popular-searches answer is held in each running Hub process for POPULAR_CACHE_SECONDS (60) and refreshes on
 *     its own; the Hub keeps no other cache of community lists (no Redis), so there is nothing to flush
 *
 * A second run finds nothing to clear. Prints no email, phone or message text.
 *
 *   cd /srv/wawu/hub-api   (the deploy builds dist/scripts/ops/clear-communities.js with the rest of the Hub)
 *   set -a; . /etc/wawu/hub-api.env; set +a
 *   node dist/scripts/ops/clear-communities.js
 *   node dist/scripts/ops/clear-communities.js --apply --confirm "<phrase>"
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { POPULAR_CACHE_SECONDS } from '../../src/search-response/search-history.config';
import type { WalletProviderName } from '../../src/wallet-provider/wallet-provider.interface';
import { proveTestProvider } from './delete-test-account';
import type { RealMoneyRow } from './real-money-rows';
import { findRoomMoneyRows } from './room-money-rows';

/** Notifications that exist only to open a room. Deleted with it. */
export const ROOM_ONLY_NOTICE_KINDS = [
  'community_messages',
  'community_join_approved',
  'community_pass_ending',
];

export interface Deps {
  prisma: PrismaService;
  getEnv: (key: string) => string | undefined;
  out: (line: string) => void;
  /** A test hook, never set by the command line: look only at these rooms (a shared test database holds other specs' rooms). */
  onlyIds?: string[];
}

export interface Options {
  apply: boolean;
  confirm?: string;
}

export interface RoomReport {
  id: string;
  name: string;
  kind: string;
  host: string;
  members: number;
  messages: number;
  passes: number;
  activePasses: number;
  passKobo: bigint;
  spends: number;
  spendsWithoutEarning: number;
  hostEarningKobo: bigint;
  refunds: Record<string, number>;
  hasCover: boolean;
  slug: string | null;
  money: RealMoneyRow[];
}

async function report(
  prisma: PrismaService,
  running: WalletProviderName,
  sandboxProven: boolean,
  onlyIds?: string[],
): Promise<RoomReport[]> {
  const rooms = await prisma.community.findMany({
    where: onlyIds ? { id: { in: onlyIds } } : undefined,
    select: {
      id: true,
      name: true,
      kind: true,
      hostWawuId: true,
      imageUrl: true,
      link: { select: { slug: true } },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const handles = new Map(
    (
      await prisma.userProfile.findMany({
        where: {
          wawuUserId: { in: [...new Set(rooms.map((r) => r.hostWawuId))] },
        },
        select: { wawuUserId: true, handle: true },
      })
    ).map((p) => [p.wawuUserId, p.handle]),
  );
  const now = new Date();
  const out: RoomReport[] = [];
  for (const r of rooms) {
    const where = { communityId: r.id };
    const [
      members,
      messages,
      passes,
      active,
      passSum,
      spends,
      earned,
      refunds,
      spendRows,
      money,
    ] = await Promise.all([
      prisma.communityMembership.count({ where }),
      prisma.communityMessage.count({ where }),
      prisma.communityPass.count({ where }),
      prisma.communityPass.count({ where: { ...where, endsAt: { gt: now } } }),
      prisma.communityPass.aggregate({ where, _sum: { priceKobo: true } }),
      prisma.creditSpend.count({ where }),
      prisma.creditSpendEarning.aggregate({
        where,
        _sum: { hostShareKobo: true },
      }),
      prisma.communityPassRefund.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      prisma.creditSpend.count({ where: { ...where, earning: { is: null } } }),
      findRoomMoneyRows(prisma, r.id, running, sandboxProven),
    ]);
    out.push({
      id: r.id,
      name: r.name,
      kind: r.kind,
      host: handles.get(r.hostWawuId)
        ? `@${handles.get(r.hostWawuId)}`
        : r.hostWawuId,
      members,
      messages,
      passes,
      activePasses: active,
      passKobo: passSum._sum.priceKobo ?? 0n,
      spends,
      spendsWithoutEarning: spendRows,
      hostEarningKobo: BigInt(earned._sum.hostShareKobo ?? 0),
      refunds: Object.fromEntries(
        refunds.map((g) => [g.status, g._count._all]),
      ),
      hasCover: !!r.imageUrl,
      slug: r.link?.slug ?? null,
      money,
    });
  }
  return out;
}

export const phraseFor = (n: number) => `CLEAR ${n} COMMUNITIES`;

/** One room, one transaction. Returns what was removed, or the money that stopped it. */
async function clearRoom(
  prisma: PrismaService,
  id: string,
  running: WalletProviderName,
  sandboxProven: boolean,
): Promise<{ kept: RealMoneyRow[] } | { removed: Record<string, number> }> {
  return prisma.$transaction(
    async (tx) => {
      // Lock the room: a pass bought now waits for this transaction and then finds no room.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Community" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) return { removed: {} };
      const money = await findRoomMoneyRows(tx, id, running, sandboxProven);
      if (money.length > 0) return { kept: money };
      const removed: Record<string, number> = {};
      const count = (k: string, n: number) => {
        if (n > 0) removed[k] = (removed[k] ?? 0) + n;
      };
      const spendEarnings = await tx.creditSpendEarning.findMany({
        where: { communityId: id },
        select: { id: true },
      });
      count(
        'EarningSettlement',
        (
          await tx.earningSettlement.deleteMany({
            where: {
              creditSpendEarningId: { in: spendEarnings.map((e) => e.id) },
            },
          })
        ).count,
      );
      count(
        'Notification',
        (
          await tx.notification.deleteMany({
            where: {
              kind: { in: ROOM_ONLY_NOTICE_KINDS },
              OR: [
                { target: { is: { targetKind: 'community', targetId: id } } },
                { communityMessageNotice: { is: { communityId: id } } },
              ],
            },
          })
        ).count,
      );
      count(
        'CommunityNoticeRetry',
        (
          await tx.communityNoticeRetry.deleteMany({
            where: { communityId: id },
          })
        ).count,
      );
      count(
        'CommunityModerationLog',
        (
          await tx.communityModerationLog.deleteMany({
            where: { communityId: id },
          })
        ).count,
      );
      const counts = {
        CommunityMembership: await tx.communityMembership.count({
          where: { communityId: id },
        }),
        CommunityMessage: await tx.communityMessage.count({
          where: { communityId: id },
        }),
        CommunityPass: await tx.communityPass.count({
          where: { communityId: id },
        }),
        CreditSpend: await tx.creditSpend.count({ where: { communityId: id } }),
      };
      await tx.community.delete({ where: { id } });
      for (const [k, n] of Object.entries(counts)) count(k, n);
      count('Community', 1);
      return { removed };
    },
    { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 },
  );
}

const kobo = (n: bigint) => `${n} kobo`;
const refundText = (r: Record<string, number>) =>
  Object.keys(r).length === 0
    ? 'none'
    : Object.entries(r)
        .map(([s, n]) => `${s} ${n}`)
        .join(', ');

/** Runs the command. Returns the exit code: 0 done or nothing to do, 1 refused, 2 failed. */
export async function clearCommunities(
  deps: Deps,
  opts: Options,
): Promise<number> {
  const { out, prisma } = deps;
  const refuse = (why: string) => {
    out(`REFUSED: ${why}`);
    out('Nothing was changed.');
    return 1;
  };
  const proof = proveTestProvider(deps.getEnv);
  const running = proof.provider === 'nuvion' ? 'nuvion' : 'fintava';
  const rooms = await report(prisma, running, proof.ok, deps.onlyIds);
  const toClear = rooms.filter((r) => r.money.length === 0);
  const kept = rooms.filter((r) => r.money.length > 0);
  const phrase = phraseFor(toClear.length);

  out(opts.apply ? 'APPLY' : 'DRY RUN (nothing is written)');
  out(
    proof.ok
      ? `Provider: ${proof.provider}, ${proof.environment}. ${proof.proof}`
      : `Provider: NOT proven to be on test credentials (${proof.why}). Every pass counts as real money.`,
  );
  out(`Communities on the Hub: ${rooms.length}`);
  rooms.forEach((r, i) => {
    out(`${i + 1}. ${r.name} [${r.kind}] ${r.id}`);
    out(`   host ${r.host}; members ${r.members}; messages ${r.messages}`);
    out(
      `   passes ${r.passes} (active ${r.activePasses}, paid ${kobo(r.passKobo)}); credit spends ${r.spends} (host earning ${kobo(r.hostEarningKobo)}${r.spendsWithoutEarning > 0 ? `; ${r.spendsWithoutEarning} with no earning record` : ''})`,
    );
    out(
      `   refunds ${refundText(r.refunds)}; cover ${r.hasCover ? 'yes (stays in storage)' : 'no'}; link ${r.slug ?? 'none'}`,
    );
    out(r.money.length === 0 ? '   -> would clear' : '   -> KEPT, real money:');
    for (const m of r.money)
      out(
        `      ${m.table} ${m.id} status ${m.status} amount ${m.amountKobo} kobo [${m.klass}: ${m.why}]`,
      );
  });
  out(`Would clear: ${toClear.length}`);
  out(
    `Kept for real money: ${kept.length}${kept.length > 0 ? ' (listed above; this command never clears them)' : ''}`,
  );
  out(
    `Totals to clear: ${toClear.reduce((a, r) => a + r.members, 0)} memberships, ${toClear.reduce((a, r) => a + r.messages, 0)} messages, ${toClear.reduce((a, r) => a + r.passes, 0)} passes, ${toClear.reduce((a, r) => a + r.spends, 0)} credit spends, ${toClear.filter((r) => r.hasCover).length} cover images left in storage`,
  );
  if (toClear.length === 0) {
    out('Nothing to clear.');
    return 0;
  }
  out(`Confirmation phrase: ${phrase}`);
  if (!opts.apply) {
    out('Dry run only. To clear: add --apply --confirm "<the phrase above>".');
    return 0;
  }
  if (opts.confirm === undefined)
    return refuse('--apply needs --confirm with the exact phrase above.');
  if (opts.confirm !== phrase)
    return refuse('the confirmation phrase is not the one printed above.');

  let cleared = 0;
  let stopped = 0;
  const failures: string[] = [];
  for (const r of toClear) {
    try {
      const res = await clearRoom(prisma, r.id, running, proof.ok);
      if ('kept' in res) {
        stopped++;
        out(
          `Kept ${r.name} ${r.id}: real money appeared (${res.kept.map((m) => m.table).join(', ')}).`,
        );
      } else {
        cleared++;
        out(
          `Cleared ${r.name} ${r.id}: ${
            Object.entries(res.removed)
              .map(([k, n]) => `${k} ${n}`)
              .join(', ') || 'already gone'
          }`,
        );
      }
    } catch (e) {
      failures.push(r.id);
      out(
        `FAILED ${r.name} ${r.id}: ${(e as Error).message.slice(0, 200)} (that room is unchanged)`,
      );
    }
  }
  out(
    `Audit: cleared ${cleared} communities at ${new Date().toISOString()}; kept ${kept.length + stopped}; failed ${failures.length}`,
  );
  out(
    `Cover images stay in storage. The popular-searches answer refreshes within ${POPULAR_CACHE_SECONDS} seconds.`,
  );
  if (failures.length > 0) {
    out('Not finished. It is safe to run the same command again.');
    return 2;
  }
  out(
    'Done. Running the dry run again lists only the rooms kept for real money.',
  );
  return 0;
}

export function parseArgs(argv: string[]): Options | string {
  const known = ['--apply', '--confirm'];
  const unknown = argv.filter(
    (a, i) =>
      a.startsWith('--') && !known.includes(a) && argv[i - 1] !== '--confirm',
  );
  if (unknown.length > 0) {
    return `unknown option ${unknown[0]}. There is no flag that clears a room holding real money.`;
  }
  const i = argv.indexOf('--confirm');
  if (i >= 0 && (argv[i + 1] === undefined || argv[i + 1].startsWith('--')))
    return 'usage: [--apply --confirm "<phrase>"]';
  return {
    apply: argv.includes('--apply'),
    confirm: i >= 0 ? argv[i + 1] : undefined,
  };
}

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule] })
class OpsModule {}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === 'string') {
    console.error(opts);
    return 1;
  }
  const app = await NestFactory.createApplicationContext(OpsModule, {
    logger: ['error', 'warn'],
  });
  try {
    return await clearCommunities(
      {
        prisma: app.get(PrismaService, { strict: false }),
        getEnv: (k) => process.env[k],
        out: (l) => console.log(l),
      },
      opts,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`FAILED: ${(e as Error).message}`);
      process.exit(2);
    },
  );
}
