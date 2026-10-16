/* eslint-disable */
import { randomUUID } from 'node:crypto';
import { useHarness, sleep } from './round5-harness';

/**
 * SETTINGS-06 round 6 (lead, 16 Oct 2026): never hold a database transaction,
 * a pooled connection or a lock across a network call. Round 5's
 * reconcileWallet held all three while it called the provider.
 *
 *   R6-1  reconcileWallet reads the row, calls the provider with nothing held,
 *         re-reads the row and acts again if it changed (at most 3 rounds)
 *   R6-2  the hourly pass reconciles every freezing, scheduled and purging row
 *         whatever its age, and every cancelled row until one reconcile was
 *         confirmed for it (`walletSyncedAt`)
 *   R6-3  a repeat cancel on a cancelled row and a DELETE refused with 409 also
 *         end in reconcileWallet
 *   R6-4  reconcile freezes the person's CURRENT wallet of the running provider
 */
describe('SETTINGS-06 round 6: nothing is held across a provider call', () => {
  jest.setTimeout(600000);
  const h = useHarness();
  const { del, can, row, frozen } = h;
  const SLOW = 1500;
  const DAY = 24 * 3600 * 1000;

  const deferred = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };
  const until = async (f: () => boolean, ms = 10000) => {
    const t0 = Date.now();
    while (!f()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting');
      await sleep(10);
    }
  };
  /** every call on this wallet takes SLOW ms to answer */
  const slow = (walletId: string, n = 80) => {
    const steps = () => Array.from({ length: n }, () => ({ answer: SLOW }));
    h.plan(walletId, { freeze: steps(), unfreeze: steps(), balance: steps() });
  };
  /** what a latency probe sees: one short query by someone else */
  const probe = async () => {
    const s = performance.now();
    await h.prisma.fintavaWallet.count();
    return performance.now() - s;
  };
  const probing = () => {
    const ms: number[] = [];
    let on = true;
    const done = (async () => {
      while (on) {
        ms.push(await probe());
        await sleep(80);
      }
    })();
    return {
      stop: async () => {
        on = false;
        await done;
        return Math.max(...ms);
      },
    };
  };
  /** what the database holds open right now (this database only, not this probe) */
  const held = async () => {
    const r: any[] = await h.prisma.$queryRawUnsafe(
      `SELECT
         (SELECT count(*)::int FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction') AS "idleInTx",
         (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.granted AND a.datname = current_database()) AS "advisory"`,
    );
    return r[0] as { idleInTx: number; advisory: number };
  };
  const inForce = (id: string, walletId: string | null, status = 'scheduled') =>
    h.prisma.accountDeletion.create({
      data: {
        wawuUserId: id,
        status,
        scheduledAt: new Date(),
        purgeAfter: new Date(Date.now() + 30 * DAY),
        walletId,
        walletProvider: walletId ? 'fintava' : null,
        walletFrozenAt: status === 'scheduled' ? new Date() : null,
      },
    });
  /** the row was last changed (and, if cancelled, cancelled) this many hours ago */
  const ago = (id: string, hours: number) =>
    h.prisma.$executeRawUnsafe(
      `UPDATE "AccountDeletion" SET "updatedAt" = now() - interval '${hours} hours',
         "cancelledAt" = CASE WHEN "cancelledAt" IS NULL THEN NULL ELSE now() - interval '${hours} hours' END
       WHERE "wawuUserId" = '${id}'`,
    );
  /** the cancel is this many minutes old, whatever else the row says */
  const cancelledAgo = (id: string, minutes: number) =>
    h.prisma.$executeRawUnsafe(
      `UPDATE "AccountDeletion" SET "cancelledAt" = now() - interval '${minutes} minutes' WHERE "wawuUserId" = '${id}'`,
    );
  const providerCalls = (w: string) =>
    h.calls(w, 'freeze') + h.calls(w, 'unfreeze') + h.calls(w, 'balance');

  describe('R6-1 reconcileWallet holds nothing while the provider answers', () => {
    it('no transaction, no pooled connection and no advisory lock is open during the provider call', async () => {
      const { id, walletId } = await h.person(0);
      await inForce(id, walletId);
      const gate = deferred();
      h.plan(walletId, { freeze: [{ gate: gate.p }] });
      const running = h.money.reconcileWallet(id);
      await until(() => h.calls(walletId, 'freeze') === 1);
      const during = await held();
      gate.open();
      const out = await running;
      expect(during).toEqual({ idleInTx: 0, advisory: 0 });
      expect(out).toMatchObject({ want: 'frozen', done: true, failed: false });
      expect(frozen(walletId)).toBe(true);
    });

    it('a row that changes during the call is acted on again (scheduled, then cancelled: ends unfrozen)', async () => {
      const { id, walletId } = await h.person(0);
      await inForce(id, walletId);
      const gate = deferred();
      h.plan(walletId, { freeze: [{ gate: gate.p }] });
      const running = h.money.reconcileWallet(id);
      await until(() => h.calls(walletId, 'freeze') === 1);
      await h.prisma.accountDeletion.updateMany({
        where: { wawuUserId: id },
        data: { status: 'cancelled', cancelledAt: new Date(), walletFrozenAt: null },
      });
      gate.open();
      const out = await running;
      expect(out).toMatchObject({ want: 'unfrozen', done: true, failed: false });
      expect(frozen(walletId)).toBe(false);
      expect([h.calls(walletId, 'freeze'), h.calls(walletId, 'unfreeze')]).toEqual([1, 1]);
    });

    it('a row that keeps changing is acted on 3 times at most, then left for the hourly pass', async () => {
      const { id, walletId } = await h.person(0);
      await inForce(id, walletId);
      const money = h.money as any;
      const freeze = money.freeze.bind(money);
      const unfreeze = money.unfreeze.bind(money);
      const f = jest.spyOn(money, 'freeze').mockImplementation(async (w: string) => {
        const r = await freeze(w);
        await h.prisma.accountDeletion.update({ where: { wawuUserId: id }, data: { status: 'cancelled', cancelledAt: new Date() } });
        return r;
      });
      const u = jest.spyOn(money, 'unfreeze').mockImplementation(async (w: string) => {
        const r = await unfreeze(w);
        await h.prisma.accountDeletion.update({ where: { wawuUserId: id }, data: { status: 'scheduled', cancelledAt: null } });
        return r;
      });
      try {
        const out = await h.money.reconcileWallet(id);
        expect(f.mock.calls.length + u.mock.calls.length).toBe(3);
        expect(out).toMatchObject({ done: false, failed: true });
      } finally {
        f.mockRestore();
        u.mockRestore();
      }
    });

    it('20 parallel DELETE for one person, 1.5 s provider answers: the first schedules, no 500, others are not slowed', async () => {
      const a = await h.person(0);
      await h.piece(a.id);
      slow(a.walletId);
      const p = probing();
      const reqs: Promise<any>[] = [];
      for (let i = 0; i < 20; i++) {
        reqs.push(del(h.accounts, a.id));
        await sleep(100);
      }
      const res = await Promise.all(reqs);
      const worst = await p.stop();
      expect(res[0].ok).toBe(true);
      expect(res.filter((r) => !r.ok).map((r: any) => r.status).every((s: number) => s === 503)).toBe(true);
      expect((await row(a.id))!.status).toBe('scheduled');
      expect(frozen(a.walletId)).toBe(true);
      expect(worst).toBeLessThan(1000);
    });

    it('20 parallel cancel on a scheduled deletion: no 500, exactly one cancels, others are not slowed', async () => {
      const a = await h.person(0);
      await h.piece(a.id);
      expect((await del(h.accounts, a.id)).ok).toBe(true);
      slow(a.walletId);
      const p = probing();
      const reqs: Promise<any>[] = [];
      for (let i = 0; i < 20; i++) {
        reqs.push(can(h.accounts, a.id));
        await sleep(100);
      }
      const res = await Promise.all(reqs);
      const worst = await p.stop();
      expect(res.every((r) => r.ok)).toBe(true);
      expect(res.filter((r) => r.r.cancelled === true).length).toBe(1);
      expect((await row(a.id))!.status).toBe('cancelled');
      expect(frozen(a.walletId)).toBe(false);
      expect(worst).toBeLessThan(1000);
    });

    it('24 different people cancel at once, 1.5 s provider answers: no 500, a bystander is not slowed', async () => {
      const ppl: { id: string; walletId: string }[] = [];
      for (let i = 0; i < 24; i++) {
        const x = await h.person(0);
        expect((await del(h.accounts, x.id)).ok).toBe(true);
        slow(x.walletId, 20);
        ppl.push(x);
      }
      const p = probing();
      const res = await Promise.all(ppl.map((x) => can(h.accounts, x.id)));
      const worst = await p.stop();
      expect(res.every((r) => r.ok && (r as any).r.cancelled === true)).toBe(true);
      for (const x of ppl) expect(frozen(x.walletId)).toBe(false);
      expect(worst).toBeLessThan(1000);
    });
  });

  describe('R6-2 the hourly pass looks at every row that can owe the wallet a change', () => {
    it.each([25, 200])('a scheduled row with an UNFROZEN wallet heals at %s hours', async (hours) => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      h.wallets.get(walletId)!.frozen = false; // a late unfreeze landed
      h.healthy(walletId);
      await ago(id, hours);
      const r = await h.sweep.runOnce(new Date(), 50);
      expect(r.reconciled).toBeGreaterThanOrEqual(1);
      expect(frozen(walletId)).toBe(true);
      expect((await row(id))!.status).toBe('scheduled');
    });

    it.each([25, 200])('a cancelled row with a FROZEN wallet and no confirmed reconcile heals at %s hours', async (hours) => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect((await can(h.accounts, id)).ok).toBe(true);
      // a late freeze lands, and the reconcile that follows it is refused
      h.wallets.get(walletId)!.frozen = true;
      h.plan(walletId, { unfreeze: [{ fail: 'before' }] });
      const refused = await h.money.reconcileWallet(id);
      expect(refused).toMatchObject({ want: 'unfrozen', done: false, failed: true });
      expect((await row(id))!.walletSyncedAt).toBeNull();
      h.healthy(walletId);
      await ago(id, hours);
      await h.sweep.runOnce(new Date(), 50);
      expect(frozen(walletId)).toBe(false);
      expect((await row(id))!.status).toBe('cancelled');
      expect((await row(id))!.walletSyncedAt).not.toBeNull();
    });

    it.each([25, 200])('a cancelled row never marked, with a frozen wallet, heals at %s hours', async (hours) => {
      const { id, walletId } = await h.person(0);
      h.wallets.get(walletId)!.frozen = true;
      await h.prisma.accountDeletion.create({
        data: {
          wawuUserId: id, status: 'cancelled', cancelledAt: new Date(), scheduledAt: new Date(),
          purgeAfter: new Date(Date.now() + 30 * DAY), walletId, walletProvider: 'fintava',
        },
      });
      await ago(id, hours);
      await h.sweep.runOnce(new Date(), 50);
      expect(frozen(walletId)).toBe(false);
      expect((await row(id))!.walletSyncedAt).not.toBeNull();
    });

    it('a cancelled row whose reconcile was confirmed costs no provider call in the hourly pass', async () => {
      const { id, walletId } = await h.person(0);
      expect((await del(h.accounts, id)).ok).toBe(true);
      const c = await can(h.accounts, id);
      expect(c.ok && (c as any).r).toMatchObject({ cancelled: true, walletUnfrozen: true });
      // Too soon to be sure nothing of the deletion is still on its way: the
      // first hourly pass after the settle time confirms once more, then no more.
      expect((await row(id))!.walletSyncedAt).toBeNull();
      await cancelledAgo(id, 11);
      await h.sweep.runOnce(new Date(), 50);
      expect((await row(id))!.walletSyncedAt).not.toBeNull();
      const before = providerCalls(walletId);
      await h.sweep.runOnce(new Date(), 50);
      await h.sweep.runOnce(new Date(), 50);
      expect(providerCalls(walletId)).toBe(before);
    });

    it('a freeze that lands after a confirmed cancel is let go by the next hourly pass, whenever it runs', async () => {
      const { id, walletId } = await h.person(0);
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect((await can(h.accounts, id)).ok).toBe(true);
      h.wallets.get(walletId)!.frozen = true; // the freeze of a request that was still on its way
      h.healthy(walletId);
      await ago(id, 25); // the verifier's E2: the row looks old
      await cancelledAgo(id, 1); // but the cancel itself is young
      await h.sweep.runOnce(new Date(), 50);
      expect(frozen(walletId)).toBe(false);
    });

    it('a cancelled row with no wallet to free is settled at once (no hourly provider call either)', async () => {
      const id = randomUUID();
      h.people.push(id);
      await h.prisma.accountDeletion.create({
        data: { wawuUserId: id, status: 'cancelled', cancelledAt: new Date(), scheduledAt: new Date(), purgeAfter: new Date(Date.now() + 30 * DAY) },
      });
      await h.sweep.runOnce(new Date(), 50);
      expect((await row(id))!.walletSyncedAt).not.toBeNull();
    });

    it('a new request after a cancel starts again: the mark is cleared, and a second cancel sets it', async () => {
      const { id } = await h.person(0);
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect((await can(h.accounts, id)).ok).toBe(true);
      await cancelledAgo(id, 11);
      await h.sweep.runOnce(new Date(), 50);
      expect((await row(id))!.walletSyncedAt).not.toBeNull();
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect(await row(id)).toMatchObject({ status: 'scheduled', walletSyncedAt: null });
      expect((await can(h.accounts, id)).ok).toBe(true);
      expect((await row(id))!.walletSyncedAt).toBeNull();
      await cancelledAgo(id, 11);
      await h.sweep.runOnce(new Date(), 50);
      expect((await row(id))!.walletSyncedAt).not.toBeNull();
    });
  });

  describe('R6-3 a repeat cancel and a refused DELETE also end in reconcileWallet', () => {
    it('a repeat cancel on a cancelled row lets a frozen wallet go, and says nothing was cancelled', async () => {
      const { id, walletId } = await h.person(0);
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect((await can(h.accounts, id)).ok).toBe(true);
      h.wallets.get(walletId)!.frozen = true; // a late freeze landed
      const again = await can(h.accounts, id);
      expect(again.ok && (again as any).r).toMatchObject({ cancelled: false });
      expect(frozen(walletId)).toBe(false);
    });

    it('a DELETE refused with 409 (money to settle) lets a frozen wallet of a cancelled deletion go', async () => {
      const { id, walletId } = await h.person(0);
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect((await can(h.accounts, id)).ok).toBe(true);
      h.wallets.get(walletId)!.frozen = true;
      h.wallets.get(walletId)!.balanceKobo = 30_000;
      const refused = await del(h.accounts, id);
      expect(refused).toMatchObject({ ok: false, status: 409 });
      expect(frozen(walletId)).toBe(false);
      expect((await row(id))!.status).toBe('cancelled');
    });

    it('a DELETE refused with 409 for someone with no deletion at all asks the provider for nothing it should not', async () => {
      const { id, walletId } = await h.person(0);
      h.wallets.get(walletId)!.frozen = true; // frozen by someone else, not by a deletion
      h.wallets.get(walletId)!.balanceKobo = 30_000;
      const refused = await del(h.accounts, id);
      expect(refused).toMatchObject({ ok: false, status: 409 });
      expect(frozen(walletId)).toBe(true);
      expect(h.calls(walletId, 'unfreeze')).toBe(0);
    });
  });

  describe('R6-4 the wallet frozen is the person\'s current wallet', () => {
    const noWalletPerson = async () => {
      const id = randomUUID();
      h.people.push(id);
      return id;
    };
    const openWallet = async (id: string, provider: string | null = null) => {
      const walletId = `w-${id}`;
      h.wallets.set(walletId, { balanceKobo: 0, frozen: false });
      await h.prisma.fintavaWallet.create({
        data: {
          wawuUserId: id, customerId: `c-${id}`, walletId,
          accountNumber: `9${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`,
          ...(provider ? { provider } : {}),
        },
      });
      return walletId;
    };

    it('a wallet opened during the 30 days is frozen by reconcile and by the hourly pass, and freed by the cancel', async () => {
      const id = await noWalletPerson();
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect((await row(id))!.walletId).toBeNull();
      const walletId = await openWallet(id);
      const r = await h.money.reconcileWallet(id);
      expect(r).toMatchObject({ want: 'frozen', done: true, failed: false });
      expect(frozen(walletId)).toBe(true);
      h.wallets.get(walletId)!.frozen = false; // a late unfreeze, say
      await h.sweep.runOnce(new Date(), 50);
      expect(frozen(walletId)).toBe(true);
      const c = await can(h.accounts, id);
      expect(c.ok && (c as any).r).toMatchObject({ cancelled: true, walletUnfrozen: true });
      expect(frozen(walletId)).toBe(false);
    });

    it('a wallet of another provider is not asked (R-39)', async () => {
      const id = await noWalletPerson();
      expect((await del(h.accounts, id)).ok).toBe(true);
      const walletId = await openWallet(id, 'nuvion');
      const r = await h.money.reconcileWallet(id);
      expect(r.done).toBe(false);
      expect(providerCalls(walletId)).toBe(0);
      await h.sweep.runOnce(new Date(), 50);
      expect(providerCalls(walletId)).toBe(0);
    });
  });
});
