/* eslint-disable */
import { FREEZE_200 } from '../../../test/fintava/fintava-double';
import { useHarness, sleep } from './round5-harness';

/**
 * SETTINGS-06 round 7 (verifier round 6, lead rulings 16 Oct 2026).
 *
 *   R6-1  a wallet could end frozen with NO deletion row and nothing looked at
 *         it again: the two paths that deleted the row (a failed DELETE's
 *         abandon, the pass's release of a stale `freezing` row) left no net,
 *         and a reconcile that acted under the row could not undo itself once
 *         the row was gone. Now neither path deletes the row (it becomes
 *         `cancelled` with `walletSyncedAt` null, which the cancel route and
 *         the hourly pass look at until a reconcile confirmed the wallet), and
 *         a reconcile carries the wallets it acted on into its next round.
 *   R6-2  the hourly pass: one at a time per process, a claim on each row so
 *         two servers do not ask the same wallet, a time budget, and a stop
 *         after a few provider failures in a row (rows it did not reach are
 *         asked first next time).
 *   R6-3  the oldest check goes first, so a cap or budget never starves rows.
 *   R6-4  a repeat cancel on a confirmed, settled cancelled row costs no
 *         provider call.
 */
describe('SETTINGS-06 round 7: a late freeze always finds a row to be undone by', () => {
  jest.setTimeout(600000);
  const h = useHarness();
  const { del, can, row, frozen } = h;

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

  describe('R6-1 M1: a reconcile that froze under a row, and the row is gone by the time the freeze lands', () => {
    it('the verifier\'s M1, as written: the reconcile that froze undoes its own freeze when it finds no row', async () => {
      const { id, walletId } = await h.person(0);
      const gate = deferred();
      await h.prisma.accountDeletion.create({
        data: {
          wawuUserId: id,
          status: 'freezing',
          scheduledAt: new Date(),
          purgeAfter: new Date(Date.now() + 30 * 86400000),
          walletId,
          walletProvider: 'fintava',
        },
      });
      h.plan(walletId, { freeze: [{ gate: gate.p }] });
      const x = h.money.reconcileWallet(id); // row freezing: it freezes
      await until(() => h.calls(walletId, 'freeze') >= 1);
      // the abandoning DELETE: unfreeze, drop its row, reconcile the wallet it named
      await h.money.unfreeze(walletId);
      await h.prisma.accountDeletion.deleteMany({ where: { wawuUserId: id } });
      await h.money.reconcileWallet(id, { walletId, provider: 'fintava' });
      expect(frozen(walletId)).toBe(false);
      gate.open(); // the freeze reaches the provider last
      await x;
      // X froze it; it must also have let it go, whatever the row says
      expect(frozen(walletId)).toBe(false);
    });

    it('by real requests: a pass freezes under a DELETE\'s row, the DELETE abandons, the freeze lands last: the wallet ends unfrozen and a row is kept', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      const g1 = deferred();
      const g2 = deferred();
      h.plan(walletId, {
        // freeze #0 is the DELETE's own; #1 is the pass's, held at the provider
        freeze: [{}, { gate: g2.p }],
        // balance #0 is the money check; #1 is the look after the freeze: held, then it fails
        balance: [{}, { gate: g1.p, fail: 'before' }],
      });
      const a = del(h.accounts, id);
      await until(() => h.calls(walletId, 'balance') >= 2);
      const pass = h.sweep.runOnce(new Date(), 50);
      await until(() => h.calls(walletId, 'freeze') >= 2);
      g1.open(); // the DELETE's balance read fails: it abandons
      const out = await a;
      expect(out.ok).toBe(false);
      expect(frozen(walletId)).toBe(false);
      g2.open(); // the pass's freeze lands after the abandon's unfreeze
      await pass;
      expect(frozen(walletId)).toBe(false);
      const r = await row(id);
      expect(r).not.toBeNull();
      expect(r!.status).toBe('cancelled');
      // and nothing is left to find on the next pass
      h.healthy(walletId);
      await h.sweep.runOnce(new Date(), 50);
      expect(frozen(walletId)).toBe(false);
    });
  });

  describe('R6-1 L1: one DELETE whose freeze answer outlives the client timeout and applies after the abandon', () => {
    it('the hourly pass lets the late freeze go, and so does the person\'s cancel', async () => {
      const { id, walletId } = await h.person(0);
      const piece = await h.piece(id);
      h.plan(walletId, { freeze: [{ jitter: 5600 }] }); // client gives up at 5 s, the freeze applies at 5.6 s
      const d = await del(h.accounts, id);
      expect(d.ok).toBe(false);
      const left = await row(id);
      expect(left).not.toBeNull();
      expect(left!.status).toBe('cancelled');
      expect(left!.walletSyncedAt).toBeNull();
      await sleep(1500); // the late freeze has applied
      expect(frozen(walletId)).toBe(true); // the premise: frozen, and no deletion in force
      expect(await h.pieceState(piece.id)).toBe('live');
      h.healthy(walletId);
      const pass = await h.sweep.runOnce(new Date(), 50);
      expect(pass.reconciled).toBeGreaterThanOrEqual(1);
      expect(frozen(walletId)).toBe(false);

      // the same, found by the person pressing cancel instead of the pass
      h.wallets.get(walletId)!.frozen = true;
      const c = await can(h.accounts, id);
      expect(c.ok).toBe(true);
      expect(frozen(walletId)).toBe(false);
    });
  });

  describe('R6-1: the pass\'s release of a stale freezing row', () => {
    it('keeps the row as cancelled and unconfirmed, and a freeze that lands afterwards is undone by the next pass', async () => {
      const p = await h.strand(11);
      const r = await h.sweep.runOnce(new Date(), 50);
      expect(r.unfrozen).toBe(1);
      const left = await row(p.id);
      expect(left).not.toBeNull();
      expect(left!.status).toBe('cancelled');
      expect(left!.walletSyncedAt).toBeNull();
      expect(frozen(p.walletId)).toBe(false);
      h.wallets.get(p.walletId)!.frozen = true; // a freeze of the dead request was still on its way
      await h.sweep.runOnce(new Date(), 50);
      expect(frozen(p.walletId)).toBe(false);
    });

    it('a stale freezing row whose unfreeze is not answered stays freezing (unchanged)', async () => {
      const p = await h.strand(11);
      h.plan(p.walletId, { unfreeze: [{ fail: 'before' }, { fail: 'before' }, { fail: 'before' }] });
      await h.sweep.runOnce(new Date(), 50);
      const left = await row(p.id);
      expect(left!.status).toBe('freezing');
      expect(frozen(p.walletId)).toBe(true);
    });
  });

  describe('R6-1: a new DELETE after an abandoned one', () => {
    it('takes the cancelled row over: scheduled, frozen, content hidden', async () => {
      const { id, walletId } = await h.person(0);
      const piece = await h.piece(id);
      h.plan(walletId, { balance: [{}, { fail: 'before' }] }); // look after the freeze fails
      const first = await del(h.accounts, id);
      expect(first.ok).toBe(false);
      expect((await row(id))!.status).toBe('cancelled');
      expect(frozen(walletId)).toBe(false);
      h.healthy(walletId);
      const second = await del(h.accounts, id);
      expect(second.ok).toBe(true);
      const r = await row(id);
      expect(r!.status).toBe('scheduled');
      expect(r!.cancelledAt).toBeNull();
      expect(frozen(walletId)).toBe(true);
      expect(await h.pieceState(piece.id)).toBe('removed');
    });
  });

  // ---------------------------------------------------------------- R6-2
  describe('R6-2 and R6-3: the hourly pass is bounded', () => {
    const seed = async (n: number, tag: string, status = 'scheduled') => {
      await h.prisma.$executeRawUnsafe(
        `INSERT INTO "AccountDeletion" ("wawuUserId","status","scheduledAt","purgeAfter","walletId","walletProvider","updatedAt")
         SELECT 'bulk7-${tag}-' || lpad(i::text, 6, '0'), '${status}', now(), now() + interval '30 days', 'w7-${tag}-' || lpad(i::text, 6, '0'), 'fintava', now()
         FROM generate_series(1, ${n}) i`,
      );
    };
    const slowProvider = (tag: string, ms: number) =>
      h.double.on('PATCH', new RegExp(`^/customer/wallet/w7-${tag}-[0-9]+/(freeze|unfreeze)$`), async () => ({
        status: 200,
        delayMs: ms || undefined,
        body: FREEZE_200,
      }));
    const asked = (tag: string) =>
      h.double.seen.filter((x) => x.path.includes(`/w7-${tag}-`)).map((x) => x.path.split('/')[3]);
    const clear = () => h.prisma.$executeRawUnsafe(`DELETE FROM "AccountDeletion" WHERE "wawuUserId" LIKE 'bulk7-%'`);
    beforeEach(async () => { await clear(); h.double.seen.length = 0; });
    afterEach(clear);

    it('single flight: a second cron entry while one is running does nothing (each wallet asked once)', async () => {
      await seed(24, 'a');
      slowProvider('a', 100);
      await Promise.all([h.sweep.sweep(), (async () => { await sleep(300); await h.sweep.sweep(); })()]);
      const calls = asked('a');
      expect(calls.length).toBe(24);
      expect(new Set(calls).size).toBe(24);
    });

    it('a claim: two passes at once (two servers) split the rows and ask each wallet once', async () => {
      await seed(40, 'b');
      slowProvider('b', 100);
      const [a, b] = await Promise.all([
        h.sweep.runOnce(new Date(), 50, { batch: 10 }),
        (async () => { await sleep(300); return h.sweep.runOnce(new Date(), 50, { batch: 10 }); })(),
      ]);
      const calls = asked('b');
      expect(calls.length).toBe(40);
      expect(new Set(calls).size).toBe(40);
      expect(a.reconciled).toBeGreaterThan(0);
      expect(b.reconciled).toBeGreaterThan(0);
      expect(a.reconciled + b.reconciled).toBe(40);
    });

    it('the claim does not move updatedAt (a freezing row\'s age is measured from it) and a claim that ran out is taken again', async () => {
      await seed(3, 'c', 'freezing');
      slowProvider('c', 0);
      const ids = (await h.prisma.accountDeletion.findMany({ where: { wawuUserId: { startsWith: 'bulk7-c-' } }, orderBy: { wawuUserId: 'asc' } })).map((x) => x.wawuUserId);
      // one row is held by a pass that is still running; one claim ran out long ago
      await h.prisma.accountDeletion.update({ where: { wawuUserId: ids[0] }, data: { reconcileClaimedUntil: new Date(Date.now() + 600000) } });
      await h.prisma.accountDeletion.update({ where: { wawuUserId: ids[1] }, data: { reconcileClaimedUntil: new Date(Date.now() - 600000) } });
      const before = await h.prisma.accountDeletion.findMany({ where: { wawuUserId: { startsWith: 'bulk7-c-' } }, orderBy: { wawuUserId: 'asc' } });
      const r = await h.sweep.runOnce(new Date(), 50);
      expect(r.reconciled).toBe(2);
      expect(asked('c').length).toBe(2);
      expect(asked('c')).not.toContain(before[0].walletId);
      const after = await h.prisma.accountDeletion.findMany({ where: { wawuUserId: { startsWith: 'bulk7-c-' } }, orderBy: { wawuUserId: 'asc' } });
      expect(after.map((x) => x.updatedAt.getTime())).toEqual(before.map((x) => x.updatedAt.getTime()));
      // held row still held; the others carry the time of this pass (checked)
      expect(after[0].reconcileClaimedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(after[1].reconcileClaimedUntil!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('a time budget: the pass stops, and the next pass starts with the rows the first never reached', async () => {
      await seed(30, 'd');
      // The budget is measured on a clock this test controls: every call to the
      // provider costs 100 ms on it, however fast or slow the machine is (a
      // wall-clock version failed on a loaded CI runner that answered 3 rows
      // in 800 ms). The pass has used 800 ms once it has asked 8 wallets.
      const COST_MS = 100;
      slowProvider('d', 0);
      const clock = () => 1_000_000 + asked('d').length * COST_MS;
      const first = await h.sweep.runOnce(new Date(), 50, { budgetMs: 800, batch: 10, clock });
      expect(first.stopped).toBe('budget');
      expect(first.reconciled).toBeGreaterThan(3);
      expect(first.reconciled).toBeLessThan(15);
      expect(first.reconciled).toBe(8); // 800 ms of budget at 100 ms a call
      const firstAsked = new Set(asked('d'));
      expect(firstAsked.size).toBe(8);
      h.double.seen.length = 0;
      const second = await h.sweep.runOnce(new Date(), 50);
      expect(second.stopped).toBeNull();
      const secondAsked = asked('d');
      // the oldest check goes first (R6-3): the first calls are wallets the first pass never asked
      const unreached = 30 - firstAsked.size;
      expect(secondAsked.slice(0, unreached).every((w) => !firstAsked.has(w))).toBe(true);
      expect(new Set([...firstAsked, ...secondAsked]).size).toBe(30);
    });

    it('a time budget on the real clock: a slow provider stops the pass, whatever the machine does', async () => {
      await seed(30, 'g');
      slowProvider('g', 100);
      // Each call takes at least 100 ms of wall time, so a 250 ms budget lets
      // at most 3 rows start (at 0, 100 and 200 ms); a stall on a loaded
      // machine can only make the pass stop sooner, never later. The lower
      // bound is not asserted here: it is the test above, on a clock that
      // cannot stall.
      const first = await h.sweep.runOnce(new Date(), 50, { budgetMs: 250, batch: 10 });
      expect(first.stopped).toBe('budget');
      expect(first.reconciled).toBeLessThanOrEqual(3);
      const firstAsked = new Set(asked('g'));
      expect(firstAsked.size).toBeLessThan(30);
      h.double.seen.length = 0;
      const second = await h.sweep.runOnce(new Date(), 50);
      expect(second.stopped).toBeNull();
      const secondAsked = asked('g');
      const unreached = 30 - firstAsked.size;
      expect(secondAsked.slice(0, unreached).every((w) => !firstAsked.has(w))).toBe(true);
      expect(new Set([...firstAsked, ...secondAsked]).size).toBe(30);
    });

    it('an outage: the pass stops after three failures in a row, and the next pass starts with the rows it did not reach', async () => {
      await seed(12, 'e');
      slowProvider('e', 6500); // past the 5 s client timeout: every call fails
      const t0 = Date.now();
      const first = await h.sweep.runOnce(new Date(), 50);
      const took = Date.now() - t0;
      expect(first.stopped).toBe('outage');
      expect(first.reconciled).toBe(0);
      expect(asked('e').length).toBe(3);
      expect(took).toBeLessThan(25000); // three timeouts, not twelve
      const firstAsked = new Set(asked('e'));
      slowProvider('e', 0); // the provider is back
      h.double.seen.length = 0;
      const second = await h.sweep.runOnce(new Date(), 50);
      expect(second.stopped).toBeNull();
      expect(second.reconciled).toBe(12);
      expect(asked('e').slice(0, 9).every((w) => !firstAsked.has(w))).toBe(true);
    });
  });

  // ---------------------------------------------------------------- R6-4
  describe('R6-4: a repeat cancel on a confirmed, settled cancelled row', () => {
    it('makes no provider call; a young one still does', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect((await can(h.accounts, id)).ok).toBe(true); // cancelled, young
      h.healthy(walletId);
      h.wallets.get(walletId)!.frozen = true;
      await can(h.accounts, id); // young: reconciles and lets it go
      expect(frozen(walletId)).toBe(false);
      // settled: confirmed more than 10 minutes after the cancel
      await h.prisma.$executeRawUnsafe(
        `UPDATE "AccountDeletion" SET "cancelledAt" = now() - interval '11 minutes', "walletSyncedAt" = now() WHERE "wawuUserId" = '${id}'`,
      );
      h.healthy(walletId);
      const callsBefore = h.calls(walletId, 'unfreeze') + h.calls(walletId, 'freeze');
      const c = await can(h.accounts, id);
      expect(c.ok).toBe(true);
      expect(h.calls(walletId, 'unfreeze') + h.calls(walletId, 'freeze')).toBe(callsBefore);
    });
  });
});
