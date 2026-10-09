import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type {
  LedgerSource,
  LedgerRecordResult,
} from '../../money/ledger/ledger.interface';
import type { LedgerService } from '../../money/ledger/ledger.service';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import {
  isNuvionId,
  NUVION_NAIRA,
  type NuvionAccountsArea,
  nuvionWalletId,
} from '../areas/accounts';
import {
  nuvionInflowMovement,
  nuvionInflowProblem,
  type NuvionTransferReading,
  readNuvionTransfer,
} from '../nuvion-ledger-delivery';
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

/** The rail this task credits: money in by bank transfer (R-42). */
export const NUVION_BANK_TRANSFER = 'bank-transfer';

/** A person's Nuvion wallet, as the ledger writes on it. */
export interface NuvionInflowWallet {
  wawuUserId: string;
  accountNumber: string;
}

/**
 * Money in by bank transfer (task NUV-04, R-42): Nuvion's `inflows.*`
 * deliveries reach the ledger here, once.
 *
 * `inflows.completed` counts only after the transfer is read back from
 * Nuvion (`GET /transfers/{id}`, as Nuvion's guide says) and Nuvion's
 * record agrees with the delivery and with us: the same transfer, into
 * this person's naira account and entity, in naira, money in, by bank
 * transfer, with the same amount and fee, and `successful`. Then one `in`
 * row is written through LedgerService on the person's wallet (stamped
 * `nuvion`, the running provider), keyed on Nuvion's transfer id and its
 * `unique_reference`: a replay, a second delivery of the same inflow
 * (even at the same moment), or NUV-08's sweep having found it first
 * (`recordInflow` with its own source) all land on the same row.
 *
 * Still on its way (`pending`, `processing`): waits. `failed` or
 * `reversed`: nothing is credited. Any disagreement is a stop, kept as
 * `failed` for review and never credited or fixed silently.
 * `inflows.failed` credits nothing; if the ledger already holds that
 * inflow as received, that is a stop for review too.
 *
 * Not this task's: WAWU's operational account (NUV-05), an account in
 * another currency than the person's naira one (NUV-09), and a book
 * transfer between Nuvion accounts (NUV-05 records both sides of it).
 * The balance never comes from these rows (MONEY-11, NUV-04): it is
 * Nuvion's `available`.
 */
export class NuvionInflowRecorder {
  private readonly logger = new Logger('NuvionInflows');

  constructor(
    private readonly prisma: PrismaService,
    private readonly area: NuvionAccountsArea,
    private readonly ledger: LedgerService,
    private readonly settings: { operationalAccountId: string },
  ) {}

  async onInflow(d: NuvionDelivery): Promise<NuvionHandlerResult> {
    const read = readNuvionTransfer(d.data);
    if (!read.ok) return failed(`${read.why}; nothing credited`);
    const delivered = read.transfer;
    const entityId = delivered.entityId ?? d.entityId;
    const accountId = delivered.accountId;
    if (!isNuvionId(entityId) || !isNuvionId(accountId)) {
      return failed('the inflow names no account or entity; nothing credited');
    }
    if (accountId === this.settings.operationalAccountId) {
      return done(
        "money into WAWU's operational account: not a person's wallet",
      );
    }

    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: { wawuUserId: true, accountId: true },
    });
    if (!entity) return this.waitOrFail(d, 'no person holds this entity yet');
    if (entity.accountId === null) {
      return this.waitOrFail(
        d,
        "the person's naira account is not recorded yet",
      );
    }
    if (entity.accountId !== accountId) {
      if (delivered.currency !== NUVION_NAIRA) {
        return done(`a ${delivered.currency} inflow: not the naira wallet`);
      }
      return failed(
        "naira into an account that is not the person's naira account; nothing credited (review)",
      );
    }
    const wallet = await this.prisma.fintavaWallet.findFirst({
      where: {
        wawuUserId: entity.wawuUserId,
        walletId: nuvionWalletId(entityId, accountId),
        provider: 'nuvion',
      },
      select: { wawuUserId: true, accountNumber: true },
    });

    if (d.event === 'inflows.failed') {
      if (wallet) {
        const held = await this.ledger.entriesFor(
          wallet.accountNumber,
          'in',
          nuvionInflowMovement(delivered).references,
        );
        if (held.length > 0) {
          this.logger.error(
            'inflows: Nuvion reports failed an inflow the ledger holds as received; nothing changed (review)',
          );
          return failed(
            'Nuvion reports failed an inflow the ledger holds as received; nothing changed (review)',
          );
        }
      }
      return done('a failed inflow credits nothing');
    }

    if (!wallet) {
      return this.waitOrFail(
        d,
        "the person's account number is not recorded yet",
      );
    }

    // Never on the delivery's word alone: read back from Nuvion first.
    let raw: unknown;
    try {
      raw = await this.area.getTransfer(entityId, delivered.id);
    } catch (e) {
      if (e instanceof WalletProviderError) {
        return this.waitOrFail(
          d,
          `Nuvion could not read the transfer back (${e.kind})`,
        );
      }
      throw e;
    }
    const fresh = readNuvionTransfer(raw);
    if (!fresh.ok) {
      return this.waitOrFail(
        d,
        `Nuvion's record could not be read (${fresh.why})`,
      );
    }
    const problem = nuvionInflowProblem(fresh.transfer, {
      id: delivered.id,
      entityId,
      accountId,
      delivered,
    });
    if (problem) {
      this.logger.error(`inflows: ${problem}; nothing credited (review)`);
      return failed(`${problem}; nothing credited (review)`);
    }
    return this.creditIfSettled(d, fresh.transfer, wallet, 'webhook', d.id);
  }

  /**
   * Credits one inflow Nuvion's own record says is settled. For the
   * handler (above) and for NUV-08, which finds an inflow whose delivery
   * never came and has read it back the same way (`source` `history` or
   * `lookup`, no delivery id). The caller has already compared the record
   * with the person's account (`nuvionInflowProblem`).
   */
  async creditIfSettled(
    d: NuvionDelivery | null,
    t: NuvionTransferReading,
    wallet: NuvionInflowWallet,
    source: LedgerSource,
    sourceEventId: string | null,
  ): Promise<NuvionHandlerResult> {
    if (t.paymentType !== NUVION_BANK_TRANSFER) {
      return t.paymentType === 'book-transfer'
        ? done(
            'a book transfer between Nuvion accounts: recorded by its sender (NUV-05)',
          )
        : failed(
            `an inflow by ${t.paymentType ?? 'no named rail'}: not money in by bank transfer; nothing credited (review)`,
          );
    }
    const m = nuvionInflowMovement(t);
    if (m.status === 'pending') {
      return this.waitOrFail(
        d,
        `Nuvion says the transfer is still ${t.status}`,
      );
    }
    if (m.status === 'failed' || m.status === 'reversed') {
      return done(`Nuvion says the transfer is ${t.status}; nothing credited`);
    }
    if (m.status !== 'completed') {
      return failed(
        `Nuvion's transfer status "${t.status}" is not one we know; nothing credited (review)`,
      );
    }
    const r = await this.recordInflow(t, wallet, source, sourceEventId);
    return done(
      `${r.created ? 'credited' : 'already credited'} once${r.discrepancy ? `; ${r.discrepancy} (review)` : ''}`,
    );
  }

  /** One `in` row on the person's wallet for this settled inflow; the same row every time. */
  recordInflow(
    t: NuvionTransferReading,
    wallet: NuvionInflowWallet,
    source: LedgerSource,
    sourceEventId: string | null,
  ): Promise<LedgerRecordResult> {
    return this.ledger.record({
      wallet: {
        kind: 'user',
        wawuUserId: wallet.wawuUserId,
        accountNumber: wallet.accountNumber,
      },
      direction: 'in',
      status: 'completed',
      category: 'top_up',
      amountKobo: t.amountKobo,
      feeKobo: t.feeKobo,
      totalKobo: t.amountKobo,
      counterparty: {
        kind: 'bank_account',
        name: null,
        accountNumber: null,
        bankCode: null,
      },
      narration: t.narration,
      references: {
        fintavaTransactionId: t.id,
        fintavaReference: t.uniqueReference,
      },
      source,
      sourceEventId,
      occurredAt: t.createdAt,
    });
  }

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
