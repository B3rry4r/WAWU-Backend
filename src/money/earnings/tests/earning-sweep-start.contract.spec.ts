import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AdminTokenService } from '../../../admin/auth/admin-token.service';
import {
  bootPayApp,
  type PayHarness,
  type PayPerson,
} from '../../../../test/payments/wallet-pay-harness';
import { body, until } from '../../../../test/payments/poll-helpers';
import { FeeConfigError } from '../../fees/fee-config';
import { MoneyError } from '../../money-error';
import type { PaymentQuoteView, PaymentView } from '../../money-view.type';
import { PayableRegistry } from '../../payments/payable-registry';
import { PaymentSettings } from '../../payments/payment-config';
import { EarningSettlementService } from '../earning-settlement.service';
import { LedgerService } from '../../ledger/ledger.service';
import { FeeQuoteService } from '../../fees/fee-quote.service';

/**
 * WALLET-16, the lead's ruling of 17 Oct 2026 (the owner may override): the
 * earnings sweep pays only sales made on or after a start time; an older
 * unsettled sale is never paid by the sweep and is listed for an admin.
 * Nuvion stood in; no Nuvion, Fintava or wawuafrica.com host is called.
 */

jest.setTimeout(120_000);

const PRICE = 200_000;
const SHARE = 170_000;

describe('The earnings sweep starts at a time (WALLET-16)', () => {
  let h: PayHarness;
  const targets = new Map<string, { payee: string }>();

  beforeAll(async () => {
    h = await bootPayApp('w16s', {
      modules: [],
      env: {
        ADMIN_JWT_SECRET: 'w16s-admin-access-secret-0123456789abcdef0123',
        ADMIN_JWT_REFRESH_SECRET:
          'w16s-admin-refresh-secret-0123456789abcdef01',
      },
      extra: (app) => {
        const registry = app.get(PayableRegistry);
        registry.register({
          kind: 'content_unlock',
          resolve: async ({ targetId }) => {
            await Promise.resolve();
            const t = targets.get(targetId);
            if (!t) throw new MoneyError('target_not_found', 'That is gone.');
            return {
              title: 'A piece',
              priceKobo: PRICE,
              payee: {
                wawuUserId: t.payee,
                displayName: 'Adaeze Obi',
                handle: 'adaeze',
                avatarUrl: null,
                tick: 'creator' as const,
              },
            };
          },
          onCompleted: async () => {
            await Promise.resolve();
          },
        });
      },
    });
  });
  afterAll(async () => {
    await h.prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    // The row the migration wrote stays as it was found.
    await h.prisma.earningSweepStart.upsert({
      where: { id: 1 },
      create: { id: 1, startedAt: originalStart },
      update: { startedAt: originalStart },
    });
    await h.close();
  });
  let originalStart: Date;
  const adminIds: string[] = [];
  const adminTokens: Partial<Record<AdminRole, string>> = {};
  beforeAll(async () => {
    const issuer = h.app.get(AdminTokenService, { strict: false });
    for (const role of [
      AdminRole.superadmin,
      AdminRole.finance,
      AdminRole.support,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await h.prisma.adminUser.create({
        data: {
          id,
          email: `w16s-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `WALLET-16 ${role}`,
          role,
        },
      });
      adminTokens[role] = issuer.issuePair(admin).accessToken;
    }
    originalStart = (
      await h.prisma.earningSweepStart.findUniqueOrThrow({ where: { id: 1 } })
    ).startedAt;
  });

  const setStart = (at: Date) =>
    h.prisma.earningSweepStart.upsert({
      where: { id: 1 },
      create: { id: 1, startedAt: at },
      update: { startedAt: at },
    });

  /** A buyer pays for a piece of `payee`; the payment completes at once. */
  async function sale(payee: PayPerson): Promise<{
    paymentId: string;
    completedAt: Date;
    buyer: PayPerson;
  }> {
    const buyer = await h.person(5_000_000);
    const targetId = `piece-${randomUUID()}`;
    targets.set(targetId, { payee: payee.id });
    const qres = await h.get(
      buyer,
      `/money/payments/quote?kind=content_unlock&targetId=${targetId}`,
    );
    expect(qres.status).toBe(200);
    const q = body<PaymentQuoteView>(qres).data!;
    const res = await h.post(buyer, '/money/payments', {
      kind: q.kind,
      targetId: q.targetId,
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
    });
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    const row = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.id },
      select: { completedAt: true },
    });
    return { paymentId: view.id, completedAt: row.completedAt!, buyer };
  }

  const earningOf = (paymentId: string) =>
    h.prisma.earningSettlement.findUnique({ where: { paymentId } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('pays a sale made after the start, and never a sale made before it', async () => {
    const creator = await h.person(0);
    const before = await sale(creator);
    await sleep(15);
    const start = new Date();
    await setStart(start);
    await sleep(15);
    const after = await sale(creator);
    expect(before.completedAt.getTime()).toBeLessThan(start.getTime());
    expect(after.completedAt.getTime()).toBeGreaterThan(start.getTime());

    await h.pass();
    await until(async () => {
      await h.pass();
      return (await earningOf(after.paymentId))?.status === 'landed';
    }, 'the later sale to land');
    await h.pass();
    await h.pass();

    // The later sale landed once, the earlier one has no earning at all.
    expect(await earningOf(before.paymentId)).toBeNull();
    const landed = await earningOf(after.paymentId);
    expect(landed).toMatchObject({ status: 'landed' });
    expect(Number(landed!.amountKobo)).toBe(SHARE);
    // The creator's one move of the day carries the later sale's share alone.
    const toCreator = h.nuvion.transfers.filter(
      (t) => t.toAccountId === creator.account!.accountId,
    );
    expect(toCreator).toHaveLength(1);
    expect(toCreator[0].amountKobo).toBe(BigInt(SHARE));
    expect(landed!.moveId).not.toBeNull();
    expect(creator.account!.availableKobo).toBe(BigInt(SHARE));

    // The earlier sale is listed for an admin, with what it would have paid.
    const listed = await h.earnings.unsweptBeforeStart({ limit: 100 });
    expect(listed.source).toBe('first_run');
    expect(listed.startsAt).toBe(start.toISOString());
    const mine = listed.items.find((i) => i.paymentId === before.paymentId);
    expect(mine).toMatchObject({
      kind: 'content_unlock',
      payeeWawuUserId: creator.id,
      payeeShareKobo: SHARE,
    });
    expect(listed.items.some((i) => i.paymentId === after.paymentId)).toBe(
      false,
    );
    await h.expectLedgerEqualsStandIn([creator, before.buyer, after.buyer]);
    expect(h.fintavaHits).toEqual([]);
  });

  it('a sale at the very instant of the start is paid, the millisecond before it is not', async () => {
    const creator = await h.person(0);
    const edge = await sale(creator);
    const early = await sale(creator);
    // Move the start to the later sale's own instant, then put the other
    // sale one millisecond before it.
    const at = edge.completedAt;
    await h.prisma.walletPayment.update({
      where: { id: early.paymentId },
      data: { completedAt: new Date(at.getTime() - 1) },
    });
    await setStart(at);
    await h.pass();
    await h.pass();
    expect(await earningOf(early.paymentId)).toBeNull();
    expect(await earningOf(edge.paymentId)).not.toBeNull();
  });

  it('a start time in the setting wins over the stored one, and a bad one stops the app', async () => {
    const creator = await h.person(0);
    const old = await sale(creator);
    await setStart(new Date(Date.now() + 3_600_000));
    await h.pass();
    expect(await earningOf(old.paymentId)).toBeNull();

    // A second process with the owner's override: from long ago.
    const config = {
      get: (k: string) =>
        k === 'EARNINGS_SWEEP_START' ? '2020-01-01T00:00:00+01:00' : undefined,
    } as unknown as ConfigService;
    const overridden = new EarningSettlementService(
      h.prisma,
      h.nuvion,
      h.app.get(LedgerService),
      h.app.get(FeeQuoteService),
      new PaymentSettings(config),
    );
    expect(await overridden.sweepStart()).toEqual({
      at: new Date('2019-12-31T23:00:00.000Z'),
      source: 'config',
    });
    expect(
      (await overridden.sweep(new Date(Date.now() + 1000))).adopted,
    ).toBeGreaterThanOrEqual(1);
    expect(await earningOf(old.paymentId)).not.toBeNull();

    for (const bad of ['yesterday', '2026-10-25T09:00:00', '2026-10-25']) {
      expect(
        () =>
          new PaymentSettings({
            get: (k: string) =>
              k === 'EARNINGS_SWEEP_START' ? bad : undefined,
          } as unknown as ConfigService),
      ).toThrow(FeeConfigError);
    }
  });

  it('with no row the first run stores now, once, and every process reads that', async () => {
    await h.prisma.earningSweepStart.deleteMany({});
    const first = await h.earnings.sweepStart();
    await sleep(10);
    const second = await h.earnings.sweepStart();
    expect(first.source).toBe('first_run');
    expect(second.at.getTime()).toBe(first.at.getTime());
    expect(Math.abs(first.at.getTime() - Date.now())).toBeLessThan(10_000);
    expect(await h.prisma.earningSweepStart.count()).toBe(1);
  });

  it('lists the earlier sales a page at a time, oldest first, over HTTP as a cursor page, and the admin route is closed to the public', async () => {
    const creator = await h.person(0);
    const a = await sale(creator);
    await sleep(5);
    const b = await sale(creator);
    await sleep(5);
    const c = await sale(creator);
    const startsAt = new Date(c.completedAt.getTime() + 1000);
    await setStart(startsAt);
    const ids = [a, b, c].map((s) => s.paymentId);
    const url = '/api/hub/admin/money/earnings/before-start';
    const get = (token: string | undefined, query = '') => {
      const req = request(h.app.getHttpServer()).get(`${url}${query}`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
    type Page = {
      startsAt: string;
      source: string;
      count: number;
      items: Array<{ paymentId: string }>;
      nextCursor: string | null;
    };

    // The repo's cursor page (CONVENTIONS section 6): the response interceptor
    // keeps the whole shape, because it has no numeric `total`.
    const first = await get(adminTokens[AdminRole.superadmin], '?limit=1');
    expect(first.status).toBe(200);
    const firstPage = body<Page>(first).data!;
    expect(Array.isArray(firstPage.items)).toBe(true);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.startsAt).toBe(startsAt.toISOString());
    expect(firstPage.source).toBe('first_run');
    expect(typeof firstPage.count).toBe('number');
    expect(firstPage.nextCursor).not.toBeNull();
    expect(body<Page>(first)).not.toHaveProperty('pagination');

    // Walk every page by the cursor the server gave, as finance would.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const res = await get(
        adminTokens[AdminRole.finance],
        `?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      const page = body<Page>(res).data!;
      for (const item of page.items) seen.push(item.paymentId);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen.filter((id) => ids.includes(id))).toEqual(ids);
    expect(new Set(seen).size).toBe(seen.length);
    expect(
      body<Page>(await get(adminTokens[AdminRole.superadmin], '?limit=1')).data!
        .count,
    ).toBe(seen.length);

    // The service says the same.
    const direct = await h.earnings.unsweptBeforeStart({ limit: 1 });
    expect(direct.count).toBe(seen.length);
    expect(direct.nextCursor).toBe(firstPage.nextCursor);

    // Closed to the public and to support; a bad limit or cursor is a plain 400.
    expect((await get(undefined)).status).toBe(401);
    expect((await get('not-a-token')).status).toBe(401);
    expect((await get(adminTokens[AdminRole.support])).status).toBe(403);
    expect((await get(adminTokens[AdminRole.finance], '?limit=0')).status).toBe(
      400,
    );
    expect(
      (await get(adminTokens[AdminRole.finance], '?limit=101')).status,
    ).toBe(400);
    expect(
      (await get(adminTokens[AdminRole.finance], '?cursor=junk')).status,
    ).toBe(400);

    // R55-1: a well-formed cursor that matches no payment is a plain 400 too,
    // not a restart at the first page with a cursor again (a loop for a client).
    const unknownCursor = await get(
      adminTokens[AdminRole.finance],
      `?cursor=${randomUUID()}`,
    );
    expect(unknownCursor.status).toBe(400);
    expect(JSON.stringify(unknownCursor.body)).toContain(
      'cursor is not one this list gave.',
    );
    // R55-2: a limit that is not a number says so, in the same words as a limit
    // that is out of range (it used to read "must not be greater than 100").
    for (const bad of ['abc', '0', '101']) {
      const res = await get(adminTokens[AdminRole.finance], `?limit=${bad}`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        'limit must be a whole number from 1 to 100.',
      );
    }
  });
});
