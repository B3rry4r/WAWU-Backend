import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Prisma,
  type SchoolSettlement,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FeeQuoteService } from '../../money/fees/fee-quote.service';
import { HoldRequestError } from '../../money/holds/hold-rules';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import type { LedgerMovementInput } from '../../money/ledger/ledger.interface';
import {
  koboNumber,
  LEDGER_ABSENT_FAILURE,
  LedgerService,
} from '../../money/ledger/ledger.service';
import { PaymentSettings } from '../../money/payments/payment-config';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  type ProviderReconciliation,
  type ProviderTransaction,
  type ProviderTransferReceipt,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { WalletProviderLimitError } from '../../wallet-provider/wallet-provider-limit';
import { describeDatabaseFailure } from '../enrolment/school-enrolment-failure';
import {
  decodeListCursor,
  encodeListCursor,
} from '../enrolment/school-enrolment-list';
import {
  lagosToday,
  SCHOOL_FEE_KIND,
} from '../enrolment/school-enrolment-rules';
import type { ListSettlementsDto } from './school-settlement.dto';
import {
  MAX_ATTEMPT,
  PAYOUT_FAILED_REASON,
  PAYOUT_NARRATION,
  payoutReference,
  restMs,
  SETTLEMENT_MESSAGES,
  type SettlementAction,
  type SettlementWaiting,
  sharesAddUp,
} from './school-settlement-rules';
import type {
  CancelIntakeView,
  SchoolSettlementPage,
  SchoolSettlementView,
} from './school-settlement-view.type';

/** Settlements one pass starts, and drives. */
const START_BATCH = 100;
const DRIVE_BATCH = 100;
const REFUND_REASON = 'The class was cancelled.';
/** Settlements one dashboard page gives when no limit is asked for. */
const LIST_DEFAULT_LIMIT = 20;

type Tx = Prisma.TransactionClient;

/** The bank account a school is paid at, as the ledger records it. */
interface PayoutPlace {
  bankCode: string | null;
  bankName: string | null;
  accountNumber: string | null;
  accountName: string | null;
}

/** A decision that cannot be made: the other way was already chosen. */
class Refused extends ConflictException {}

/**
 * Pay schools their share of course fees (task SCHOOLS-11, R-12, R-10, R-31).
 *
 * The fee a student paid waits in WAWU's merchant wallet in a hold (R-19,
 * SCHOOLS-07). When the class starts, the school's 85% is sent to its bank
 * account from that wallet; when the class is called off, the whole fee goes
 * back to the student's wallet. The provider's charge on either move is WAWU's,
 * paid from its 15% (R-31), so the school gets its full 85% and the student the
 * full fee (the charge on the original payment is not returned, R-10).
 *
 * - **One decision.** `SchoolSettlement.enrolmentId` is unique and every
 *   decision runs under a lock on the enrolment, so an enrolment is paid out
 *   or refunded, never both. A payout still waiting (nothing handed to the
 *   provider) can be turned into a refund when the class is called off; a
 *   payout handed over cannot, and an admin who asks is told so.
 * - **A payout is one bank send** from WAWU's account through the wallet
 *   provider seam (`provider.bankTransfer` from `{ kind: 'merchant' }`), under
 *   the reference `wawu-bank-sch-<id>`. It is handed over by a lease (the
 *   conditional update that sets `sentAt`) only one caller wins, so two
 *   servers, two sweeps or a double click send it once; the provider answers a
 *   repeated reference with the original anyway. Nothing is held across the
 *   provider call: decide under a short lock, call holding nothing, record.
 * - **The provider's record is the truth.** A send is `paid` only when the
 *   provider says it completed. A lost answer, a pending send or a repeated
 *   reference is asked about (`reconcileSend`), backing off, and is never sent
 *   again; past PAYMENT_REVIEW_AFTER_HOURS it goes to a person. Only the
 *   provider's own record that the send FAILED starts one more try under a new
 *   reference (`-2`); a second failure goes to a person. So a failed payout is
 *   retried once and never doubles.
 * - **Waiting is not failing.** A school with no confirmed bank account, the
 *   provider out of reach, WAWU's account short of money: the hold stays
 *   `held`, the money stays in WAWU's account and the sweep tries again.
 * - **The hold closes last.** Once the send is confirmed the ledger gets the
 *   movement and the hold is released (it has no WAWU payee, so nothing moves:
 *   WAWU's 15% stays where it is), so the held total the nightly check reads
 *   stays true until the school really has its money.
 */
@Injectable()
export class SchoolSettlementService {
  private readonly logger = new Logger(SchoolSettlementService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly holds: WalletHoldService,
    private readonly ledger: LedgerService,
    private readonly fees: FeeQuoteService,
    private readonly settings: PaymentSettings,
  ) {}

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_MINUTE, { name: 'school-settlement' })
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.run();
    } catch (e) {
      this.logger.error(
        `school settlement sweep failed (${describeDatabaseFailure(e)})`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * One pass: decide the fees that are due (classes that have started, classes
   * that were called off), then move every settlement that is due a step.
   * Safe to run on any number of servers at once.
   */
  async run(
    now: Date = new Date(),
  ): Promise<{ started: number; driven: number }> {
    const out = { started: 0, driven: 0 };
    const today = lagosToday(now);
    const provider = this.provider.name;

    const payable = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "SchoolEnrolment" e
        JOIN "CourseIntake" i ON i."id" = e."intakeId"
        JOIN "WalletHold" h ON h."id" = e."holdId"
       WHERE e."status" = 'enrolled' AND h."provider" = ${provider}
         AND i."cancelledAt" IS NULL AND i."startDate" <= ${today}::date
         AND NOT EXISTS (SELECT 1 FROM "SchoolSettlement" s WHERE s."enrolmentId" = e."id")
       ORDER BY i."startDate", e."id" LIMIT ${START_BATCH}`;
    for (const { id } of payable) {
      try {
        await this.decide(id, 'payout', now);
        out.started += 1;
      } catch (e) {
        this.logger.error(
          `school settlement ${id}: could not decide the payout (${describeDatabaseFailure(e)})`,
        );
      }
    }

    // Fees paid for a class that was called off after the cancel ran (a
    // payment in flight at the time): they go back.
    const called = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "SchoolEnrolment" e
        JOIN "CourseIntake" i ON i."id" = e."intakeId"
        JOIN "WalletHold" h ON h."id" = e."holdId"
       WHERE e."status" = 'enrolled' AND h."provider" = ${provider}
         AND i."cancelledAt" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "SchoolSettlement" s WHERE s."enrolmentId" = e."id")
       ORDER BY e."id" LIMIT ${START_BATCH}`;
    for (const { id } of called) {
      try {
        await this.decide(id, 'refund', now);
        out.started += 1;
      } catch (e) {
        this.logger.error(
          `school settlement ${id}: could not decide the refund (${describeDatabaseFailure(e)})`,
        );
      }
    }

    const due = await this.prisma.schoolSettlement.findMany({
      where: {
        provider,
        status: { in: ['pending', 'sent'] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
      take: DRIVE_BATCH,
      select: { id: true },
    });
    for (const { id } of due) {
      try {
        await this.drive(id, now);
        out.driven += 1;
      } catch (e) {
        this.logger.error(
          `school settlement ${id}: the sweep could not drive it (${describeDatabaseFailure(e)})`,
        );
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // What the dashboard asks for
  // -------------------------------------------------------------------------

  /**
   * A class is called off: it takes no more enrolments, unpaid places go back,
   * and every paid enrolment's fee goes back to the student's wallet. A fee
   * that has already been paid to the school is not refunded from here (it is
   * counted, for a person to settle with the school). Safe to ask again.
   */
  async cancelIntake(
    intakeId: string,
    now: Date = new Date(),
  ): Promise<CancelIntakeView> {
    const intake = await this.prisma.courseIntake.findUnique({
      where: { id: intakeId },
      select: { id: true, cancelledAt: true, hiddenAt: true },
    });
    if (!intake) throw new NotFoundException(SETTLEMENT_MESSAGES.noSuchIntake);
    // Cancelled and hidden in one write: nothing that lists or takes
    // enrolments for a class reads `cancelledAt`, they all read `hiddenAt`.
    await this.prisma.courseIntake.updateMany({
      where: { id: intakeId, cancelledAt: null },
      data: { cancelledAt: now, ...(intake.hiddenAt ? {} : { hiddenAt: now }) },
    });
    const cancelledAt =
      intake.cancelledAt ??
      (
        await this.prisma.courseIntake.findUniqueOrThrow({
          where: { id: intakeId },
          select: { cancelledAt: true },
        })
      ).cancelledAt!;

    // Places nobody has paid for (and no payment is under way) go back.
    const released = await this.prisma.$executeRaw`
      UPDATE "SchoolEnrolment" e
         SET "status" = 'released', "releasedAt" = ${now}, "updatedAt" = ${now}
       WHERE e."intakeId" = ${intakeId} AND e."status" = 'reserved'
         AND NOT EXISTS (
           SELECT 1 FROM "WalletPayment" p
            WHERE p."kind" = ${SCHOOL_FEE_KIND} AND p."targetId" = e."id"
              AND p."status" IN ('pending', 'completed'))`;

    const paid = await this.prisma.schoolEnrolment.findMany({
      where: { intakeId, status: 'enrolled', holdId: { not: null } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const { id } of paid) {
      try {
        const row = await this.decide(id, 'refund', now);
        await this.drive(row.id, now);
      } catch (e) {
        // A fee already on its way to the school stays with the school; it is
        // counted below, for a person to settle.
        if (!(e instanceof Refused)) throw e;
      }
    }
    const settled = await this.prisma.schoolSettlement.findMany({
      where: { enrolment: { intakeId } },
      select: { action: true },
    });
    const alreadyPaidOut = settled.filter((s) => s.action === 'payout').length;
    const refunding = settled.filter((s) => s.action === 'refund').length;
    return {
      intakeId,
      cancelledAt: cancelledAt.toISOString(),
      refunding,
      alreadyPaidOut,
      placesReleased: Number(released),
    };
  }

  /**
   * Sends one enrolment's fee back to the student (a finance refund). Refused
   * with a 409 once the fee has been handed to the school's bank: the school's
   * 85% has left WAWU's account and cannot be taken back from here.
   */
  async refundEnrolment(
    enrolmentId: string,
    now: Date = new Date(),
  ): Promise<SchoolSettlementView> {
    const row = await this.decide(enrolmentId, 'refund', now);
    await this.drive(row.id, now);
    return this.view(row.id);
  }

  /** Settlements newest first, a cursor page (CONVENTIONS section 6). */
  async list(query: ListSettlementsDto): Promise<SchoolSettlementPage> {
    const limit = query.limit ?? LIST_DEFAULT_LIMIT;
    const after = query.cursor ? decodeListCursor(query.cursor) : null;
    const rows = await this.prisma.schoolSettlement.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.schoolId ? { schoolId: query.schoolId } : {}),
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        enrolment: {
          select: { reference: true, courseTitle: true, schoolName: true },
        },
      },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => this.viewOf(r)),
      nextCursor:
        rows.length > limit ? encodeListCursor(page[page.length - 1]) : null,
    };
  }

  async view(id: string): Promise<SchoolSettlementView> {
    const row = await this.prisma.schoolSettlement.findUniqueOrThrow({
      where: { id },
      include: {
        enrolment: {
          select: { reference: true, courseTitle: true, schoolName: true },
        },
      },
    });
    return this.viewOf(row);
  }

  private viewOf(
    r: SchoolSettlement & {
      enrolment: { reference: string; courseTitle: string; schoolName: string };
    },
  ): SchoolSettlementView {
    return {
      id: r.id,
      enrolmentId: r.enrolmentId,
      reference: r.enrolment.reference,
      schoolId: r.schoolId,
      schoolName: r.enrolment.schoolName,
      courseTitle: r.enrolment.courseTitle,
      action: r.action as SettlementAction,
      status: r.status as SchoolSettlementView['status'],
      priceKobo: r.priceKobo,
      schoolShareKobo: r.schoolShareKobo,
      wawuShareKobo: r.wawuShareKobo,
      providerFeeKobo:
        r.providerFeeKobo === null ? null : koboNumber(r.providerFeeKobo),
      waiting: r.waiting as SettlementWaiting | null,
      reviewNote: r.reviewNote,
      decidedAt: r.decidedAt.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null,
      refundedAt: r.refundedAt?.toISOString() ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // The decision
  // -------------------------------------------------------------------------

  /**
   * Makes the one decision about a paid enrolment's fee, or answers the one
   * already made. Under a lock on the enrolment, in a short database-only
   * transaction. A refund also marks the enrolment `refunded` (the student sees
   * it at once; the hold says when the money is back) and gives the seat back.
   */
  private async decide(
    enrolmentId: string,
    action: SettlementAction,
    now: Date,
  ): Promise<SchoolSettlement> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS "locked" FROM "SchoolEnrolment" WHERE "id" = ${enrolmentId} FOR UPDATE`;
      const e = await tx.schoolEnrolment.findUnique({
        where: { id: enrolmentId },
      });
      if (!e) throw new NotFoundException(SETTLEMENT_MESSAGES.noSuchEnrolment);
      const existing = await tx.schoolSettlement.findUnique({
        where: { enrolmentId },
      });
      if (existing) {
        if (existing.action === action) return existing;
        if (existing.action === 'refund') {
          throw new Refused(SETTLEMENT_MESSAGES.alreadyRefunding);
        }
        // A payout that has not been handed to the provider can still be
        // turned into a refund; one that has cannot.
        const flipped = await tx.schoolSettlement.updateMany({
          where: {
            id: existing.id,
            action: 'payout',
            status: 'pending',
            sentAt: null,
          },
          data: {
            action: 'refund',
            customerReference: null,
            waiting: null,
            nextAttemptAt: null,
          },
        });
        if (flipped.count === 0) {
          throw new Refused(
            existing.status === 'paid'
              ? SETTLEMENT_MESSAGES.alreadyPaidOut
              : SETTLEMENT_MESSAGES.payoutStarted,
          );
        }
        await this.markRefunded(tx, e.id, e.intakeId, now);
        return tx.schoolSettlement.findUniqueOrThrow({
          where: { id: existing.id },
        });
      }
      if (e.status !== 'enrolled' || !e.holdId) {
        throw new ConflictException(SETTLEMENT_MESSAGES.notPaid);
      }
      const hold = await tx.walletHold.findUnique({
        where: { id: e.holdId },
        select: { id: true, provider: true },
      });
      if (!hold) throw new ConflictException(SETTLEMENT_MESSAGES.notPaid);
      if (!sharesAddUp(e)) {
        // Never settle on figures that do not add up to the fee.
        this.logger.error(
          `enrolment ${e.id}: the school's share and WAWU's do not add up to the fee; nothing is settled`,
        );
        throw new ConflictException(SETTLEMENT_MESSAGES.notPaid);
      }
      const id = randomUUID();
      const row = await tx.schoolSettlement.create({
        data: {
          id,
          enrolmentId: e.id,
          schoolId: e.schoolId,
          holdId: hold.id,
          provider: hold.provider,
          action,
          priceKobo: e.priceKobo,
          schoolShareKobo: e.schoolShareKobo,
          wawuShareKobo: e.wawuShareKobo,
          customerReference:
            action === 'payout' ? payoutReference(id, 1) : null,
        },
      });
      if (action === 'refund') {
        await this.markRefunded(tx, e.id, e.intakeId, now);
      }
      return row;
    });
  }

  /** The student's enrolment is refunded and its seat goes back. */
  private async markRefunded(
    tx: Tx,
    enrolmentId: string,
    intakeId: string,
    now: Date,
  ): Promise<void> {
    const { count } = await tx.schoolEnrolment.updateMany({
      where: { id: enrolmentId, status: 'enrolled' },
      data: {
        status: 'refunded',
        refundedAt: now,
        failureReason: REFUND_REASON,
      },
    });
    if (count === 1) {
      await tx.$executeRaw`
        UPDATE "CourseIntake" SET "seatsTaken" = "seatsTaken" - 1
         WHERE "id" = ${intakeId} AND "seatsTaken" >= 1`;
    }
  }

  // -------------------------------------------------------------------------
  // Moving a settlement one step
  // -------------------------------------------------------------------------

  async drive(id: string, now: Date = new Date()): Promise<void> {
    const row = await this.prisma.schoolSettlement.findUniqueOrThrow({
      where: { id },
    });
    if (row.status === 'paid' || row.status === 'refunded') return;
    if (row.status === 'review') return;
    if (!isRowOf(this.provider.name, row.provider)) return;
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) {
      return;
    }
    if (row.action === 'refund') {
      await this.driveRefund(row, now);
      return;
    }
    if (row.sentAt) await this.reconcile(row, now);
    else await this.send(row, now);
  }

  // ---- Refunds ------------------------------------------------------------

  private async driveRefund(row: SchoolSettlement, now: Date): Promise<void> {
    let state: Awaited<ReturnType<WalletHoldService['refund']>>['state'];
    try {
      state = (await this.holds.refund({ holdId: row.holdId }, REFUND_REASON))
        .state;
    } catch (e) {
      if (e instanceof HoldRequestError) {
        await this.toReview(row, `the hold cannot be refunded: ${e.message}`);
        return;
      }
      throw e;
    }
    if (state === 'settled') {
      await this.prisma.schoolSettlement.updateMany({
        where: { id: row.id, action: 'refund', status: 'pending' },
        data: {
          status: 'refunded',
          refundedAt: now,
          waiting: null,
          nextAttemptAt: null,
        },
      });
    } else if (state === 'review') {
      await this.toReview(
        row,
        "the refund is under review in the student's hold",
      );
    } else {
      // The hold's own sweep finishes the move; looked at again in a minute.
      await this.prisma.schoolSettlement.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { nextAttemptAt: new Date(now.getTime() + 60_000) },
      });
    }
  }

  // ---- Payouts ------------------------------------------------------------

  private async send(row: SchoolSettlement, now: Date): Promise<void> {
    const payee = await this.prisma.schoolPayee.findUnique({
      where: { schoolId: row.schoolId },
    });
    if (!payee) {
      await this.waitFor(row, 'no_payee', now, 0);
      return;
    }
    const amount = BigInt(row.schoolShareKobo);
    if (amount <= 0n) {
      // The school's share rounds to nothing: there is nothing to send, and
      // the whole fee is WAWU's. The hold is closed.
      await this.settlePayout(row, payee, null, null, now);
      return;
    }
    const cap = this.fees.providerFees.merchantMaxPerTxnKobo;
    if (cap !== null && amount > BigInt(cap)) {
      await this.toReview(
        row,
        `the payout of ${amount} kobo is above the cap of ${cap} kobo on one move through WAWU's account`,
      );
      return;
    }
    const reference =
      row.customerReference ?? payoutReference(row.id, row.attempt);

    // The lease: only the caller that wins it hands the send to the provider.
    // The ledger's `out` row is written `pending` in the same transaction, the
    // way a person's bank send is, so WAWU's account and the ledger agree from
    // the moment the money can leave it until the provider says what became of it.
    const leaseUntil = new Date(
      now.getTime() +
        this.provider.timings.moneyTimeoutMs +
        this.provider.timings.resendSafetyMs,
    );
    const leased = await this.prisma.$transaction(async (tx) => {
      const taken = await tx.schoolSettlement.updateMany({
        where: {
          id: row.id,
          action: 'payout',
          status: 'pending',
          sentAt: null,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        data: {
          status: 'sent',
          sentAt: now,
          nextAttemptAt: leaseUntil,
          attempts: { increment: 1 },
          waiting: null,
          customerReference: reference,
          bankCode: payee.bankCode,
          bankName: payee.bankName,
          bankAccountNumber: payee.accountNumber,
          bankAccountName: payee.accountName,
          counterpartyId: payee.counterpartyId,
          paymentDetailId: payee.paymentDetailId,
        },
      });
      if (taken.count === 0) return false;
      await this.ledger.record(
        await this.payoutMovement(tx, row, reference, payee, {
          status: 'pending',
          fee: this.quotedFee(amount),
          transactionId: null,
          figuresStand: true,
        }),
        tx,
      );
      return true;
    });
    if (!leased) return;

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.bankTransfer({
        from: { kind: 'merchant' },
        accountNumber: payee.accountNumber,
        accountName: payee.accountName,
        bankCode: payee.bankCode,
        amountKobo: amount,
        reference,
        narration: PAYOUT_NARRATION,
        payee: {
          counterpartyId: payee.counterpartyId,
          paymentDetailId: payee.paymentDetailId,
        },
      });
    } catch (e) {
      await this.afterRefusal(row, e, now, reference, payee);
      return;
    }
    if (receipt.amountKobo !== amount) {
      await this.toReview(
        row,
        `the provider took ${receipt.amountKobo} kobo for a payout of ${amount} kobo`,
      );
      return;
    }
    await this.prisma.schoolSettlement.updateMany({
      where: { id: row.id, status: 'sent' },
      data: {
        providerFeeKobo: receipt.feeKobo,
        providerTransactionId: receipt.transactionId,
        nextAttemptAt: null,
      },
    });
    // The row says what the provider took, not what was quoted.
    await this.restateCharge(row, reference, receipt.feeKobo);
    if (
      receipt.payee &&
      (receipt.payee.counterpartyId || receipt.payee.paymentDetailId)
    ) {
      // So the next payout to this account reuses them. Never fails the payout.
      await this.prisma.schoolPayee
        .updateMany({
          where: {
            schoolId: row.schoolId,
            accountNumber: payee.accountNumber,
            bankCode: payee.bankCode,
          },
          data: {
            counterpartyId: receipt.payee.counterpartyId,
            paymentDetailId: receipt.payee.paymentDetailId,
          },
        })
        .catch(() => undefined);
    }
    // Accepted: ask once at once whether it has completed; the sweep asks again.
    await this.reconcile(
      await this.prisma.schoolSettlement.findUniqueOrThrow({
        where: { id: row.id },
      }),
      now,
    );
  }

  /** The provider did not take the send, or we do not know whether it did. */
  private async afterRefusal(
    row: SchoolSettlement,
    e: unknown,
    now: Date,
    reference: string,
    payee: PayoutPlace,
  ): Promise<void> {
    const refusal = e instanceof WalletProviderError ? e : null;
    if (!refusal || (refusal.recordMayExist && !refusal.requestNotSent)) {
      // Money may have moved (a lost answer, an accepted send not finished, a
      // repeated reference): asked about, never sent again.
      this.logger.warn(
        `school settlement ${row.id}: the payout outcome is unknown (${refusal?.kind ?? 'error'}); asking ${this.provider.label} about it`,
      );
      await this.schedule(row, now, 1);
      return;
    }
    let waiting: SettlementWaiting;
    if (refusal.requestNotSent || refusal instanceof WalletProviderLimitError) {
      waiting = 'provider';
    } else if (refusal.kind === 'insufficient_funds') {
      waiting = 'funds';
    } else if (
      [
        'auth',
        'not_configured',
        'merchant_inactive',
        'rate_limited',
        'unavailable',
        'not_supported',
        'bad_response',
        'wallet_inactive',
      ].includes(refusal.kind)
    ) {
      waiting = 'provider';
    } else {
      waiting = 'refused';
    }
    if (waiting === 'funds') {
      this.logger.error(
        `school settlement ${row.id}: ${this.provider.label} says WAWU's account cannot cover the payout (${row.schoolShareKobo} kobo): held money is not where it should be`,
      );
    } else if (waiting === 'refused') {
      this.logger.error(
        `school settlement ${row.id}: ${this.provider.label} refused the payout (${refusal.kind}); nothing moved`,
      );
    }
    // Nothing moved: the lease is given back and the same reference is used
    // again, so the ledger row written at the lease is reversed (and is the
    // same row, revived, when the send is taken later).
    await this.ledgerEnd(
      row,
      reference,
      payee,
      'failed',
      LEDGER_ABSENT_FAILURE,
    );
    await this.prisma.schoolSettlement.updateMany({
      where: { id: row.id, status: 'sent' },
      data: {
        status: 'pending',
        sentAt: null,
        waiting,
        nextAttemptAt: new Date(now.getTime() + restMs(row.attempts)),
      },
    });
  }

  /** Asks the provider about a send that was handed over. */
  private async reconcile(row: SchoolSettlement, now: Date): Promise<void> {
    let answer: ProviderReconciliation | null = null;
    try {
      answer = await this.provider.reconcileSend(
        row.customerReference!,
        { kind: 'merchant' },
        row.sentAt ?? row.decidedAt,
      );
    } catch (e) {
      this.logger.warn(
        `school settlement ${row.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
    }
    if (answer?.state === 'found') {
      const t = answer.transaction;
      const place: PayoutPlace = {
        bankCode: row.bankCode,
        bankName: row.bankName,
        accountNumber: row.bankAccountNumber,
        accountName: row.bankAccountName,
      };
      if (t.outcome !== 'failed' && t.outcome !== 'reversed') {
        await this.restateCharge(
          row,
          row.customerReference!,
          t.feeKobo ?? null,
        );
      }
      if (t.outcome === 'completed') {
        if (t.amountKobo !== BigInt(row.schoolShareKobo)) {
          await this.toReview(
            row,
            `${this.provider.label} moved ${t.amountKobo} kobo for a payout of ${row.schoolShareKobo} kobo`,
          );
          return;
        }
        // A webhook may have completed the row at the quoted total before
        // this record was read (FIX-74): it takes the provider's own charge.
        await this.restateCompletedCharge(row, t);
        const payee = {
          bankCode: row.bankCode,
          bankName: row.bankName,
          accountNumber: row.bankAccountNumber,
          accountName: row.bankAccountName,
        };
        await this.settlePayout(
          row,
          payee,
          t.feeKobo ?? row.providerFeeKobo,
          t.id,
          now,
        );
        return;
      }
      if (t.outcome === 'failed') {
        await this.ledgerEnd(
          row,
          row.customerReference,
          place,
          'failed',
          PAYOUT_FAILED_REASON,
        );
        await this.retryAfterFailure(row, now);
        return;
      }
      if (t.outcome === 'reversed') {
        await this.ledgerEnd(
          row,
          row.customerReference,
          place,
          'reversed',
          PAYOUT_FAILED_REASON,
        );
        await this.toReview(
          row,
          `${this.provider.label} sent the payout and the bank returned it; WAWU's account holds the money again`,
        );
        return;
      }
      // Pending, or a word we do not know: neither says no money moved.
    }
    await this.stillUnknown(row, now);
  }

  private async stillUnknown(row: SchoolSettlement, now: Date): Promise<void> {
    const since = (row.sentAt ?? row.decidedAt).getTime();
    if (now.getTime() - since >= this.settings.reviewAfterHours * 3_600_000) {
      await this.toReview(
        row,
        `no completed answer from ${this.provider.label} about the payout after ${this.settings.reviewAfterHours} hours; it may have moved`,
      );
      return;
    }
    await this.schedule(row, now, row.checks + 1);
  }

  private async schedule(
    row: SchoolSettlement,
    now: Date,
    checks: number,
  ): Promise<void> {
    await this.prisma.schoolSettlement.updateMany({
      where: { id: row.id, status: 'sent' },
      data: {
        checks: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + restMs(checks)),
      },
    });
  }

  /**
   * The provider's own record says the send failed (the money is back in
   * WAWU's account): one more try under a new reference, and only one.
   */
  private async retryAfterFailure(
    row: SchoolSettlement,
    now: Date,
  ): Promise<void> {
    if (row.attempt >= MAX_ATTEMPT) {
      await this.toReview(
        row,
        `${this.provider.label} says the payout failed on its second try as well; nothing is sent again`,
      );
      return;
    }
    const attempt = row.attempt + 1;
    this.logger.warn(
      `school settlement ${row.id}: ${this.provider.label} says the payout failed; trying again as attempt ${attempt}`,
    );
    await this.prisma.schoolSettlement.updateMany({
      where: {
        id: row.id,
        status: 'sent',
        customerReference: row.customerReference,
      },
      data: {
        status: 'pending',
        attempt,
        customerReference: payoutReference(row.id, attempt),
        sentAt: null,
        checks: 0,
        providerFeeKobo: null,
        providerTransactionId: null,
        waiting: 'refused',
        nextAttemptAt: new Date(now.getTime() + restMs(attempt)),
      },
    });
  }

  /**
   * The provider confirmed the send: the ledger gets the movement, the hold is
   * released (nothing moves; WAWU's share stays), and the settlement is paid.
   * Each step is safe to repeat, so a crash between them is finished by the
   * next pass.
   */
  private async settlePayout(
    row: SchoolSettlement,
    payee: PayoutPlace,
    fee: bigint | null,
    transactionId: string | null,
    now: Date,
  ): Promise<void> {
    const amount = BigInt(row.schoolShareKobo);
    if (amount > 0n) await this.writeLedger(row, payee, fee, transactionId);
    try {
      await this.holds.release({ holdId: row.holdId }, 'The school was paid.');
    } catch (e) {
      if (e instanceof HoldRequestError) {
        await this.toReview(row, `the hold cannot be released: ${e.message}`);
        return;
      }
      throw e;
    }
    await this.prisma.schoolSettlement.updateMany({
      where: {
        id: row.id,
        action: 'payout',
        status: { in: ['pending', 'sent'] },
      },
      data: {
        status: 'paid',
        paidAt: now,
        providerFeeKobo: fee,
        providerTransactionId: transactionId ?? row.providerTransactionId,
        waiting: null,
        nextAttemptAt: null,
      },
    });
  }

  /**
   * WAWU's account paid the school: the `out` row written `pending` at the
   * lease becomes `completed` (the same row, under the same reference; one is
   * created here only for a payout sent before the pending row was written).
   * The provider's own charge is what the row says. Best effort, like every
   * ledger write after the money moved.
   */
  private async writeLedger(
    row: SchoolSettlement,
    payee: PayoutPlace,
    fee: bigint | null,
    transactionId: string | null,
  ): Promise<void> {
    const reference = row.customerReference;
    try {
      if (reference !== null) await this.restateCharge(row, reference, fee);
      const movement = await this.payoutMovement(
        this.prisma,
        row,
        reference,
        payee,
        {
          status: 'completed',
          fee: fee !== null && fee >= 0n ? fee : 0n,
          transactionId,
          figuresStand: fee === null,
        },
      );
      await this.ledger.record(movement, undefined, { quiet: true });
    } catch (e) {
      this.logger.error(
        `school settlement ${row.id}: the ledger could not record the payout (${describeDatabaseFailure(e)})`,
      );
    }
  }

  /**
   * The payout did not leave WAWU's account (`failed`: the provider says it
   * failed, or never took it) or came back (`reversed`): the pending row is
   * reversed, so the ledger stops counting money that is not gone. The row's
   * own figures stand. Best effort.
   */
  private async ledgerEnd(
    row: SchoolSettlement,
    reference: string | null,
    payee: PayoutPlace,
    status: 'failed' | 'reversed',
    failureReason: string,
  ): Promise<void> {
    if (BigInt(row.schoolShareKobo) <= 0n) return;
    try {
      const movement = await this.payoutMovement(
        this.prisma,
        row,
        reference,
        payee,
        {
          status,
          fee: this.quotedFee(BigInt(row.schoolShareKobo)),
          transactionId: row.providerTransactionId,
          figuresStand: true,
          failureReason: status === 'failed' ? failureReason : null,
        },
      );
      await this.ledger.record(movement, undefined, { quiet: true });
    } catch (e) {
      this.logger.error(
        `school settlement ${row.id}: the ledger could not record that the payout ${status === 'failed' ? 'did not leave' : 'came back'} (${describeDatabaseFailure(e)})`,
      );
    }
  }

  /** The provider's own charge replaces the quoted one on a row still pending. Best effort. */
  private async restateCharge(
    row: SchoolSettlement,
    reference: string,
    fee: bigint | null,
  ): Promise<void> {
    if (fee === null || fee < 0n) return;
    try {
      await this.ledger.restatePendingCharge(
        reference,
        BigInt(row.schoolShareKobo),
        fee,
      );
    } catch (e) {
      this.logger.error(
        `school settlement ${row.id}: the ledger could not take the provider's charge (${describeDatabaseFailure(e)})`,
      );
    }
  }

  /**
   * FIX-74: the provider's own record of this very send says it completed, at
   * its own charge. A ledger row a webhook already completed at the quoted
   * total takes that charge (once, with an audit note), so the completion
   * that follows agrees with it instead of putting the row back to pending.
   * Only the record's own reference and stated charge are passed on. Best
   * effort, like every ledger write after the money moved.
   */
  private async restateCompletedCharge(
    row: SchoolSettlement,
    record: ProviderTransaction,
  ): Promise<void> {
    if (row.customerReference === null) return;
    try {
      await this.ledger.restateCompletedCharge(
        row.customerReference,
        BigInt(row.schoolShareKobo),
        { ourReference: record.ourReference, feeKobo: record.feeKobo ?? null },
      );
    } catch (e) {
      this.logger.error(
        `school settlement ${row.id}: the ledger could not take the provider's charge on a completed row (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** The charge a payout of this size is quoted at; 0 when the schedule is not set. */
  private quotedFee(amount: bigint): bigint {
    try {
      const fee = this.fees.providerFees.bankTransferKobo(Number(amount));
      return Number.isSafeInteger(fee) && fee >= 0 ? BigInt(fee) : 0n;
    } catch {
      return 0n;
    }
  }

  /** WAWU's account paying the school, as one `out` row of the ledger. */
  private async payoutMovement(
    db: Tx | PrismaService,
    row: Pick<SchoolSettlement, 'id' | 'holdId' | 'schoolShareKobo'>,
    reference: string | null,
    payee: PayoutPlace,
    o: {
      status: 'pending' | 'completed' | 'failed' | 'reversed';
      fee: bigint;
      transactionId: string | null;
      figuresStand: boolean;
      failureReason?: string | null;
    },
  ): Promise<LedgerMovementInput> {
    const hold = await db.walletHold.findUniqueOrThrow({
      where: { id: row.holdId },
      select: { merchantAccountNumber: true, title: true, targetId: true },
    });
    return {
      wallet: { kind: 'merchant', accountNumber: hold.merchantAccountNumber },
      direction: 'out',
      status: o.status,
      category: 'earning',
      amountKobo: row.schoolShareKobo,
      feeKobo: koboNumber(o.fee),
      totalKobo: row.schoolShareKobo + koboNumber(o.fee),
      providerFeeKobo: koboNumber(o.fee),
      wawuFeeKobo: 0,
      figuresStand: o.figuresStand,
      counterparty: {
        kind: 'bank_account',
        name: payee.accountName,
        accountNumber: payee.accountNumber,
        bankCode: payee.bankCode,
        bankName: payee.bankName,
      },
      link: {
        kind: SCHOOL_FEE_KIND,
        targetId: hold.targetId,
        title: hold.title,
      },
      narration: PAYOUT_NARRATION,
      failureReason: o.failureReason ?? null,
      references: {
        customerReference: reference,
        fintavaTransactionId: o.transactionId,
      },
      source: 'send',
    };
  }

  // ---- Waiting and review -------------------------------------------------

  private async waitFor(
    row: SchoolSettlement,
    waiting: SettlementWaiting,
    now: Date,
    restMinutes: number,
  ): Promise<void> {
    if (row.waiting !== waiting) {
      this.logger.warn(
        `school settlement ${row.id}: the payout waits (${waiting}); the money stays in WAWU's account`,
      );
    }
    await this.prisma.schoolSettlement.updateMany({
      where: { id: row.id, status: 'pending', sentAt: null },
      data: {
        waiting,
        nextAttemptAt:
          restMinutes > 0
            ? new Date(now.getTime() + restMinutes * 60_000)
            : null,
      },
    });
  }

  /** Out of the sweep, for a person to look at. The money stays where it is. */
  private async toReview(row: SchoolSettlement, note: string): Promise<void> {
    const { count } = await this.prisma.schoolSettlement.updateMany({
      where: { id: row.id, status: { in: ['pending', 'sent'] } },
      data: {
        status: 'review',
        reviewNote: note.slice(0, 500),
        nextAttemptAt: null,
      },
    });
    if (count > 0) {
      this.logger.error(`school settlement ${row.id}: ${note}; sent to review`);
    }
  }
}
