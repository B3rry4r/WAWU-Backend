import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  BANK_SEND_REFERENCE_PREFIX,
  type ProviderHolder,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { NuvionStatementScope } from '../areas/reconcile';
import { readPayoutTransfer, type NuvionPayoutReading } from '../areas/payouts';
import { nuvionTransferStatus } from '../nuvion-ledger-delivery';
import type { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookStore } from '../webhook/nuvion-webhook.service';

/**
 * The events that say how a movement ended: a movement with one of these
 * stored (whatever became of it) has had its delivery, and the sweep leaves
 * it to the dispatcher. `outflows.created` and the account events do not
 * count: a send created but never completed is exactly what is swept.
 */
export const NUVION_FINAL_EVENTS = [
  'inflows.completed',
  'inflows.failed',
  'outflows.completed',
  'outflows.failed',
  'outflows.cancelled',
  'outflows.refunded',
] as const;

/** A send this young may still be on its way: the sweep leaves it to its own caller. */
export const NUVION_SWEEP_PENDING_AFTER_MS = 2 * 60_000;
/** Rows of pending sends re-read in one pass. */
const PENDING_BATCH = 100;
/** Accounts read in one pass beyond the busy ones, at the least. */
const MIN_ROTATING = 25;

/** What one pass did. Counts only: no name, number or amount. */
export interface NuvionSweepReport {
  accountsRead: number;
  linesSeen: number;
  /** Movements that already had a stored delivery: left alone. */
  held: number;
  /** Movements fed to the handlers as a delivery that never came. */
  fed: number;
  pendingChecked: number;
  /** Movements Nuvion still shows as pending: asked again next pass. */
  stillPending: number;
  /** Statements, lines or transfers that could not be read. */
  unreadable: number;
  /** Why the pass could not read everything it meant to. */
  incomplete: string[];
}

interface Candidate {
  transferId: string;
  entityId: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The event a webhook for this transfer would have carried, or null. */
export function missedEventOf(t: NuvionPayoutReading): string | null {
  const status = nuvionTransferStatus(t.status);
  if (t.type === 'outflow') {
    return status === 'failed' ? 'outflows.failed' : 'outflows.completed';
  }
  if (t.type === 'inflow') {
    if (t.sourcePaymentId !== null) return 'outflows.refunded';
    return status === 'completed' ? 'inflows.completed' : 'inflows.failed';
  }
  return null;
}

/**
 * Finds the movements whose delivery never came (task NUV-08). Nuvion stops
 * retrying a webhook after 15 minutes, so no movement may depend on one
 * arriving. A pass:
 * 1. reads the last day's statement lines of the accounts that moved (WAWU's
 *    operational account, every account with a ledger row lately, and a
 *    rotating share of the rest, at most NUVION_SWEEP_MAX_ACCOUNTS);
 * 2. re-reads the sends still pending: book transfers in the book log, and
 *    bank sends the ledger still holds as pending;
 * 3. for each settled movement with no stored final delivery, reads the
 *    transfer from Nuvion and STORES it as a delivery (`reconcile-<id>-<event>`),
 *    the very row a webhook would have made. The dispatcher then hands it to
 *    the same handlers, which read it back again and write the ledger once.
 *
 * Nothing is credited or settled here, so a late real delivery for the same
 * movement meets the same ledger row and changes nothing. A transfer found
 * on two statements, or on two passes, is one row (its id names it). A
 * movement Nuvion still shows pending is left for the next pass. A read that
 * failed is counted and reported, never taken as "nothing happened".
 */
export class NuvionMissedDeliverySweep {
  private readonly logger = new Logger('NuvionSweep');

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: NuvionWalletProvider,
    private readonly store: NuvionWebhookStore,
    private readonly opts: {
      lookbackMs: number;
      maxAccounts: number;
      sweepMinutes: number;
    },
  ) {}

  async run(now = new Date()): Promise<NuvionSweepReport> {
    const report: NuvionSweepReport = {
      accountsRead: 0,
      linesSeen: 0,
      held: 0,
      fed: 0,
      pendingChecked: 0,
      stillPending: 0,
      unreadable: 0,
      incomplete: [],
    };
    const since = new Date(now.getTime() - this.opts.lookbackMs);
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    const add = (c: Candidate) => {
      if (seen.has(c.transferId)) return;
      seen.add(c.transferId);
      candidates.push(c);
    };

    await this.fromStatements(now, since, report, add);
    await this.fromPendingSends(now, report, add);

    for (const c of candidates) await this.feed(c, now, report);
    if (report.fed > 0 || report.incomplete.length > 0) {
      this.logger.log(
        `sweep: ${report.accountsRead} accounts, ${report.linesSeen} lines, ${report.fed} fed, ${report.held} already held, ${report.unreadable} unreadable`,
      );
    }
    return report;
  }

  // -- where candidates come from ---------------------------------------------

  private async fromStatements(
    now: Date,
    since: Date,
    report: NuvionSweepReport,
    add: (c: Candidate) => void,
  ): Promise<void> {
    const area = this.provider.reconcile;
    for (const scope of await this.scopes(now, since, report)) {
      report.accountsRead += 1;
      let statement;
      try {
        statement = await area.statementSince(scope, since, now);
      } catch (e) {
        if (!(e instanceof WalletProviderError)) throw e;
        report.unreadable += 1;
        report.incomplete.push(`a statement could not be read (${e.kind})`);
        continue;
      }
      if (statement.unreadable > 0) {
        report.unreadable += statement.unreadable;
        report.incomplete.push('statement lines could not be read');
      }
      for (const line of statement.lines) {
        report.linesSeen += 1;
        if (line.outcome === 'pending') {
          report.stillPending += 1;
          continue;
        }
        add({ transferId: line.transferId, entityId: scope.entityId });
      }
    }
  }

  /** The accounts to read this pass, WAWU's own first. */
  private async scopes(
    now: Date,
    since: Date,
    report: NuvionSweepReport,
  ): Promise<NuvionStatementScope[]> {
    const own: NuvionStatementScope = {
      accountId: this.provider.client.settings.operationalAccountId,
      entityId: null,
    };
    const entities = (
      await this.prisma.nuvionEntity.findMany({
        where: { accountId: { not: null }, entityId: { not: null } },
        select: { wawuUserId: true, entityId: true, accountId: true },
        orderBy: { wawuUserId: 'asc' },
      })
    ).flatMap((e) =>
      e.entityId === null || e.accountId === null
        ? []
        : [
            {
              wawuUserId: e.wawuUserId,
              entityId: e.entityId,
              accountId: e.accountId,
            },
          ],
    );
    const moved = new Set(
      (
        await this.prisma.fintavaLedgerEntry.findMany({
          where: {
            provider: 'nuvion',
            wawuUserId: { not: null },
            createdAt: { gte: since },
          },
          distinct: ['wawuUserId'],
          select: { wawuUserId: true },
          take: 5000,
        })
      ).map((r) => r.wawuUserId),
    );
    const toScope = (e: { entityId: string; accountId: string }) => ({
      accountId: e.accountId,
      entityId: e.entityId,
    });
    const busy = entities.filter((e) => moved.has(e.wawuUserId));
    const rest = entities.filter((e) => !moved.has(e.wawuUserId));
    const room = Math.max(
      this.opts.maxAccounts - 1 - busy.length,
      Math.min(MIN_ROTATING, rest.length),
    );
    const slot = Math.floor(now.getTime() / (this.opts.sweepMinutes * 60_000));
    const start = rest.length === 0 ? 0 : (slot * room) % rest.length;
    const rotating: typeof rest = [];
    for (let i = 0; i < Math.min(room, rest.length); i += 1) {
      rotating.push(rest[(start + i) % rest.length]);
    }
    const chosen = [...busy, ...rotating];
    if (chosen.length > this.opts.maxAccounts - 1) {
      report.incomplete.push(
        `more accounts moved than one pass reads (${this.opts.maxAccounts})`,
      );
    }
    return [own, ...chosen.slice(0, this.opts.maxAccounts - 1).map(toScope)];
  }

  private async fromPendingSends(
    now: Date,
    report: NuvionSweepReport,
    add: (c: Candidate) => void,
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - NUVION_SWEEP_PENDING_AFTER_MS);
    // Book transfers: the log holds Nuvion's id once an answer was read.
    const book = await this.prisma.nuvionBookTransfer.findMany({
      where: {
        status: { in: ['sending', 'pending', 'processing'] },
        sentAt: { lt: cutoff },
      },
      orderBy: { sentAt: 'asc' },
      take: PENDING_BATCH,
    });
    for (const row of book) {
      report.pendingChecked += 1;
      if (row.nuvionId) {
        add({ transferId: row.nuvionId, entityId: row.fromEntityId });
        continue;
      }
      const holder: ProviderHolder =
        row.fromOperational || !row.fromEntityId
          ? { kind: 'merchant' }
          : { kind: 'customer', customerId: row.fromEntityId };
      await this.askAboutReference(
        row.reference,
        holder,
        row.sentAt,
        report,
        add,
      );
    }
    // Bank sends the ledger still holds as pending.
    const bank = await this.prisma.fintavaLedgerEntry.findMany({
      where: {
        provider: 'nuvion',
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        customerReference: { startsWith: BANK_SEND_REFERENCE_PREFIX },
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: PENDING_BATCH,
      select: {
        customerReference: true,
        walletKind: true,
        wawuUserId: true,
        createdAt: true,
        fintavaTransactionId: true,
      },
    });
    for (const row of bank) {
      report.pendingChecked += 1;
      const entity =
        row.walletKind === 'user' && row.wawuUserId
          ? await this.prisma.nuvionEntity.findUnique({
              where: { wawuUserId: row.wawuUserId },
              select: { entityId: true },
            })
          : null;
      const entityId = entity?.entityId ?? null;
      if (row.walletKind === 'user' && entityId === null) continue;
      const holder: ProviderHolder =
        entityId === null
          ? { kind: 'merchant' }
          : { kind: 'customer', customerId: entityId };
      if (row.fintavaTransactionId) {
        add({ transferId: row.fintavaTransactionId, entityId });
        continue;
      }
      if (row.customerReference) {
        await this.askAboutReference(
          row.customerReference,
          holder,
          row.createdAt,
          report,
          add,
        );
      }
    }
  }

  /** A send whose answer was lost: found again by our reference, never sent again. */
  private async askAboutReference(
    reference: string,
    holder: ProviderHolder,
    since: Date,
    report: NuvionSweepReport,
    add: (c: Candidate) => void,
  ): Promise<void> {
    try {
      const r = await this.provider.reconcileSend(reference, holder, since);
      if (r.state === 'found') {
        add({
          transferId: r.transaction.id,
          entityId: holder.kind === 'customer' ? holder.customerId : null,
        });
      } else if (r.state === 'unknown') {
        report.stillPending += 1;
      }
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      report.unreadable += 1;
      report.incomplete.push(
        `a pending send could not be asked about (${e.kind})`,
      );
    }
  }

  // -- feeding the handlers ---------------------------------------------------

  private async feed(
    c: Candidate,
    now: Date,
    report: NuvionSweepReport,
  ): Promise<void> {
    const held = await this.prisma.nuvionWebhookEvent.findFirst({
      where: {
        resourceId: c.transferId,
        event: { in: [...NUVION_FINAL_EVENTS] },
      },
      select: { id: true },
    });
    if (held) {
      report.held += 1;
      return;
    }
    let raw: unknown;
    try {
      raw = await this.provider.reconcile.getTransfer(c.entityId, c.transferId);
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      report.unreadable += 1;
      report.incomplete.push(`a movement could not be read back (${e.kind})`);
      return;
    }
    const object = isRecord(raw) && isRecord(raw.transfer) ? raw.transfer : raw;
    const read = readPayoutTransfer(object);
    if (!read.ok || read.transfer.id !== c.transferId) {
      report.unreadable += 1;
      report.incomplete.push('a movement read back is not a transfer');
      return;
    }
    const status = nuvionTransferStatus(read.transfer.status);
    if (status === 'pending') {
      report.stillPending += 1;
      return;
    }
    const event = missedEventOf(read.transfer);
    if (event === null) {
      report.unreadable += 1;
      return;
    }
    const body = { event, data: object };
    const ack = await this.store.record({
      eventId: `reconcile-${c.transferId}-${event}`,
      signedAt: now.toISOString(),
      rawBody: Buffer.from(JSON.stringify(body)),
      body,
    });
    if (ack.outcome === 'recorded') report.fed += 1;
    else report.held += 1;
  }
}
