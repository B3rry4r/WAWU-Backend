/* eslint-disable */
import { useHarness, mulberry32, sleep } from './round5-harness';

/**
 * SETTINGS-06 round 5. The rule (R-1 wallet safety; lead, 16 Oct 2026): a
 * deletion in force always has a frozen wallet, and a cancelled or absent
 * deletion never does, enforced by one idempotent function
 * (AccountDeletionMoneyService.reconcileWallet), not by a compensation per
 * path. DET1 to DET10 are the verifier's deterministic attacks of round 4
 * (zz-v4-det), their assertions kept; DET3, DET3b, DET6 and DET9 were "report
 * only" or logged, and now assert the rule. R4-4 and the reconcile table are
 * new.
 */
describe('SETTINGS-06 round 5: one reconcile keeps the wallet and the deletion row in step', () => {
  jest.setTimeout(600000);
  const h = useHarness();
  const { del, can, row, frozen, pieceState } = h;
  const finals = () => h.gateway.finalizeAccountDeletion.mock.calls.length;

  describe('verifier round 4, deterministic attacks', () => {
    it('DET1 (R4-1) a cancel whose unfreeze is applied but whose ANSWER is lost: the deletion is still in force, so the wallet is frozen again', async () => {
      const { id, walletId } = await h.person(0);
      const pc = await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect(frozen(walletId)).toBe(true);
      h.plan(walletId, { unfreeze: [{ fail: 'lost' }] });
      const c = await can(h.accounts, id);
      const out = { cancel: c.ok ? 'ok' : (c as any).status, row: (await row(id))!.status, frozen: frozen(walletId), piece: await pieceState(pc.id) };
      expect(out).toEqual({ cancel: 503, row: 'scheduled', frozen: true, piece: 'removed' });
    });

    it('DET2 a repeat cancel after DET1 heals; and a repeat DELETE heals a scheduled-unfrozen row', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      h.wallets.get(walletId)!.frozen = false; // the late unfreeze
      h.healthy(walletId);
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect(frozen(walletId)).toBe(true);
    });

    it('DET3 (R4-2a) the named double fault reaches the date: the purge freezes the wallet and the purged account ends frozen', async () => {
      const { id, walletId } = await h.person(0);
      const pc = await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      h.wallets.get(walletId)!.frozen = false; // double fault stands
      h.healthy(walletId);
      await h.dueNow(id);
      const r = await h.sweep.runOnce(new Date(), 50);
      expect(r.purged).toBe(1);
      expect((await row(id))?.status).toBe('purged');
      expect(frozen(walletId)).toBe(true);
      expect(h.calls(walletId, 'freeze')).toBeGreaterThanOrEqual(1);
      expect(await pieceState(pc.id)).not.toBe('live');
      expect(await h.prisma.fintavaWallet.count({ where: { wawuUserId: id } })).toBe(0);
    });

    it('DET3b money has arrived on the unfrozen wallet: the account is kept, and the wallet is frozen', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      h.wallets.get(walletId)!.frozen = false;
      h.wallets.get(walletId)!.balanceKobo = 30_000;
      h.healthy(walletId);
      await h.dueNow(id);
      const r = await h.sweep.runOnce(new Date(), 50);
      const rw = await row(id);
      expect(r).toMatchObject({ purged: 0, blocked: 1 });
      expect(rw?.status).toBe('scheduled');
      expect(rw?.purgeBlockedBy).toBe('wallet_balance');
      expect(frozen(walletId)).toBe(true);
    });

    it('DET4 503 window: stranded young row => 503 in flight (message), 9 min still 503, 11 min takes over', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      h.plan(walletId, { freeze: [{ fail: 'lost' }], unfreeze: [{ fail: 'before' }] });
      const first = await del(h.accounts, id);
      expect(first).toMatchObject({ ok: false, status: 503 });
      expect((await row(id))!.status).toBe('freezing');
      expect(frozen(walletId)).toBe(true);
      h.healthy(walletId);
      const second = await del(h.accounts, id);
      expect(second).toMatchObject({ ok: false, status: 503 });
      expect((second as any).msg).toBe('Your request is already being processed. Try again in a moment.');
      await h.backdate(id, 9);
      expect(await del(h.accounts, id)).toMatchObject({ ok: false, status: 503 });
      expect(frozen(walletId)).toBe(true);
      await h.backdate(id, 11);
      const third = await del(h.accounts, id);
      expect(third.ok).toBe(true);
      expect(frozen(walletId)).toBe(true);
      expect((await row(id))!.status).toBe('scheduled');
    });

    it('DET4b a stranded young row: cancel heals at once, then DELETE works at once', async () => {
      const { id, walletId } = await h.person(0);
      const pc = await h.piece(id);
      h.plan(walletId, { freeze: [{ fail: 'lost' }], unfreeze: [{ fail: 'before' }] });
      expect((await del(h.accounts, id)).ok).toBe(false);
      h.healthy(walletId);
      const c = await can(h.accounts, id);
      expect(c.ok && (c as any).r.cancelled).toBe(true);
      expect(frozen(walletId)).toBe(false);
      expect(await pieceState(pc.id)).toBe('live');
      expect((await del(h.accounts, id)).ok).toBe(true);
      expect(frozen(walletId)).toBe(true);
    });

    it('DET5 sweep touched a stale row whose unfreeze FAILS: a DELETE at once is 503, 11 minutes later it works', async () => {
      const stale = await h.strand(11, 'fintava');
      h.plan(stale.walletId, { unfreeze: [{ fail: 'before' }] });
      const r = await h.sweep.runOnce(new Date(), 50);
      expect(r.unfrozen).toBe(0);
      h.healthy(stale.walletId);
      expect(await del(h.accounts, stale.id)).toMatchObject({ ok: false, status: 503 });
      await h.backdate(stale.id, 11);
      expect((await del(h.accounts, stale.id)).ok).toBe(true);
      expect(frozen(stale.walletId)).toBe(true);
    });

    it('DET6 (R4-3) a stale row owned by ANOTHER provider (nuvion) on a Fintava server: its wallet id is never sent to Fintava', async () => {
      const p = await h.person(0);
      const foreign = 'nuv-foreign-' + p.id;
      await h.prisma.accountDeletion.create({ data: { wawuUserId: p.id, status: 'freezing', scheduledAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86400000), walletId: foreign, walletProvider: 'nuvion' } });
      await h.backdate(p.id, 11);
      await del(h.accounts, p.id);
      expect(h.calls(foreign, 'unfreeze')).toBe(0);
      expect(h.calls(foreign, 'freeze')).toBe(0);
      // the sweep leaves it alone too
      await h.prisma.accountDeletion.deleteMany({ where: { wawuUserId: p.id } });
      await h.prisma.accountDeletion.create({ data: { wawuUserId: p.id, status: 'freezing', scheduledAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86400000), walletId: foreign, walletProvider: 'nuvion' } });
      await h.backdate(p.id, 11);
      await h.sweep.runOnce(new Date(), 50);
      expect(h.calls(foreign, 'unfreeze')).toBe(0);
      expect(h.calls(foreign, 'freeze')).toBe(0);
    });

    it('DET7 rapid cycles, healthy provider: 25 x (DELETE, cancel) sequential; every answer exact', async () => {
      const { id, walletId } = await h.person(0);
      const pc = await h.piece(id);
      h.healthy(walletId);
      for (let i = 0; i < 25; i++) {
        const d = await del(h.accounts, id);
        if (!d.ok) throw new Error(`cycle ${i}: delete ${JSON.stringify(d)}`);
        expect(frozen(walletId)).toBe(true);
        expect(await pieceState(pc.id)).toBe('removed');
        const c = await can(h.accounts, id);
        if (!c.ok || !(c.r as any).cancelled) throw new Error(`cycle ${i}: cancel ${JSON.stringify(c)}`);
        expect((c.r as any).walletUnfrozen).toBe(true);
        expect(frozen(walletId)).toBe(false);
        expect(await pieceState(pc.id)).toBe('live');
      }
    });

    it('DET8 parallel bursts, healthy provider with delays: 20 x (3 DELETE + 3 cancel at once)', async () => {
      const { id, walletId } = await h.person(0);
      const pc = await h.piece(id);
      const bad: string[] = [];
      for (let i = 0; i < 20; i++) {
        const rnd = mulberry32(900 + i);
        h.plan(walletId, {
          freeze: Array.from({ length: 12 }, () => ({ answer: Math.floor(rnd() * 120), jitter: Math.floor(rnd() * 30) })),
          unfreeze: Array.from({ length: 12 }, () => ({ answer: Math.floor(rnd() * 120), jitter: Math.floor(rnd() * 30) })),
          balance: Array.from({ length: 12 }, () => ({ answer: Math.floor(rnd() * 120) })),
        });
        const res = await Promise.all([
          ...[0, 1, 2].map(async () => { await sleep(Math.floor(rnd() * 150)); return ['D', await del(h.accounts, id)] as const; }),
          ...[0, 1, 2].map(async () => { await sleep(Math.floor(rnd() * 150)); return ['C', await can(h.accounts, id)] as const; }),
        ]);
        const st = (await row(id))?.status ?? 'none';
        const fr = frozen(walletId);
        const ps = await pieceState(pc.id);
        const note = `${i}: ${st} fr=${fr} ps=${ps} ${res.map(([k, r]) => k + (r.ok ? ((r as any).r?.cancelled === true ? 'T' : (r as any).r?.cancelled === false ? 'F' : 'ok') : (r as any).status)).join(',')}`;
        if (st === 'scheduled' && !(fr && ps === 'removed')) bad.push(note);
        if ((st === 'cancelled' || st === 'none') && (fr || ps !== 'live')) bad.push(note);
        if (st === 'freezing') bad.push(note + ' STRANDED');
        h.healthy(walletId);
        if (st === 'scheduled' || st === 'freezing') await can(h.accounts, id);
        expect(frozen(walletId)).toBe(false);
      }
      expect(bad).toEqual([]);
    });

    it('DET9 (R4-2b) cancel x sweep, healthy provider: the cancel unfreezes (answer 1.5 s late); the sweep purges meanwhile; the purged account ends frozen and the cancel says it was too late', async () => {
      const { id, walletId } = await h.person(0);
      const pc = await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      h.plan(walletId, { unfreeze: [{ answer: 1500 }] });
      const cancel = can(h.accounts, id);
      await sleep(200); // the unfreeze has been applied at the provider, its answer is on the way
      expect(frozen(walletId)).toBe(false);
      await h.dueNow(id);
      const r = await h.sweep.runOnce(new Date(), 50);
      const c = await cancel;
      const rw = await row(id);
      expect(r.purged).toBe(1);
      expect(rw?.status).toBe('purged');
      expect(frozen(walletId)).toBe(true);
      expect(c.ok && (c as any).r).toMatchObject({ cancelled: false, walletUnfrozen: false, contentRestored: 0 });
      expect(await pieceState(pc.id)).not.toBe('live');
    });

    it('DET10 the cancel arrives while the row is purging (WAWU ID down so the row stays purging): refrozen', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      h.gateway.finalizeAccountDeletion.mockRejectedValue(new Error('down'));
      await h.dueNow(id);
      await h.sweep.runOnce(new Date(), 50);
      expect((await row(id))!.status).toBe('purging');
      const c = await can(h.accounts, id);
      expect(c.ok && (c as any).r).toMatchObject({ cancelled: false, deletionInProgress: true });
      expect(frozen(walletId)).toBe(true);
    });
  });

  describe('R4-4 a DELETE on a purged row', () => {
    it('answers as on a purging row, never schedules again, and touches nothing', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      const first = await del(h.accounts, id);
      expect(first.ok).toBe(true);
      await h.dueNow(id);
      expect((await h.sweep.runOnce(new Date(), 50)).purged).toBe(1);
      const purged = (await row(id))!;
      expect(purged.status).toBe('purged');
      const told = h.gateway.scheduleAccountDeletion.mock.calls.length;
      const again = await del(h.accounts, id);
      expect(again.ok).toBe(true);
      expect((again as any).r.deletionScheduledAt).toBe(purged.purgeAfter.toISOString());
      const after = (await row(id))!;
      expect(after.status).toBe('purged');
      expect(after.purgeAfter.getTime()).toBe(purged.purgeAfter.getTime());
      expect(h.gateway.scheduleAccountDeletion.mock.calls.length).toBe(told);
      expect(frozen(walletId)).toBe(true);
      // and a cancel on it restores nothing
      const c = await can(h.accounts, id);
      expect(c.ok && (c as any).r.cancelled).toBe(false);
      expect(frozen(walletId)).toBe(true);
    });
  });

  describe('R4-5 a lost answer heals within the hour, and a cancel only says what was confirmed', () => {
    it('a cancel whose unfreeze cannot be confirmed afterwards says walletUnfrozen false; the next sweep lets the wallet go', async () => {
      const { id, walletId } = await h.person(0);
      const pc = await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      // call 1: the up-front unfreeze works; call 2 (the reconcile after the commit): the provider does not answer
      h.plan(walletId, { unfreeze: [{}, { fail: 'before' }, { fail: 'before' }] });
      const c = await can(h.accounts, id);
      expect(c.ok).toBe(true);
      expect((c as any).r).toMatchObject({ cancelled: true, walletUnfrozen: false, contentRestored: 1 });
      expect((await row(id))!.status).toBe('cancelled');
      expect(await pieceState(pc.id)).toBe('live');
      // the provider is well again; the hourly pass finds the row changed within 24 hours
      h.wallets.get(walletId)!.frozen = true;
      h.healthy(walletId);
      await h.sweep.runOnce(new Date(), 50);
      expect(frozen(walletId)).toBe(false);
    });

    it('a stranded freezing row of a young request is not touched by the hourly pass but keeps its wallet frozen', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      h.plan(walletId, { freeze: [{ fail: 'lost' }], unfreeze: [{ fail: 'before' }] });
      expect((await del(h.accounts, id)).ok).toBe(false);
      h.healthy(walletId);
      await h.sweep.runOnce(new Date(), 50);
      expect((await row(id))!.status).toBe('freezing');
      expect(frozen(walletId)).toBe(true);
      // ten minutes on, the sweep lets it go
      await h.backdate(id, 11);
      await h.sweep.runOnce(new Date(), 50);
      expect(await row(id)).toBeNull();
      expect(frozen(walletId)).toBe(false);
    });

    it('a scheduled row whose wallet was unfrozen by a lost double fault is frozen again by the hourly pass', async () => {
      const { id, walletId } = await h.person(0);
      await h.piece(id);
      expect((await del(h.accounts, id)).ok).toBe(true);
      h.wallets.get(walletId)!.frozen = false;
      h.healthy(walletId);
      await h.prisma.accountDeletion.update({ where: { wawuUserId: id }, data: { walletFrozenAt: new Date() } });
      await h.sweep.runOnce(new Date(), 50);
      expect(frozen(walletId)).toBe(true);
    });
  });

  describe('reconcileWallet drives the provider to what the row says', () => {
    const row0 = (id: string, walletId: string, status: string, provider: string | null = 'fintava') =>
      h.prisma.accountDeletion.upsert({
        where: { wawuUserId: id },
        create: { wawuUserId: id, status, scheduledAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86400000), walletId, walletProvider: provider },
        update: { status, walletId, walletProvider: provider },
      });

    for (const [status, want] of [['freezing', true], ['scheduled', true], ['purging', true], ['purged', true], ['cancelled', false]] as const) {
      it(`row ${status}: the wallet ends ${want ? 'frozen' : 'unfrozen'}, from either start`, async () => {
        const p = await h.person(0);
        await row0(p.id, p.walletId, status);
        for (const start of [true, false]) {
          h.wallets.get(p.walletId)!.frozen = start;
          h.healthy(p.walletId);
          const r = await h.money.reconcileWallet(p.id);
          expect(r).toEqual({ want: want ? 'frozen' : 'unfrozen', done: true, failed: false });
          expect(frozen(p.walletId)).toBe(want);
        }
      });
    }

    it('no row: the wallet the caller names ends unfrozen; with no name nothing is asked', async () => {
      const p = await h.person(0);
      h.wallets.get(p.walletId)!.frozen = true;
      h.healthy(p.walletId);
      expect(await h.money.reconcileWallet(p.id)).toEqual({ want: null, done: false, failed: false });
      expect(frozen(p.walletId)).toBe(true);
      expect(h.calls(p.walletId, 'unfreeze')).toBe(0);
      const r = await h.money.reconcileWallet(p.id, { walletId: p.walletId, provider: 'fintava' });
      expect(r).toEqual({ want: 'unfrozen', done: true, failed: false });
      expect(frozen(p.walletId)).toBe(false);
    });

    it('a wallet of the other provider is never asked', async () => {
      const p = await h.person(0);
      const foreign = 'nuv-' + p.id;
      await row0(p.id, foreign, 'scheduled', 'nuvion');
      // Round 6 (ruling 4): the person's CURRENT wallet of the running provider
      // is frozen too, so for "only the other provider's wallet exists" the
      // person's own wallet row is the other provider's as well (a rollback).
      await h.prisma.fintavaWallet.update({ where: { wawuUserId: p.id }, data: { provider: 'nuvion' } });
      expect(await h.money.reconcileWallet(p.id)).toEqual({ want: null, done: false, failed: false });
      expect(h.calls(foreign, 'freeze') + h.calls(foreign, 'unfreeze')).toBe(0);
    });

    it('a provider error never throws and leaves the row as it is', async () => {
      const p = await h.person(0);
      await row0(p.id, p.walletId, 'scheduled');
      const before = await row(p.id);
      h.plan(p.walletId, { freeze: [{ fail: 'before' }] });
      const r = await h.money.reconcileWallet(p.id);
      expect(r).toEqual({ want: 'frozen', done: false, failed: true });
      const after = await row(p.id);
      expect(after!.status).toBe('scheduled');
      expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
      // asked again, it works
      expect((await h.money.reconcileWallet(p.id)).done).toBe(true);
      expect(frozen(p.walletId)).toBe(true);
    });

    it('no row and the unfreeze not answered: a freezing row is written so the hourly pass has something to find', async () => {
      const p = await h.person(0);
      h.wallets.get(p.walletId)!.frozen = true;
      h.plan(p.walletId, { unfreeze: [{ fail: 'before' }] });
      const r = await h.money.reconcileWallet(p.id, { walletId: p.walletId, provider: 'fintava' });
      expect(r).toEqual({ want: 'unfrozen', done: false, failed: true });
      expect((await row(p.id))!).toMatchObject({ status: 'freezing', walletId: p.walletId });
      expect(frozen(p.walletId)).toBe(true);
      await h.backdate(p.id, 11);
      h.healthy(p.walletId);
      await h.sweep.runOnce(new Date(), 50);
      expect(await row(p.id)).toBeNull();
      expect(frozen(p.walletId)).toBe(false);
    });

    it('two at once are taken one after the other, and the later one reads the row after the earlier one finished', async () => {
      const p = await h.person(0);
      await row0(p.id, p.walletId, 'scheduled');
      h.plan(p.walletId, { freeze: [{ answer: 300 }] });
      const first = h.money.reconcileWallet(p.id);
      await sleep(50);
      await h.prisma.accountDeletion.update({ where: { wawuUserId: p.id }, data: { status: 'cancelled' } });
      const second = h.money.reconcileWallet(p.id);
      await Promise.all([first, second]);
      expect(frozen(p.walletId)).toBe(false);
    });
  });
});
