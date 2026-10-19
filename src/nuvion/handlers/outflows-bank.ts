import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type {
  LedgerRecordResult,
  LedgerWallet,
} from '../../money/ledger/ledger.interface';
import {
  LEDGER_BANK_SEND_FAILURE,
  type LedgerService,
} from '../../money/ledger/ledger.service';
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

/**
 * What a person reads on a bank send that did not complete. No provider name.
 * The ledger owns the text: the send settles on it (FIX-54).
 */
export const BANK_SEND_FAILURE_REASON = LEDGER_BANK_SEND_FAILURE;

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
    const t = walked.transfer;
    // Only a bank send of ours counts as found: a record that carries the
    // reference but is another rail's (a book transfer, a card), money in, or
    // another currency says nothing about this send, so it does not answer
    // as one. It does not prove that no money moved either: `unknown`.
    if (
      t.paymentType !== NUVION_BANK_TRANSFER_TYPE ||
      t.type !== 'outflow' ||
      t.currency !== NUVION_NAIRA
    ) {
      return { state: 'unknown', why: 'unrecognised' };
    }
    return {
      state: 'found',
      source: 'history',
      transaction: payoutTransaction(t),
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
  // The amount always; the charge when both state one. A delivery that
  // carries no charge is no disagreement with a record that states it (the
  // record is what is recorded); a record that states none is judged by the
  // caller (nothing is written from it).
  if (
    fresh.amountKobo !== d.amountKobo ||
    (fresh.feeStated && d.feeStated && fresh.feeKobo !== d.feeKobo)
  ) {
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
        `the transfer is by ${delivered.paymentType}, not a bank send (NUV-05 records book transfers)`,
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
    /** What Nuvion's credit record says came back, for a send it reversed (FIX-54). */
    reversal: {
      at: Date | null;
      reference: string;
      returnedKobo: number;
    } | null = null,
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
    if (status !== 'failed' && !t.feeStated) {
      // The money moved (or moved and came back) and Nuvion's record does not
      // say what it charged. A charge is never taken as 0, and the quote is
      // not confirmed by silence: nothing is written, the row stays as the
      // sending feature left it, and a later read that states the charge
      // records it.
      return this.waitOrFail(
        d,
        `Nuvion's record of the ${t.status} transfer states no fee; nothing recorded until it does`,
      );
    }
    const r = await this.recordOutflow(
      t,
      side.wallet,
      status,
      d?.id ?? null,
      await this.placeOf(side.entityId, t),
    );
    if (status === 'reversed' && reversal !== null) {
      // The row says what Nuvion gave back, once; a replay writes nothing.
      await this.ledger.noteReversalFigures(r.entryId, {
        at: reversal.at ?? new Date(),
        reference: reversal.reference,
        amountKobo: reversal.returnedKobo,
        chargesKobo: 0,
        totalKobo: reversal.returnedKobo,
      });
    }
    return done(
      `${r.created ? 'recorded' : 'already recorded'} once as ${status}${r.discrepancy ? `; ${r.discrepancy} (review)` : ''}`,
    );
  }

  /**
   * One `out` row on the sender's wallet for this send; the same row every
   * time. A completed or reversed send is recorded only from a record that
   * states Nuvion's charge (a charge is never taken as 0): called with one
   * that does not, it throws and writes nothing. Nuvion's charge, once
   * stated, is what the row says as its provider charge; when the row held
   * another one (the quote), Nuvion's is recorded and the difference is
   * written on the row's `discrepancy` with both figures (the quote never
   * overwrites what Nuvion says; the row's own fee and total stand as the
   * sending feature wrote them).
   */
  async recordOutflow(
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
    const charged = status !== 'failed';
    if (charged && !t.feeStated) {
      throw new Error(
        'a send whose record states no fee is not recorded as done',
      );
    }
    const r = await this.ledger.record({
      wallet,
      direction: 'out',
      status,
      category: 'transfer',
      amountKobo: t.amountKobo,
      feeKobo: t.feeKobo,
      totalKobo: t.amountKobo + t.feeKobo,
      // The feature that sent the money quoted its fee (with WAWU's on top,
      // R-10) and keeps its figures; Nuvion's charge is taken below. A
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
    if (!charged) return r;
    const note = await this.takeProviderCharge(r.entryId, t.feeKobo);
    return note === null
      ? r
      : {
          ...r,
          discrepancy: r.discrepancy ? `${r.discrepancy}; ${note}` : note,
        };
  }

  /**
   * Nuvion's stated charge is the row's provider charge. A row that held
   * another one (the quote, written before the answer) takes Nuvion's, and
   * the difference is written on its `discrepancy` with both figures, in the
   * same transaction, so a crash between the two leaves neither. A row that
   * holds none, or the same, is left as it is. Returns the note written, or
   * null when there was nothing to write.
   */
  private takeProviderCharge(
    entryId: string,
    stated: number,
  ): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ providerFeeKobo: bigint | null }>
      >`
        SELECT "providerFeeKobo" FROM "FintavaLedgerEntry"
         WHERE "id" = ${entryId} FOR UPDATE`;
      const quoted = rows[0]?.providerFeeKobo ?? null;
      if (quoted === null || quoted === BigInt(stated)) return null;
      await tx.fintavaLedgerEntry.update({
        where: { id: entryId },
        data: { providerFeeKobo: BigInt(stated) },
      });
      const note = `Nuvion charged ${stated} kobo, the quote was ${quoted} kobo; Nuvion's figure is recorded`;
      await this.ledger.noteDiscrepancy(entryId, note, tx);
      return note;
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
      if (
        credit.paymentType !== null &&
        credit.paymentType !== NUVION_BANK_TRANSFER_TYPE
      ) {
        // Another rail's refund that names no send (a book transfer's credit
        // is NUV-05's): not a bank send's, so not a stop here.
        return done(
          `a ${credit.paymentType} refund that names no send: not a bank send's`,
        );
      }
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
    // A reversal is in full when it gives back the amount, or the amount with
    // the charge Nuvion took (the credit record states what was returned and
    // the docs do not say whether the charge goes back): anything else is a
    // partial refund, which is not applied.
    const wholeSend = original.feeStated
      ? original.amountKobo + original.feeKobo
      : original.amountKobo;
    if (
      credit.amountKobo !== original.amountKobo &&
      credit.amountKobo !== wholeSend
    ) {
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
    if (status === 'completed') {
      // Nuvion's record of the send has not caught up with the credit (a
      // plausible race): the same delivery is tried again, as NUV-05 does,
      // and kept for review only after the wait limit.
      return this.waitOrFail(
        d,
        `Nuvion still shows the send as ${original.status} although a refund names it`,
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
    return this.applyRecord(d, original, side, {
      at: credit.createdAt,
      reference: credit.id,
      returnedKobo: credit.amountKobo,
    });
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
