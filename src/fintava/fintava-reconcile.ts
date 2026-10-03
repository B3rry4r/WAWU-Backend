import type {
  FintavaReconciliation,
  FintavaRetryDecision,
  FintavaSendKind,
} from './fintava.interface';

/**
 * What may be done with a send whose answer was lost, given what Fintava
 * knows about its reference (mobile repo `docs/fintava/naira-api.md`, "No
 * Idempotency-Key, but our reference does the job" and "A refused send is
 * not always clean"):
 *
 * - Found and SUCCESS: settled. Never send it again.
 * - Found and PENDING or ONGOING (or a status we do not know): wait. A
 *   PENDING bank send may be a refused send's orphan record that never
 *   moves money; it may also be a real send in flight. MONEY-08 and MONEY-16
 *   tell those apart, never a retry.
 * - Found and FAILURE or CANCELLED: the reference is used up; a new one.
 * - Absent (the lookup answered Fintava's own `404 "Transaction not
 *   found!"` AND a complete walk of the sender's history, back to the
 *   send's time, has no row for the reference): a
 *   wallet-to-wallet send may go again under the same reference, because a
 *   refused one writes nothing and leaves its reference usable; a bank send
 *   only under a new reference. Never sooner than `resendAfterMs` after the
 *   first send (the money timeout plus a safety window): Fintava keeps
 *   working after the client gives up, so a fresh 404 proves nothing.
 * - Unknown (the lookup answered `{}` and history did not show it, the
 *   history walk stopped before the send's time, or Fintava could not be
 *   asked): wait. `{}` is never "not found", and neither is a history
 *   walk cut off by its page limit.
 */
export function decideFintavaRetry(
  kind: FintavaSendKind,
  reconciliation: FintavaReconciliation,
  clock: { attemptedAt: Date; now: Date; resendAfterMs: number },
): FintavaRetryDecision {
  switch (reconciliation.state) {
    case 'found': {
      const t = reconciliation.transaction;
      const status = t.status.toUpperCase();
      if (status === 'SUCCESS') return { action: 'settled', transaction: t };
      if (status === 'FAILURE' || status === 'CANCELLED') {
        return {
          action: 'resend_new_reference',
          why: 'failed',
          transaction: t,
        };
      }
      return { action: 'wait', why: 'pending' };
    }
    case 'absent': {
      const age = clock.now.getTime() - clock.attemptedAt.getTime();
      if (age < clock.resendAfterMs) {
        return { action: 'wait', why: 'too_soon' };
      }
      return kind === 'wallet_to_wallet'
        ? { action: 'resend_same_reference' }
        : { action: 'resend_new_reference', why: 'absent', transaction: null };
    }
    case 'unknown':
      return { action: 'wait', why: reconciliation.why };
  }
}
