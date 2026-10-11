import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type {
  LedgerRecordResult,
  LedgerWallet,
} from '../../money/ledger/ledger.interface';
import type { LedgerService } from '../../money/ledger/ledger.service';
import type { TransferStatus } from '../../money/money-view.type';
import type {
  ProviderHolder,
  ProviderReconciliation,
  ProviderRetryDecision,
  ProviderSendKind,
  ProviderTransaction,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { isNuvionId, NUVION_NAIRA, nuvionWalletId } from '../areas/accounts';
import {
  type NuvionPayoutReading,
  type NuvionPayoutsArea,
  readPayoutTransfer,
} from '../areas/payouts';
import { nuvionTransferStatus } from '../nuvion-ledger-delivery';
import { NUVION_ACCOUNTS_WAIT_MS } from './accounts';
import type {
  NuvionDelivery,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

const done = (note: string): NuvionHandlerResult => ({ outcome: 'done', note });
const failed = (note: string): NuvionHandlerResult => ({
  outcome: 'failed',
  note,
});

/** The rail this file answers for: NIP, Nigeria's bank transfer. */
export const NUVION_BANK_TRANSFER_TYPE = 'bank-transfer';

/** What a person reads on a bank send that did not complete. No provider name. */
export const BANK_SEND_FAILURE_REASON =
  'The bank did not complete this transfer.';

/**
 * The list of a sender's transfers is read from this long before the send
 * was made, so a clock that disagrees by minutes cannot hide it.
 */
export const BANK_HISTORY_MARGIN_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Finding a send again, and the advice about it (the seam's reconcileSend and
// decideRetry, for bank sends)
// ---------------------------------------------------------------------------

/** Nuvion's transfer as the seam's transaction. */
export function payoutTransaction(t: NuvionPayoutReading): ProviderTransaction {
  return {
    id: t.id,
    createdAt: t.createdAt ? t.createdAt.toISOString() : '',
    amountKobo: BigInt(t.amountKobo),
    status: t.status,
    outcome: nuvionTransferStatus(t.status),
    ourReference: t.uniqueReference,
    // Nuvion keeps no other reference: it finds a send by the one we gave.
    providerReference: t.uniqueReference,
    secondaryReference: null,
    sessionId: null,
    // The charge only when the record states it: a record that does not is
    // silent about the fee, not a charge of 0.
    feeKobo: t.feeStated ? BigInt(t.feeKobo) : null,
  };
}

/**
 * What Nuvion knows about one of our bank sends whose answer was lost.
 * Nuvion has no lookup by `unique_reference`, so the sender's transfers are
 * walked, newest first, until the reference shows (`found`), or until a row
 * older than the send (`since`, less a margin) or the end of the list shows
 * it does not (`absent`), or the page cap stops the walk (`unknown`,
 * `history_incomplete`). Silence is never proof: a walk that stopped early,
 * a list that could not be read and a send made a moment ago are each
 * `unknown`, never `absent` (MONEY-17 D1).
 *
 * Never asks Nuvion to make anything, so it can never send the money twice.
 * `auth` and `not_configured` are thrown: no answer can be trusted.
 */
export async function reconcileBankSend(
  area: NuvionPayoutsArea,
  reference: string,
  holder: ProviderHolder,
  since?: Date,
  now: () => number = Date.now,
): Promise<ProviderReconciliation> {
  const scope =
    holder.kind === 'merchant'
      ? {
          entityId: null,
          accountId: area.client.settings.operationalAccountId,
        }
      : { entityId: holder.customerId, accountId: null };
  let walked: Awaited<ReturnType<NuvionPayoutsArea['findTransferByReference']>>;
  try {
    walked = await area.findTransferByReference(
      scope,
      reference,
      since ? new Date(since.getTime() - BANK_HISTORY_MARGIN_MS) : null,
    );
  } catch (e) {
    if (!(e instanceof WalletProviderError)) throw e;
    if (e.kind === 'auth' || e.kind === 'not_configured') throw e;
    return {
      state: 'unknown',
      why: e.kind === 'validation' ? 'unrecognised' : 'unreachable',
    };
  }
  if (walked.state === 'found') {
    return {
      state: 'found',
      source: 'history',
      transaction: payoutTransaction(walked.transfer),
    };
  }
  if (walked.state === 'incomplete') {
    return { state: 'unknown', why: 'history_incomplete' };
  }
  if (
    since !== undefined &&
    now() - since.getTime() < area.client.settings.moneyTimeoutMs
  ) {
    // The request may still be on its way to Nuvion.
    return { state: 'unknown', why: 'too_soon' };
  }
  return { state: 'absent' };
}

/**
 * What may be done with a bank send whose outcome was unknown, under
 * Nuvion's rules. Pure, and advice only (nothing in src/money/ resends on
 * it today):
 * - found and completed, or completed and since reversed: `settled` (never
 *   send it again; a reversed one is read from its outcome);
 * - found and failed: the reference is used up (a repeated reference returns
 *   the failed original), so only a NEW reference sends it again;
 * - found and still pending or processing: `wait`;
 * - absent: `wait`. Lead ruling 1 (Default (lead), owner may override): a
 *   lost answer is found again by its reference and never sent again under
 *   a new one, and a request is resent only when it provably never left
 *   (`requestNotSent`, MONEY-18), which this advice cannot know. Nuvion says
 *   a repeated reference returns the original, so resending under the same
 *   reference would be safe once the sandbox shows that it does; until then
 *   an absent send waits for a person after the bound the caller keeps
 *   (`reviewAfterHours`);
 * - unknown: `wait`.
 */
export function decideBankRetry(
  _kind: ProviderSendKind,
  reconciliation: ProviderReconciliation,
  clock: { attemptedAt: Date; now: Date; resendAfterMs: number },
): ProviderRetryDecision {
  switch (reconciliation.state) {
    case 'found': {
      const t = reconciliation.transaction;
      if (t.outcome === 'completed' || t.outcome === 'reversed') {
        return { action: 'settled', transaction: t };
      }
      if (t.outcome === 'failed') {
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
      return {
        action: 'wait',
        why: age < clock.resendAfterMs ? 'too_soon' : 'empty_lookup',
      };
    }
    case 'unknown':
      return { action: 'wait', why: reconciliation.why };
  }
}

// ---------------------------------------------------------------------------
// Outcomes: outflows.completed, .failed, .cancelled, .refunded for bank sends
// ---------------------------------------------------------------------------

/**
 * Why a transfer, read back from Nuvion, is not the bank send the delivery
 * names, or null when it is. Compared field by field: another transfer,
 * account or entity, a currency other than naira, not money out by bank
 * transfer, or figures or a reference that differ from the delivery's. Its
 * status is judged by the caller.
 */
export function outflowProblem(
  fresh: NuvionPayoutReading,
  expect: { delivered: NuvionPayoutReading },
): string | null {
  const d = expect.delivered;
  if (fresh.id !== d.id) return 'Nuvion answered another transfer';
  if (fresh.accountId !== null && fresh.accountId !== d.accountId) {
    return 'Nuvion records the transfer on another account than the delivery';
  }
  if (
    fresh.entityId !== null &&
    d.entityId !== null &&
    fresh.entityId !== d.entityId
  ) {
    return 'Nuvion records the transfer for another entity than the delivery';
  }
  if (fresh.currency !== NUVION_NAIRA) {
    return `the transfer is in ${fresh.currency}, not naira`;
  }
  if (fresh.type !== null && fresh.type !== 'outflow') {
    return 'the transfer is not money out';
  }
  if (fresh.paymentType !== NUVION_BANK_TRANSFER_TYPE) {
    return 'the transfer is not a bank transfer';
  }
  if (fresh.amountKobo !== d.amountKobo || fresh.feeKobo !== d.feeKobo) {
    return `Nuvion's record says ${fresh.amountKobo} kobo (fee ${fresh.feeKobo}), the delivery ${d.amountKobo} (fee ${d.feeKobo})`;
  }
  if (
    fresh.uniqueReference !== null &&
    d.uniqueReference !== null &&
    fresh.uniqueReference !== d.uniqueReference
  ) {
    return "Nuvion's record carries another reference than the delivery";
  }
  return null;
}

/** The wallet a bank send leaves, and the entity to ask Nuvion with. */
type Side =
  | { kind: 'ok'; entityId: string | null; wallet: LedgerWallet }
  | { kind: 'result'; result: NuvionHandlerResult };

/**
 * Bank sends reach the ledger here, once (task NUV-06, R-42): Nuvion's
 * `outflows.completed`, `.failed`, `.cancelled` and `.refunded` for a
 * transfer whose `payment_type` is `bank-transfer`.
 *
 * Nothing is recorded on a delivery's word alone: the transfer is read back
 * from Nuvion (`GET /transfers/{id}`, as Nuvion's guide says) and must be
 * the very send the delivery names, from a naira account we know (a
 * person's wallet, or WAWU's operational account), with the same amount and
 * fee. Then the ledger takes Nuvion's RECORD, not the event's name:
 * `successful` is `completed`, `failed` (which a cancelled send also is)
 * is `failed`, `reversed` is `reversed`, and a send still `pending` or
 * `processing` waits. The row is keyed on Nuvion's transfer id and our
 * `unique_reference`, so a replay, a second delivery (even at the same
 * moment), a different event for the same send and NUV-08's sweep all land
 * on one row, and its status only moves forward (a completed row never
 * becomes failed, and a reversed one stays reversed): the ledger changes
 * once per fact.
 *
 * `outflows.refunded` is a credit record of the money coming back
 * (`type: inflow`, the original named in `meta.source_payment_id`): the
 * original is read back, must itself be `reversed` and be given back in
 * full, and its row becomes `reversed`. A partial refund, a credit that
 * names no send, or an original Nuvion still shows as completed is a stop,
 * kept `failed` for review, never applied. A refund of a card payment is not
 * a bank send's and is left alone.
 *
 * Not this file's: a book transfer between Nuvion accounts (NUV-05), an
 * account in another currency (NUV-09), money in (NUV-04). The balance never
 * comes from these rows: it is Nuvion's `available` (MONEY-11, NUV-04).
 */
export class NuvionBankOutflowRecorder {
  private readonly logger = new Logger('NuvionBankOutflows');

  constructor(
    private readonly prisma: PrismaService,
    private readonly area: NuvionPayoutsArea,
    private readonly ledger: LedgerService,
    private readonly settings: { operationalAccountId: string },
  ) {}

  async onOutflow(d: NuvionDelivery): Promise<NuvionHandlerResult> {
    const read = readPayoutTransfer(d.data);
    if (!read.ok) return failed(`${read.why}; nothing recorded`);
    const delivered = read.transfer;
    if (d.event === 'outflows.refunded') return this.onRefund(d, delivered);
    return this.onSend(d, delivered);
  }

  // -- completed, failed, cancelled ------------------------------------------

  private async onSend(
    d: NuvionDelivery,
    delivered: NuvionPayoutReading,
  ): Promise<NuvionHandlerResult> {
    if (delivered.type !== null && delivered.type !== 'outflow') {
      return done('not money out; nothing recorded');
    }
    if (delivered.paymentType === null) {
      return failed(
        'the outflow names no payment type; nothing recorded (review)',
      );
    }
    if (delivered.paymentType !== NUVION_BANK_TRANSFER_TYPE) {
      return done(
        `a ${delivered.paymentType} transfer: not a bank send (NUV-05 records book transfers)`,
      );
    }
    if (delivered.currency !== NUVION_NAIRA) {
      return done(`a ${delivered.currency} send: not the naira wallet`);
    }
    const side = await this.sideOf(d, delivered);
    if (side.kind === 'result') return side.result;

    let fresh: NuvionPayoutReading;
    try {
      fresh = await this.area.getTransfer(side.entityId, delivered.id);
    } catch (e) {
      if (e instanceof WalletProviderError) {
        return this.waitOrFail(
          d,
          `Nuvion could not read the transfer back (${e.kind})`,
        );
      }
      throw e;
    }
    const problem = outflowProblem(fresh, { delivered });
    if (problem) {
      this.logger.error(`outflows: ${problem}; nothing recorded (review)`);
      return failed(`${problem}; nothing recorded (review)`);
    }
    return this.applyRecord(d, fresh, side);
  }

  /**
   * Takes Nuvion's record of one bank send to the ledger: the same row every
   * time. For the handler, and for NUV-08, which finds a send whose delivery
   * never came and has read it back the same way. `side` is the sender's
   * wallet and the entity to ask Nuvion with (null for WAWU's own).
   */
  async applyRecord(
    d: NuvionDelivery | null,
    t: NuvionPayoutReading,
    side: { entityId: string | null; wallet: LedgerWallet },
  ): Promise<NuvionHandlerResult> {
    const status = nuvionTransferStatus(t.status);
    if (status === null) {
      return failed(
        `Nuvion's transfer status "${t.status}" is not one we know; nothing recorded (review)`,
      );
    }
    if (status === 'pending') {
      return this.waitOrFail(
        d,
        `Nuvion says the transfer is still ${t.status}`,
      );
    }
    const r = await this.recordOutflow(
      t,
      side.wallet,
      status,
      d?.id ?? null,
      await this.placeOf(side.entityId, t),
    );
    return done(
      `${r.created ? 'recorded' : 'already recorded'} once as ${status}${r.discrepancy ? `; ${r.discrepancy} (review)` : ''}`,
    );
  }

  /** One `out` row on the sender's wallet for this send; the same row every time. */
  recordOutflow(
    t: NuvionPayoutReading,
    wallet: LedgerWallet,
    status: TransferStatus,
    sourceEventId: string | null,
    place: {
      bankName: string | null;
      bankCode: string | null;
      accountNumber: string | null;
      accountName: string | null;
    } | null = null,
  ): Promise<LedgerRecordResult> {
    return this.ledger.record({
      wallet,
      direction: 'out',
      status,
      category: 'transfer',
      amountKobo: t.amountKobo,
      feeKobo: t.feeKobo,
      totalKobo: t.amountKobo + t.feeKobo,
      // What Nuvion took is its own record; the feature that sent the money
      // quoted its fee (with WAWU's on top, R-10) and keeps its figures. A
      // different amount is still a disagreement.
      figuresStand: true,
      providerFeeKobo: t.feeStated ? t.feeKobo : null,
      counterparty: {
        kind: 'bank_account',
        name: place?.accountName ?? null,
        accountNumber: place?.accountNumber ?? null,
        bankCode: place?.bankCode ?? null,
        bankName: place?.bankName ?? null,
      },
      narration: t.narration,
      references: {
        customerReference: t.uniqueReference,
        fintavaTransactionId: t.id,
      },
      failureReason: status === 'failed' ? BANK_SEND_FAILURE_REASON : null,
      source: 'webhook',
      sourceEventId,
      occurredAt: t.createdAt,
    });
  }

  // -- refunded --------------------------------------------------------------

  private async onRefund(
    d: NuvionDelivery,
    credit: NuvionPayoutReading,
  ): Promise<NuvionHandlerResult> {
    if (credit.paymentType?.startsWith('card') === true) {
      return done('a card refund: not a bank send');
    }
    if (credit.currency !== NUVION_NAIRA) {
      return done(`a ${credit.currency} refund: not the naira wallet`);
    }
    if (credit.sourcePaymentId === null) {
      return failed(
        'a refund that names no send it reverses; nothing applied (review)',
      );
    }
    const side = await this.sideOf(d, credit);
    if (side.kind === 'result') return side.result;

    let original: NuvionPayoutReading;
    try {
      original = await this.area.getTransfer(
        side.entityId,
        credit.sourcePaymentId,
      );
    } catch (e) {
      if (e instanceof WalletProviderError) {
        return this.waitOrFail(
          d,
          `Nuvion could not read the reversed send back (${e.kind})`,
        );
      }
      throw e;
    }
    if (
      original.paymentType !== NUVION_BANK_TRANSFER_TYPE ||
      (original.type !== null && original.type !== 'outflow')
    ) {
      return done('the refund is not of a bank send');
    }
    if (original.accountId !== credit.accountId) {
      return failed(
        "the refund credits another account than the send's; nothing applied (review)",
      );
    }
    if (original.currency !== NUVION_NAIRA) {
      return done(`a ${original.currency} send: not the naira wallet`);
    }
    if (original.amountKobo !== credit.amountKobo) {
      this.logger.error(
        'outflows: a refund of another amount than the send; nothing applied (review)',
      );
      return failed(
        `the refund gives back ${credit.amountKobo} kobo of a ${original.amountKobo} kobo send; a partial refund is not applied (review)`,
      );
    }
    const status = nuvionTransferStatus(original.status);
    if (status === 'pending') {
      return this.waitOrFail(
        d,
        `Nuvion says the reversed send is still ${original.status}`,
      );
    }
    if (status !== 'reversed') {
      this.logger.error(
        'outflows: a refund for a send Nuvion does not show as reversed; nothing applied (review)',
      );
      return failed(
        `Nuvion records the send as ${original.status}, not reversed, although a refund names it; nothing applied (review)`,
      );
    }
    return this.applyRecord(d, original, side);
  }

  /**
   * Where the send went, for the other side of the ledger row: the payment
   * detail it names. Best effort: a row that names no bank is still a row.
   */
  private async placeOf(entityId: string | null, t: NuvionPayoutReading) {
    if (t.paymentDetailId === null) return null;
    try {
      return await this.area.getPaymentDetail(entityId, t.paymentDetailId);
    } catch (e) {
      if (e instanceof WalletProviderError) return null;
      throw e;
    }
  }

  // -- whose send ------------------------------------------------------------

  /** The wallet a delivery's account is, or why it cannot be recorded yet. */
  private async sideOf(
    d: NuvionDelivery,
    t: NuvionPayoutReading,
  ): Promise<Side> {
    const accountId = t.accountId;
    if (!isNuvionId(accountId)) {
      return {
        kind: 'result',
        result: failed('the transfer names no account; nothing recorded'),
      };
    }
    if (accountId === this.settings.operationalAccountId) {
      // WAWU's own money (a payout, R-31): the ledger names this side by the
      // account's `nuvion_ban`, which is how NUV-05 names it too.
      try {
        const ban = await this.area.operationalBan();
        return {
          kind: 'ok',
          entityId: null,
          wallet: { kind: 'merchant', accountNumber: ban },
        };
      } catch (e) {
        if (e instanceof WalletProviderError) {
          return {
            kind: 'result',
            result: this.waitOrFail(
              d,
              `WAWU's operational account could not be read (${e.kind})`,
            ),
          };
        }
        throw e;
      }
    }
    const entityId = t.entityId ?? d.entityId;
    if (!isNuvionId(entityId)) {
      return {
        kind: 'result',
        result: failed('the transfer names no entity; nothing recorded'),
      };
    }
    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: { wawuUserId: true, accountId: true },
    });
    if (!entity) {
      return {
        kind: 'result',
        result: this.waitOrFail(d, 'no person holds this entity yet'),
      };
    }
    if (entity.accountId === null) {
      return {
        kind: 'result',
        result: this.waitOrFail(
          d,
          "the person's naira account is not recorded yet",
        ),
      };
    }
    if (entity.accountId !== accountId) {
      return {
        kind: 'result',
        result: failed(
          "naira from an account that is not the person's naira account; nothing recorded (review)",
        ),
      };
    }
    const wallet = await this.prisma.fintavaWallet.findFirst({
      where: {
        wawuUserId: entity.wawuUserId,
        walletId: nuvionWalletId(entityId, accountId),
        provider: 'nuvion',
      },
      select: { wawuUserId: true, accountNumber: true },
    });
    if (!wallet) {
      return {
        kind: 'result',
        result: this.waitOrFail(
          d,
          "the person's account number is not recorded yet",
        ),
      };
    }
    return {
      kind: 'ok',
      entityId,
      wallet: {
        kind: 'user',
        wawuUserId: wallet.wawuUserId,
        accountNumber: wallet.accountNumber,
      },
    };
  }

  /** `wait`, or `failed` for review once the delivery has waited too long. */
  private waitOrFail(
    d: NuvionDelivery | null,
    note: string,
  ): NuvionHandlerResult {
    if (d && Date.now() - d.receivedAt.getTime() > NUVION_ACCOUNTS_WAIT_MS) {
      return failed(`${note}; waited past the limit, kept for review`);
    }
    return { outcome: 'wait', note };
  }
}
