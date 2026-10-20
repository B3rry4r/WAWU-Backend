/* eslint-disable */
import { type Step, mulberry32, sleep, useHarness } from './round5-harness';

/**
 * SETTINGS-06 round 5: the verifier's random races of round 4 (zz-v4-attacks
 * and zz-v4-staged, their rounds, seeds and checks kept), and the three seeds
 * that broke round 4 (R4-1: 5481, 7182, 12585). A round ends with an
 * invariant check; a round that breaks it is given ONE healthy hourly sweep,
 * and only a round still broken after that fails (a provider that fails a
 * call and the repair of it is the named double fault, which the hourly pass
 * is for). `R5_FULL=1` runs every set at the verifier's size (the default is
 * a third, to keep the CI suite short); the numbers of rounds that needed the
 * sweep are logged.
 */
describe('SETTINGS-06 round 5: random races end with the invariant', () => {
  jest.setTimeout(1800000);
  const h = useHarness();
  const { del, can, row, frozen, pieceState } = h;
  const size = (n: number) => (process.env.R5_FULL ? n : Math.ceil(n / 3));

  type Kind = 'delete' | 'cancel' | 'sweep' | 'due';
  type Opts = {
    Jmax: number; Dmax: number; span: number;
    pf: number; pl: number; // freeze before / lost probability
    puf: number; pul: number; // unfreeze before / lost
    pb: number; // balance fail
    staged?: boolean;
    nDel: [number, number]; nCan: [number, number]; nSweep: [number, number]; nDue: [number, number];
  };

  /** What the rule asks of a row and a wallet, as problems (empty: it holds). */
  function broken(st: string, fr: boolean, ps: string): string[] {
    const v: string[] = [];
    if (st === 'scheduled' && ps !== 'removed') v.push(`scheduled piece=${ps}`);
    if ((st === 'none' || st === 'cancelled') && (fr || ps !== 'live')) v.push(`${st} frozen=${fr} piece=${ps}`);
    if ((st === 'scheduled' || st === 'purging' || st === 'purged') && !fr) v.push(`${st} but wallet unfrozen`);
    return v;
  }

  async function race(seed: number, o: Opts) {
    const rnd = mulberry32(seed);
    const r = (n: number) => Math.floor(rnd() * n);
    const range = ([a, b]: [number, number]) => a + r(b - a + 1);
    await h.isolate();
    const { id, walletId } = await h.person(0);
    const pc = await h.piece(id);
    const mk = (kind: 'freeze' | 'unfreeze' | 'balance'): Step[] =>
      Array.from({ length: 10 }, () => {
        const x = rnd();
        let fail: Step['fail'];
        if (kind === 'freeze') fail = x < o.pf ? 'before' : x < o.pf + o.pl ? 'lost' : undefined;
        if (kind === 'unfreeze') fail = x < o.puf ? 'before' : x < o.puf + o.pul ? 'lost' : undefined;
        if (kind === 'balance') fail = x < o.pb ? 'before' : undefined;
        return { jitter: o.Jmax ? r(o.Jmax + 1) : 0, answer: r(o.Dmax + 1), fail };
      });
    const faulty = { freeze: mk('freeze'), unfreeze: mk('unfreeze'), balance: mk('balance') };
    if (o.staged) {
      h.healthy(walletId);
      const first = await del(h.accounts, id);
      if (!first.ok) throw new Error('staged DELETE failed');
    }
    h.plans.set(walletId, faulty);
    h.counts.set(walletId, { freeze: 0, unfreeze: 0, balance: 0 });
    const reqs: { type: Kind; at: number }[] = [];
    const add = (type: Kind, n: number) => { for (let i = 0; i < n; i++) reqs.push({ type, at: r(o.span) }); };
    add('delete', range(o.nDel)); add('cancel', range(o.nCan)); add('sweep', range(o.nSweep)); add('due', range(o.nDue));
    const t0 = performance.now();
    const res = await Promise.all(
      reqs.map(async (q) => {
        await sleep(q.at);
        let out: string;
        let cancelledTrue = false;
        let walletUnfrozenTrue = false;
        let delOk = false;
        if (q.type === 'delete') { const x = await del(h.accounts, id); delOk = x.ok; out = x.ok ? 'ok' : `${x.status}:${x.msg.slice(0, 30)}`; }
        else if (q.type === 'cancel') { const x = await can(h.accounts, id); cancelledTrue = x.ok && (x.r as any).cancelled === true; walletUnfrozenTrue = x.ok && (x.r as any).walletUnfrozen === true; out = x.ok ? JSON.stringify(x.r).slice(0, 80) : `${x.status}`; }
        else if (q.type === 'due') { await h.dueNow(id); await h.sweep.runOnce(new Date(), 50); out = 'swept'; }
        else { await h.sweep.runOnce(new Date(), 50); out = 'swept'; }
        return { q, out, cancelledTrue, walletUnfrozenTrue, delOk };
      }),
    );
    const st0 = (await row(id))?.status ?? 'none';
    const fr0 = frozen(walletId);
    const ps0 = await pieceState(pc.id);
    const v: string[] = [];
    const anyCancelTrue = res.some((x) => x.cancelledTrue);
    const anyCancelReq = res.some((x) => x.q.type === 'cancel');
    if (anyCancelTrue && (st0 === 'purged' || st0 === 'purging')) v.push(`cancel said restored but ${st0}`);
    if (anyCancelTrue && ps0 === 'gone') v.push('cancel said restored but piece gone');
    if (!anyCancelReq && res.some((x) => x.delOk) && st0 !== 'scheduled' && st0 !== 'purging' && st0 !== 'purged') v.push(`delete ok but ${st0}`);
    // a cancel says the wallet is unfrozen only if it is (checked now, before anything heals)
    const lied = res.some((x) => x.walletUnfrozenTrue) && fr0 && st0 === 'cancelled';
    if (lied) v.push('cancel said walletUnfrozen but the wallet is frozen');
    const first = broken(st0, fr0, ps0);
    let healedBy = 'n/a';
    // heal paths with a healthy provider
    if (st0 === 'freezing') {
      h.healthy(walletId);
      if (seed % 2 === 0) { await h.backdate(id); await h.sweep.runOnce(new Date(), 50); healedBy = 'sweep'; }
      else { const c = await can(h.accounts, id); healedBy = `cancel:${c.ok ? JSON.stringify(c.r) : c.status}`; }
      const d2 = await row(id);
      if (!((d2 === null || d2.status === 'cancelled') && !frozen(walletId) && (await pieceState(pc.id)) === 'live')) v.push(`freezing NOT healed by ${healedBy}: row=${d2?.status} frozen=${frozen(walletId)}`);
    } else if (first.length > 0) {
      // the named double fault: the call and its repair both failed. One healthy hourly pass.
      h.healthy(walletId);
      await h.sweep.runOnce(new Date(), 50);
      healedBy = 'one sweep';
      const again = broken((await row(id))?.status ?? 'none', frozen(walletId), await pieceState(pc.id));
      for (const m of again) v.push(`NOT healed by one sweep: ${m}`);
    }
    return { seed, v, st: st0, first, healedBy, reqs: res.map((x) => `${x.q.type}:${x.out}`) };
  }

  const base: Opts = { Jmax: 0, Dmax: 250, span: 260, pf: 0, pl: 0, puf: 0, pul: 0, pb: 0, nDel: [1, 3], nCan: [0, 2], nSweep: [0, 0], nDue: [0, 0] };
  const faults = { pf: 0.15, pl: 0.1, puf: 0.15, pul: 0.1, pb: 0.05 };
  const SETS: [string, Opts, number, number][] = [
    ['R1 FIFO healthy provider, DELETE x1-4 + cancel x0-3', { ...base, nDel: [1, 4], nCan: [0, 3] }, 3000, 60],
    ['R2 FIFO, freeze/unfreeze fail 20%, lost 10%, balance 8%', { ...base, pf: 0.2, pl: 0.1, puf: 0.2, pul: 0.1, pb: 0.08 }, 4000, 70],
    ['R3 jitter 40ms (reordering), faults', { ...base, Jmax: 40, ...faults }, 5000, 70],
    ['R4 sweep + purge racing DELETE/cancel, healthy', { ...base, nDel: [1, 2], nCan: [0, 2], nSweep: [0, 2], nDue: [0, 2], span: 200 }, 6000, 60],
    ['R5 sweep + purge racing, faults and jitter', { ...base, Jmax: 30, nDel: [1, 3], nCan: [0, 2], nSweep: [0, 2], nDue: [1, 2], span: 260, ...faults }, 7000, 70],
    ['P1 staged: scheduled, then due+sweep x1-2, cancel x1-2, repeat DELETE x0-2; FIFO, faults', { ...base, staged: true, nDel: [0, 2], nCan: [1, 2], nSweep: [0, 1], nDue: [1, 2], span: 300, ...faults, pb: 0.1 }, 11000, 70],
    ['P2 staged, jitter 40ms, faults', { ...base, staged: true, Jmax: 40, nDel: [0, 2], nCan: [1, 2], nSweep: [0, 1], nDue: [1, 2], span: 300, ...faults, pb: 0.1 }, 12000, 70],
    ['P3 staged, healthy provider, long answers', { ...base, staged: true, Dmax: 400, nDel: [0, 2], nCan: [1, 2], nSweep: [0, 1], nDue: [1, 2], span: 500 }, 13000, 50],
    ['P1 staged, no repeat DELETE', { ...base, staged: true, nDel: [0, 0], nCan: [1, 2], nSweep: [0, 1], nDue: [1, 2], span: 300, ...faults, pb: 0.1 }, 11000, 70],
    ['P2 staged, no repeat DELETE, jitter 40ms', { ...base, staged: true, Jmax: 40, nDel: [0, 0], nCan: [1, 2], nSweep: [0, 1], nDue: [1, 2], span: 300, ...faults, pb: 0.1 }, 12000, 70],
  ];
  for (const [name, o, s0, n] of SETS) {
    it(name, async () => {
      const out: Awaited<ReturnType<typeof race>>[] = [];
      for (let i = 0; i < size(n); i++) out.push(await race(s0 + i * 13, o));
      const viol = out.filter((x) => x.v.length > 0);
      const hist: Record<string, number> = {};
      for (const x of out) hist[x.st] = (hist[x.st] ?? 0) + 1;
      console.log(`${name}: rounds ${out.length}, end states ${JSON.stringify(hist)}, needed the sweep ${out.filter((x) => x.first.length > 0).length}, failing ${viol.length}`);
      for (const x of viol.slice(0, 4)) console.log('  viol', JSON.stringify(x));
      require('fs').appendFileSync(process.env.R5_OUT || '/dev/null', JSON.stringify({ name, rounds: out.length, sweep: out.filter((x) => x.first.length > 0).map((x) => x.seed), viol }) + '\n');
      expect(viol.map((x) => ({ seed: x.seed, v: x.v }))).toEqual([]);
    });
  }

  // The three seeds that broke round 4 (R4-1), with the options of the set each came from.
  const NAMED: [number, number, Opts][] = [
    [5481, 5000, { ...base, Jmax: 40, ...faults }],
    [7182, 7000, { ...base, Jmax: 30, nDel: [1, 3], nCan: [0, 2], nSweep: [0, 2], nDue: [1, 2], span: 260, ...faults }],
    [12585, 12000, { ...base, staged: true, Jmax: 40, nDel: [0, 2], nCan: [1, 2], nSweep: [0, 1], nDue: [1, 2], span: 300, ...faults, pb: 0.1 }],
  ];
  for (const [seed, , o] of NAMED) {
    it(`the verifier's seed ${seed} (R4-1) ends with the invariant`, async () => {
      const x = await race(seed, o);
      expect(x.v).toEqual([]);
    });
  }
});
