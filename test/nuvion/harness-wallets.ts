import { basename } from 'node:path';
import { MERCHANT_ACCOUNT } from '../fintava/fintava-double';
import type { FintavaDouble } from '../fintava/fintava-double';
import {
  type NuvionAccount,
  NuvionSeamStandIn,
  type NuvionSendMode,
} from '../payments/nuvion-seam-standin';
import type { Wallets } from '../plans/tier-purchase-harness';

/**
 * HARNESS-NUV (17 Oct 2026): the shared wallet harnesses run on Nuvion.
 *
 * Nuvion is the wallet provider (R-39, R-45). The shared harnesses used to
 * boot the Fintava double for specs whose subject is not Fintava. They now
 * boot `WALLET_PROVIDER=nuvion` with Nuvion stood in at the seam
 * (`NuvionSeamStandIn`, the one the `*-nuvion` specs use), and hand the specs
 * the same handles as before (`h.wallets`, `h.double`) so the specs do not
 * change:
 *
 * - `h.wallets.kobo.get/set(accountNumber)` read and write the stand-in's
 *   account balances (`MERCHANT_ACCOUNT` is WAWU's operational account);
 * - `h.wallets.mode = 'timeout'` makes Nuvion take the next book transfers
 *   and lose the answer; going back to `'live'` lets Nuvion finish what it
 *   took (the money had moved, only the answer was lost);
 * - `h.wallets.sends` lists the book transfers Nuvion recorded;
 * - `h.wallets.hidden.add(ref)` is Nuvion lagging on a reference
 *   (`unseen`), `h.wallets.failures.add(ref)` is Nuvion finishing that
 *   transfer as `failed` (the money comes back);
 * - `h.double.seen` lists the transfers Nuvion was asked for, as
 *   `POST /transaction/wallet-to-wallet`-shaped rows so the existing
 *   "no money move was asked for" checks still mean the same;
 *   `h.double.pause()` is Nuvion not taking transfers (nothing taken, try later) and
 *   `resume()` brings it back.
 *
 * What cannot be mapped is Fintava's own endpoint scripting: `h.double.on`,
 * `installFintava`, `h.wallets.references`, `h.wallets.byId` and
 * `h.wallets.sends.push` are Fintava payload, endpoint and record facts. A
 * spec that uses them is Fintava-bound: its name is in `FINTAVA_BOUND_SPECS`,
 * the harness boots the Fintava double for it exactly as before, and the
 * Nuvion handles below throw a plain error if a spec reaches for one.
 *
 * The fee bands below are spec values (NUV-07: "no figure is a fact"). They
 * equal the numbers the old harness's `liveFee` returned, so the balance
 * arithmetic in the specs (`start - price - liveFee(price)`) is unchanged;
 * they are not Nuvion's real figures.
 */

/** Spec values for Nuvion's three fee settings, kobo by band (nuvion-fee-config.ts). */
export const HARNESS_NUVION_FEE_BANDS = '0:2325,500000:1575';
const harnessFee = (amountKobo: bigint): bigint =>
  amountKobo < 500_000n ? 2325n : 1575n;

/** WAWU's operational account starts with this much, kobo (the double's merchant wallet held more than any spec spends). */
const OPERATIONAL_START_KOBO = 5_000_000_000n;

/**
 * The spec files that still need the Fintava double, by file name, and why.
 * Each uses Fintava's own endpoint scripting (`h.double.on`, `installFintava`,
 * `wallets.references`, `wallets.sends.push`) or is about a Fintava rail
 * (bills, R-45). Everything else runs on Nuvion. When one of these is
 * converted or deleted, take its name out.
 */
export const FINTAVA_BOUND_SPECS: ReadonlySet<string> = new Set([
  // Fintava endpoint scripting (double.on / installFintava / references / sends.push).
  'event-call-off-refund.contract.spec.ts',
  'plan-transfer-provider-errors.contract.spec.ts',
  'plan-transfer-sweep.contract.spec.ts',
  'referrals.contract.spec.ts',
  // They write wallet payment rows by hand, and a row defaults to
  // provider 'fintava': a server on Nuvion leaves those rows (and their
  // holds) alone, so their refunds never run.
  'plan-purchase-delivery.contract.spec.ts',
  'plan-purchase-failures.contract.spec.ts',
  // Its check 1 matches the ledger row to the transfer by the merchant
  // account number Fintava's ledger recorded.
  'credit-wallet.contract.spec.ts',
]);

/** True when the spec file now running is on the Fintava-bound list. */
export function runsOnFintavaDouble(): boolean {
  const path = expect.getState().testPath ?? '';
  return FINTAVA_BOUND_SPECS.has(basename(path));
}

const fintavaOnly = (what: string): never => {
  throw new Error(
    `${what} is Fintava's own endpoint scripting. This spec runs on Nuvion; if it needs this, add its file name to FINTAVA_BOUND_SPECS in test/nuvion/harness-wallets.ts.`,
  );
};

/** `h.wallets.kobo`: account number to kobo, read from and written to the stand-in's accounts. */
class NuvionKobo extends Map<string, number> {
  constructor(private readonly rig: NuvionHarnessRig) {
    super();
  }
  override get(accountNumber: string): number | undefined {
    const a = this.rig.accountOf(accountNumber);
    return a ? Number(a.availableKobo) : undefined;
  }
  override has(accountNumber: string): boolean {
    return this.rig.accountOf(accountNumber) !== undefined;
  }
  override set(accountNumber: string, kobo: number): this {
    const a = this.rig.accountOf(accountNumber);
    if (a) a.availableKobo = BigInt(kobo);
    else this.rig.openAccount(kobo, accountNumber);
    return this;
  }
}

/** `h.wallets.failures`: adding a reference makes Nuvion finish that transfer as `failed`. */
class NuvionFailures extends Set<string> {
  constructor(private readonly rig: NuvionHarnessRig) {
    super();
  }
  override add(reference: string): this {
    super.add(reference);
    const t = this.rig.standin.transfers.find(
      (x) => x.request.unique_reference === reference,
    );
    if (t) this.rig.standin.settle(reference, 'failed');
    return this;
  }
}

export class NuvionHarnessRig {
  readonly standin = new NuvionSeamStandIn();
  private readonly byNumber = new Map<string, NuvionAccount>();
  private liveMode: NuvionSendMode = 'successful';
  private pausedFrom: NuvionSendMode | null = null;
  private seenCursor = 0;
  private readonly seenRows: FintavaDouble['seen'] = [];

  /** The settings the booted app needs for Nuvion (merged into process.env by the harness). */
  readonly env: Record<string, string> = {
    WALLET_PROVIDER: 'nuvion',
    NUVION_FEE_BOOK_TRANSFER: HARNESS_NUVION_FEE_BANDS,
    NUVION_FEE_BANK_PAYOUT: HARNESS_NUVION_FEE_BANDS,
    NUVION_FEE_INFLOW: HARNESS_NUVION_FEE_BANDS,
    WAWU_LIMIT_PURCHASE_DAILY_KOBO: '100000000',
  };

  readonly wallets: Wallets;
  /**
   * What `h.double` is on Nuvion. Typed as the Fintava double so a spec that
   * passes `h.double` on (the Fintava-bound ones) still compiles; it has only
   * the members the Nuvion specs use (`seen`, `pause`, `resume`, `reset`) and
   * `on` throws.
   */
  readonly double: FintavaDouble;

  constructor() {
    this.standin.mode = 'successful';
    this.standin.feeKobo = harnessFee;
    this.standin.operational.availableKobo = OPERATIONAL_START_KOBO;
    // Some specs write payment rows that name WAWU's account by the number the
    // old harness gave it; the operational account answers to that number.
    this.standin.operational.accountNumber = MERCHANT_ACCOUNT;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const rig = this;
    const failures = new NuvionFailures(rig);
    this.wallets = {
      kobo: new NuvionKobo(rig),
      get byId(): Wallets['byId'] {
        return fintavaOnly('wallets.byId');
      },
      get references(): Wallets['references'] {
        return fintavaOnly('wallets.references');
      },
      get sends(): Wallets['sends'] {
        return rig.sends();
      },
      get mode(): Wallets['mode'] {
        return rig.standin.mode === 'timeout' ? 'timeout' : 'live';
      },
      set mode(m: Wallets['mode']) {
        rig.setMode(m);
      },
      hidden: this.standin.unseen,
      failures,
    };
    this.double = {
      get seen() {
        return rig.seen();
      },
      on: () => fintavaOnly('double.on'),
      pause: () => {
        rig.pausedFrom ??= rig.standin.mode;
        // Nothing is taken and the Hub is told to try again later (Nuvion's
        // 429): the nearest answer Nuvion has to a closed port.
        rig.standin.mode = 'rate_limited';
        return Promise.resolve();
      },
      resume: () => {
        if (rig.pausedFrom) rig.standin.mode = rig.pausedFrom;
        rig.pausedFrom = null;
        return Promise.resolve();
      },
      reset: () => {
        rig.seenRows.length = 0;
        rig.seenCursor = rig.standin.calls.length;
      },
    } as unknown as FintavaDouble;
  }

  /** A person's approved account holding `kobo`, found later by its account number. */
  openAccount(kobo: number, accountNumber: string): NuvionAccount {
    const a = this.standin.openAccount(BigInt(kobo), accountNumber);
    this.byNumber.set(accountNumber, a);
    return a;
  }

  /** The account for a number (the merchant number is WAWU's operational account). */
  accountOf(accountNumber: string): NuvionAccount | undefined {
    if (accountNumber === MERCHANT_ACCOUNT) return this.standin.operational;
    return this.byNumber.get(accountNumber);
  }

  private numberOf(accountId: string): string {
    const a = this.standin.accounts.get(accountId);
    if (!a || a.type === 'operational') return MERCHANT_ACCOUNT;
    return a.accountNumber ?? '';
  }

  private sends(): Wallets['sends'] {
    return this.standin.transfers.map((t) => ({
      from: this.numberOf(t.fromAccountId),
      to: this.numberOf(t.toAccountId),
      amountKobo: Number(t.amountKobo),
      feeKobo: Number(t.feeKobo),
      reference: t.request.unique_reference,
    }));
  }

  /**
   * The transfers Nuvion was asked for since the last `reset()`, one row per
   * book transfer call, shaped like the rows the old checks look at.
   */
  private seen(): FintavaDouble['seen'] {
    const calls = this.standin.calls;
    for (; this.seenCursor < calls.length; this.seenCursor += 1) {
      if (calls[this.seenCursor].method === 'walletToWallet') {
        this.seenRows.push({
          method: 'POST',
          path: '/transaction/wallet-to-wallet',
          body: calls[this.seenCursor].args,
        } as FintavaDouble['seen'][number]);
      }
    }
    return this.seenRows;
  }

  private setMode(m: Wallets['mode']): void {
    if (m === 'timeout') {
      this.liveMode =
        this.standin.mode === 'timeout' ? 'successful' : this.standin.mode;
      this.standin.mode = 'timeout';
      return;
    }
    const was = this.standin.mode;
    this.standin.mode = this.liveMode;
    if (was === 'timeout') {
      // Nuvion took those transfers while the answer was lost: they finish now.
      for (const t of this.standin.transfers) {
        if (t.status === 'pending' || t.status === 'processing') {
          this.standin.settle(t.request.unique_reference, 'successful');
        }
      }
    }
  }
}
