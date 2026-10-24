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

/** Reads the leg without making it: the first reference whose record is not a failed one. Never sends. */
export async function readLeg(
  provider: WalletProvider,
  base: string,
): Promise<LegRead> {
  for (let generation = 1; generation <= LEG_GENERATIONS; generation += 1) {
    let found;
    try {
      found = await provider.findTransactionByReference(
        legReference(base, generation),
      );
    } catch {
      return { result: 'wait' };
    }
    if (found.state === 'unknown') return { result: 'wait' };
    if (found.state === 'absent') return { result: 'none' };
    const t = found.transaction;
    if (t.outcome === 'completed') {
      return {
        result: 'done',
        moved: { amountKobo: t.amountKobo, feeKobo: t.feeKobo ?? 0n },
      };
    }
    if (t.outcome === 'failed' || t.outcome === 'reversed') continue;
    return { result: 'wait' };
  }
  return { result: 'none' };
}

/** Makes the leg once: finds its record first, asks only under a reference the provider holds no record of. */
export async function settleLeg(
  provider: WalletProvider,
  base: string,
  input: LegInput,
  warn: (message: string) => void,
): Promise<LegResult> {
  for (let generation = 1; generation <= LEG_GENERATIONS; generation += 1) {
    const reference = legReference(base, generation);
    let found;
    try {
      found = await provider.findTransactionByReference(reference);
    } catch {
      return { result: 'wait' };
    }
    if (found.state === 'unknown') return { result: 'wait' };
    if (found.state === 'found') {
      const t = found.transaction;
      if (t.outcome === 'completed') {
        return {
          result: 'done',
          moved: { amountKobo: t.amountKobo, feeKobo: t.feeKobo ?? 0n },
        };
      }
      // A spent reference: the next one.
      if (t.outcome === 'failed' || t.outcome === 'reversed') continue;
      return { result: 'wait' };
    }
    try {
      const receipt = await provider.walletToWallet({ ...input, reference });
      // Accepted and not finished: done only when a later read says completed.
      if (receipt.pending === true) return { result: 'wait' };
      return {
        result: 'done',
        moved: { amountKobo: receipt.amountKobo, feeKobo: receipt.feeKobo },
      };
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
