import type {
  AbroadFeeLegRef,
  AbroadProvider,
} from '../../wallet-provider/abroad-provider';
import type { WalletProvider } from '../../wallet-provider/wallet-provider.interface';

/**
 * The two book transfers around WAWU's fee on a send abroad (NUV-11 round 1, as WALLET-21 collects its fee and as naira Send gives
 * its fee back, FIX-66 and FIX-98): the fee out of the person's naira wallet to WAWU's account (`<reference>-fee`), and the same
 * money back (`<reference>-fee-back`) when the send did not stand.
 *
 * A leg is done only when the provider's own record says it completed. The provider answers a repeat of a reference with the
 * record it already holds, so a reference it failed is spent: the next try is a new one (`-2`, then `-3`), and only in a LATER pass
 * than the one that saw the failure. A refused or lost ask is asked again under the same reference. Three failed references
 * are `spent`, and a person looks.
 */
export const LEG_GENERATIONS = 3;

/** The first try is the base reference; the next ones add `-2` and `-3`. */
export function legReference(base: string, generation: number): string {
  return generation === 1 ? base : `${base}-${generation}`;
}

export type LegInput = {
  fromAccountNumber: string;
  toAccountNumber: string;
  amountKobo: bigint;
  narration: string;
};

/** What a completed leg moved, and what the provider charged for moving it (both are the fee's to give back). */
export type LegMoved = { amountKobo: bigint; feeKobo: bigint };

export type LegResult =
  | { result: 'done'; moved: LegMoved }
  /** Not finished or not known yet: asked again in a later pass. */
  | { result: 'wait' }
  /** Every reference failed at the provider. */
  | { result: 'spent' };

/** The record of the leg's own transfer: completed, still going, or none at all. */
export type LegRead =
  { result: 'done'; moved: LegMoved } | { result: 'wait' } | { result: 'none' };

/**
 * How a leg is looked for and made. The two ports differ only in where the money is: the naira wallet (kobo, by account number) or a
 * foreign account (its own currency's smallest unit, WALLET-42). The reference generations, what counts as done and what a refusal
 * means are the same code for both below, so a foreign fee is never a second mechanism.
 */
export type LegFound =
  | {
      state: 'found';
      outcome: 'completed' | 'failed' | 'reversed' | 'pending' | null;
      moved: LegMoved;
    }
  | { state: 'absent' }
  | { state: 'unknown' };

export interface LegPort {
  /** The provider's record under one reference. */
  find(reference: string): Promise<LegFound>;
  /** Asks for the leg under one reference; `pending` when accepted and not finished. */
  make(reference: string): Promise<{ pending: boolean; moved: LegMoved }>;
}

/** Reads the leg without making it: the first reference whose record is not a failed one. Never sends. */
export async function readLegWith(
  port: Pick<LegPort, 'find'>,
  base: string,
): Promise<LegRead> {
  for (let generation = 1; generation <= LEG_GENERATIONS; generation += 1) {
    let found: LegFound;
    try {
      found = await port.find(legReference(base, generation));
    } catch {
      return { result: 'wait' };
    }
    if (found.state === 'unknown') return { result: 'wait' };
    if (found.state === 'absent') return { result: 'none' };
    if (found.outcome === 'completed') {
      return { result: 'done', moved: found.moved };
    }
    if (found.outcome === 'failed' || found.outcome === 'reversed') continue;
    return { result: 'wait' };
  }
  return { result: 'none' };
}

/** Makes the leg once: finds its record first, asks only under a reference the provider holds no record of. */
export async function settleLegWith(
  port: LegPort,
  base: string,
  warn: (message: string) => void,
): Promise<LegResult> {
  for (let generation = 1; generation <= LEG_GENERATIONS; generation += 1) {
    const reference = legReference(base, generation);
    let found: LegFound;
    try {
      found = await port.find(reference);
    } catch {
      return { result: 'wait' };
    }
    if (found.state === 'unknown') return { result: 'wait' };
    if (found.state === 'found') {
      if (found.outcome === 'completed') {
        return { result: 'done', moved: found.moved };
      }
      // A spent reference: the next one.
      if (found.outcome === 'failed' || found.outcome === 'reversed') continue;
      return { result: 'wait' };
    }
    try {
      const receipt = await port.make(reference);
      // Accepted and not finished: done only when a later read says completed.
      if (receipt.pending) return { result: 'wait' };
      return { result: 'done', moved: receipt.moved };
    } catch (e) {
      warn(
        `${reference}: the provider did not take it (${e instanceof Error ? e.name : 'error'}); asked again in a later pass`,
      );
      // A failed one is replaced by a new reference in the NEXT pass, never in this one.
      return { result: 'wait' };
    }
  }
  return { result: 'spent' };
}

/** The naira wallet's port: the provider's book transfer between two account numbers. */
function nairaPort(provider: WalletProvider, input?: LegInput): LegPort {
  return {
    async find(reference) {
      const found = await provider.findTransactionByReference(reference);
      if (found.state !== 'found') return found;
      const t = found.transaction;
      return {
        state: 'found',
        outcome: t.outcome,
        moved: { amountKobo: t.amountKobo, feeKobo: t.feeKobo ?? 0n },
      };
    },
    async make(reference) {
      if (!input) throw new Error('no leg to make');
      const receipt = await provider.walletToWallet({ ...input, reference });
      return {
        pending: receipt.pending === true,
        moved: { amountKobo: receipt.amountKobo, feeKobo: receipt.feeKobo },
      };
    },
  };
}

/**
 * A foreign account's port (WALLET-42): the abroad side's `feeLeg` between the person's account and WAWU's collecting account in
 * the same currency. `amountMinor` is in that currency's smallest unit (carried in `LegMoved.amountKobo`, whose name is older).
 */
export function foreignPort(
  abroad: AbroadProvider,
  ref: AbroadFeeLegRef,
  amountMinor?: bigint,
  narration = 'WAWU fee',
): LegPort {
  return {
    async find(reference) {
      if (!abroad.findFeeLeg) return { state: 'unknown' };
      const found = await abroad.findFeeLeg(ref, reference);
      if (found.state !== 'found') return found;
      return {
        state: 'found',
        outcome: found.leg.state,
        moved: {
          amountKobo: found.leg.amountMinor,
          feeKobo: found.leg.feeMinor,
        },
      };
    },
    async make(reference) {
      if (!abroad.feeLeg || amountMinor === undefined) {
        throw new Error('this provider cannot move a foreign fee');
      }
      const leg = await abroad.feeLeg({
        ...ref,
        amountMinor,
        reference,
        narration,
      });
      if (leg.state === 'failed') throw new Error('the provider failed it');
      return {
        pending: leg.state === 'pending',
        moved: { amountKobo: leg.amountMinor, feeKobo: leg.feeMinor },
      };
    },
  };
}

/** Reads the naira leg without making it. Never sends. */
export function readLeg(
  provider: WalletProvider,
  base: string,
): Promise<LegRead> {
  return readLegWith(nairaPort(provider), base);
}

/** Makes the naira leg once. */
export function settleLeg(
  provider: WalletProvider,
  base: string,
  input: LegInput,
  warn: (message: string) => void,
): Promise<LegResult> {
  return settleLegWith(nairaPort(provider, input), base, warn);
}
