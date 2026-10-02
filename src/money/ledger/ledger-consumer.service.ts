import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FintavaClient } from '../../fintava/fintava-client';
import { FintavaError } from '../../fintava/fintava-error';
import type {
  FintavaSender,
  FintavaTransaction,
} from '../../fintava/fintava.interface';
import type { TransferStatus } from '../money-view.type';
import {
  LEDGER_CONFIG_KEYS,
  LEDGER_DEFAULTS,
  ledgerConfirmWindowMs,
} from './ledger-config';
import type {
  LedgerCounterparty,
  LedgerDirection,
  LedgerWallet,
} from './ledger.interface';
import { koboNumber, LedgerService } from './ledger.service';
import {
  LEDGER_WEBHOOK_EVENTS,
  ledgerStatusOf,
  readLedgerWebhook,
  type LedgerParty,
  type LedgerWebhookMovement,
  type LedgerWebhookReversal,
} from './ledger-webhook';

/** What one pass over one stored delivery did. */
export type LedgerConsumeOutcome =
  /** Applied to the ledger and marked processed. */
  | 'processed'
  /** Could not be read, or matched nothing in time: marked failed, with a note. */
  | 'failed'
  /** Left pending, with a note: Fintava could not confirm it yet. */
  | 'waiting'
  /** Not the ledger's, not pending, or another worker holds it. */
  | 'skipped';

/** What Fintava says about a movement a delivery names. */
type Confirmation =
  | {
      state: 'found';
      transaction: FintavaTransaction;
      tagapayTransRef: string | null;
    }
  | { state: 'absent' }
  | { state: 'unknown'; why: string };

/** A party that is one of WAWU's wallets. */
interface OurWallet {
  wallet: LedgerWallet;
  /** Fintava's customerId, for the person's history; null on the merchant wallet. */
  customerId: string | null;
}

/** Thrown inside a pass when WAWU's own merchant account number cannot be read. */
class MerchantAccountUnknown extends Error {}

const MINUTE = 60_000;

/**
 * Feeds the ledger from MONEY-07's stored Fintava deliveries (task MONEY-10).
 *
 * Mechanism, Default (agent), owner may override: a sweep every 30 seconds
 * over the `pending` deliveries of the ledger's events
 * (LEDGER_WEBHOOK_EVENTS), oldest first. Not on receipt: the webhook route
 * stays exactly as MONEY-07 built it (answer 200 after one insert, nothing
 * else), and the balance a person sees is Fintava's, read live (MONEY-11),
 * so only the history row waits up to a sweep.
 *
 * Exactly once, twice over: each delivery is locked (`FOR UPDATE SKIP
 * LOCKED`) and re-checked as `pending` inside the transaction that writes
 * its ledger rows and marks it `processed`, so two workers never apply the
 * same delivery; and every ledger write lands on the reference key
 * (LedgerService), so a movement seen by two deliveries, or by a delivery
 * and the sending feature, is one row per side.
 *
 * Where a delivery cannot be trusted alone (G-19: which of Fintava's
 * references it carries is unconfirmed; a wallet-to-wallet delivery reports
 * no status) and no side of it is in the ledger yet, it is confirmed
 * through the MONEY-06 client: the lookup by
 * each reference, then the sender's history (debits only), then rows of the
 * same amount by id (only the by-id record carries `tagapayTransRef`). A
 * lookup that answers `{}` is neither found nor absent: the delivery stays
 * `pending` and is tried again, backing off, for the confirm window.
 */
@Injectable()
export class LedgerConsumerService {
  private readonly logger = new Logger(LedgerConsumerService.name);
  private readonly confirmWindowMs: number;
  private merchantAccountNumber: string | null = null;
  private sweeping = false;
  /** Deliveries left waiting, and when each may be tried again (per process). */
  private readonly retryAt = new Map<string, { at: number; delayMs: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fintava: FintavaClient,
    private readonly ledger: LedgerService,
    config: ConfigService,
  ) {
    this.confirmWindowMs = ledgerConfirmWindowMs(
      config.get<string>(LEDGER_CONFIG_KEYS.confirmWindowHours),
    );
  }

  /** The sweep. One pass at a time per process; workers on other processes skip what this one holds. */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'ledger-fintava-events' })
  async sweep(now = new Date()): Promise<Record<LedgerConsumeOutcome, number>> {
    const counts: Record<LedgerConsumeOutcome, number> = {
      processed: 0,
      failed: 0,
      waiting: 0,
      skipped: 0,
    };
    if (this.sweeping) return counts;
    this.sweeping = true;
    try {
      const resting = [...this.retryAt.entries()]
        .filter(([, r]) => r.at > now.getTime())
        .map(([id]) => id);
      const due = await this.prisma.fintavaWebhookEvent.findMany({
        where: {
          processingStatus: 'pending',
          event: { in: [...LEDGER_WEBHOOK_EVENTS] },
          ...(resting.length ? { id: { notIn: resting } } : {}),
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take: LEDGER_DEFAULTS.batch,
        select: { id: true },
      });
      for (const { id } of due) {
        try {
          counts[await this.consume(id, now)] += 1;
        } catch (e) {
          // The name only: a message can quote what the delivery carried.
          this.logger.error(
            `ledger: a delivery could not be applied (${(e as Error).name ?? 'Error'}); it stays pending`,
          );
          this.backOff(id, now);
        }
      }
      if (counts.processed + counts.failed > 0) {
        this.logger.log(
          `ledger: ${counts.processed} processed, ${counts.failed} failed, ${counts.waiting} waiting`,
        );
      }
      return counts;
    } finally {
      this.sweeping = false;
    }
  }

  /** One stored delivery, by its FintavaWebhookEvent id. */
  async consume(
    eventId: string,
    now = new Date(),
  ): Promise<LedgerConsumeOutcome> {
    const event = await this.prisma.fintavaWebhookEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        event: true,
        reference: true,
        payload: true,
        receivedAt: true,
        processingStatus: true,
      },
    });
    if (
      !event ||
      event.processingStatus !== 'pending' ||
      !(LEDGER_WEBHOOK_EVENTS as readonly string[]).includes(event.event)
    ) {
      return 'skipped';
    }
    const reading = readLedgerWebhook(
      event.event,
      event.payload,
      event.reference,
    );
    const age = now.getTime() - event.receivedAt.getTime();
    let outcome: LedgerConsumeOutcome;
    try {
      if (reading.kind === 'unreadable') {
        outcome = await this.finish(event.id, () => ({
          status: 'failed',
          note: `ledger: ${reading.why}`,
        }));
      } else if (reading.kind === 'reversal') {
        outcome = await this.consumeReversal(
          event.id,
          reading,
          age,
          event.receivedAt,
        );
      } else {
        outcome = await this.consumeMovement(event, reading, age);
      }
    } catch (e) {
      if (!(e instanceof MerchantAccountUnknown)) throw e;
      outcome = await this.wait(
        event.id,
        "ledger: WAWU's merchant account number could not be read from Fintava; tried again on the next sweep",
      );
    }
    if (outcome === 'waiting') this.backOff(event.id, now);
    else this.retryAt.delete(event.id);
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Movements
  // -------------------------------------------------------------------------

  private async consumeMovement(
    event: { id: string; receivedAt: Date },
    m: LedgerWebhookMovement,
    age: number,
  ): Promise<LedgerConsumeOutcome> {
    let fromParty = m.from;
    let toParty = m.to;
    let from = await this.resolve(fromParty);
    let to = await this.resolve(toParty);
    if (m.partiesMaySwap && !to && from && from.wallet.kind === 'user') {
      [fromParty, toParty, from, to] = [toParty, fromParty, to, from];
    }
    if (!from && !to) {
      return this.finish(event.id, () => ({
        status: 'processed',
        note: 'ledger: no WAWU wallet on either side; nothing recorded',
      }));
    }

    const sides: Array<{
      wallet: LedgerWallet;
      direction: LedgerDirection;
      counterparty: LedgerCounterparty | null;
    }> = [];
    if (from) {
      sides.push({
        wallet: from.wallet,
        direction: 'out',
        counterparty: this.counterparty(toParty, to),
      });
    }
    if (to) {
      sides.push({
        wallet: to.wallet,
        direction: 'in',
        counterparty: this.counterparty(fromParty, from),
      });
    }

    let status = m.status;
    const notes: string[] = [];
    const named: {
      customerReference: string | null;
      fintavaReference: string | null;
      tagapayTransRef: string | null;
      fintavaTransactionId: string | null;
    } = {
      customerReference: null,
      fintavaReference: null,
      tagapayTransRef: null,
      fintavaTransactionId: null,
    };
    let occurredAt: Date | null = null;

    const held = await Promise.all(
      sides.map((s) =>
        this.ledger.entriesFor(
          s.wallet.accountNumber,
          s.direction,
          m.references,
        ),
      ),
    );
    const heldId = held.find((ids) => ids.length > 0)?.[0] ?? null;
    if (!m.trustAlone && heldId && held.some((ids) => ids.length === 0)) {
      // One side is already in the ledger under these references, so the
      // movement is identified: the other side takes that row's references
      // and nothing needs asking.
      const row = await this.prisma.fintavaLedgerEntry.findUnique({
        where: { id: heldId },
      });
      if (row) {
        named.customerReference =
          from && row.direction === 'out' ? row.customerReference : null;
        named.fintavaReference = row.fintavaReference;
        named.tagapayTransRef = row.tagapayTransRef;
        named.fintavaTransactionId = row.fintavaTransactionId;
        notes.push('identified by the side already held');
      }
    } else if (!m.trustAlone && !heldId) {
      const c = await this.confirm(
        m.references,
        this.senderOf(from),
        m.amountKobo,
        event.receivedAt,
      );
      if (c.state === 'found') {
        const t = c.transaction;
        status = ledgerStatusOf(t.status) ?? status;
        // Only a sender of ours wrote the record's CustomerReference.
        named.customerReference = from ? t.customerReference : null;
        named.fintavaReference = t.fintavaReference;
        named.tagapayTransRef = c.tagapayTransRef ?? t.tagapayTransRef;
        named.fintavaTransactionId = t.id;
        occurredAt = Number.isNaN(Date.parse(t.createdAt))
          ? null
          : new Date(t.createdAt);
        notes.push('confirmed with Fintava');
        if (t.amountKobo !== m.amountKobo) {
          notes.push(
            `Fintava's record says ${t.amountKobo} kobo, the delivery ${m.amountKobo}`,
          );
        }
      } else if (c.state === 'unknown' && age < this.confirmWindowMs) {
        return this.wait(
          event.id,
          `ledger: waiting for Fintava to confirm (${c.why}); tried again on the next sweep`,
        );
      } else {
        notes.push(
          c.state === 'absent'
            ? 'recorded from the signed delivery: Fintava does not find it by these references'
            : 'recorded from the signed delivery: Fintava could not confirm it within the window',
        );
      }
    }
    // A wallet-to-wallet delivery reports no status but the balances after
    // the move; a bank send without a status is still on its way.
    const final: TransferStatus =
      status ??
      (m.event === 'customer_bank_transfer' ? 'pending' : 'completed');

    return this.finish(event.id, async (tx) => {
      const written: string[] = [];
      for (const side of sides) {
        const out = side.direction === 'out';
        const r = await this.ledger.record(
          {
            wallet: side.wallet,
            direction: side.direction,
            status: final,
            category: m.category,
            amountKobo: m.amountKobo,
            feeKobo: out ? m.feeKobo : 0,
            totalKobo: out ? m.totalKobo : m.amountKobo,
            counterparty: side.counterparty,
            narration: m.narration,
            references: {
              ...named,
              customerReference: out ? named.customerReference : null,
              sessionId: m.sessionId,
              delivery: [
                ...m.references,
                // Ours, on the receiving side, is only another reference.
                ...(out ? [] : [named.customerReference]),
              ],
            },
            source: 'webhook',
            sourceEventId: event.id,
            occurredAt,
          },
          tx,
        );
        written.push(
          `${side.direction} ${r.created ? 'recorded' : 'already held'}`,
        );
      }
      return {
        status: 'processed',
        note: `ledger: ${[...written, ...notes].join('; ')}`,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Reversals: the original row becomes `reversed`; never a second debit.
  // -------------------------------------------------------------------------

  private async consumeReversal(
    eventId: string,
    r: LedgerWebhookReversal,
    age: number,
    receivedAt: Date,
  ): Promise<LedgerConsumeOutcome> {
    if (r.status === 'failed' || r.status === 'pending') {
      return this.finish(eventId, () => ({
        status: 'processed',
        note: `ledger: the reversal reported ${r.status}; the debit is unchanged`,
      }));
    }
    const input = {
      references: r.references,
      reversalReference: r.reversalReference,
      amountKobo: r.amountKobo,
      chargesKobo: r.chargesKobo,
      totalKobo: r.totalKobo,
      at: receivedAt,
    };
    let refs = r.references;
    if ((await this.ledger.debitsFor(refs)).length === 0) {
      // The debit may be held under references the delivery does not carry:
      // ask Fintava for the record and try its references too.
      const c = await this.confirm(r.references, null, 0, receivedAt);
      if (c.state === 'found') {
        const t = c.transaction;
        refs = [
          ...r.references,
          ...[
            t.customerReference,
            t.fintavaReference,
            c.tagapayTransRef,
            t.tagapayTransRef,
            t.id,
          ].filter((v): v is string => !!v),
        ];
      } else if (age < this.confirmWindowMs) {
        return this.wait(
          eventId,
          'ledger: no debit in the ledger matches this reversal yet; tried again on the next sweep',
        );
      }
    }
    return this.finish(
      eventId,
      async (tx) => {
        const res = await this.ledger.applyReversal(
          { ...input, references: refs },
          tx,
        );
        if (res.state === 'applied') {
          return {
            status: 'processed',
            note: `ledger: debit ${res.entryId} ${res.changed ? 'marked reversed' : 'was already reversed'}`,
          };
        }
        if (res.state === 'ambiguous') {
          return {
            status: 'failed',
            note: `ledger: the reversal names ${res.entryIds.length} debits; none was changed (review)`,
          };
        }
        if (age < this.confirmWindowMs) return null;
        return {
          status: 'failed',
          note: 'ledger: no debit in the ledger matches this reversal; nothing was written (review)',
        };
      },
      'ledger: no debit in the ledger matches this reversal yet; tried again on the next sweep',
    );
  }

  // -------------------------------------------------------------------------
  // Reconciling one pending row of ours with Fintava (history and lookup)
  // -------------------------------------------------------------------------

  /**
   * Asks Fintava about one `out` row WAWU sent (it holds our
   * CustomerReference): the MONEY-06 client's reconcile, the lookup by our
   * reference then the sender's history. What Fintava found is merged into
   * the row (status forward only, references filled, amounts compared). An
   * absent or unknown answer changes nothing: deciding that a send failed is
   * MONEY-08's, with its resend rules.
   */
  async reconcileEntry(entryId: string): Promise<{
    state: 'found' | 'absent' | 'unknown' | 'skipped';
    status: TransferStatus | null;
  }> {
    const e = await this.prisma.fintavaLedgerEntry.findUnique({
      where: { id: entryId },
    });
    if (!e || e.direction !== 'out' || !e.customerReference) {
      return { state: 'skipped', status: null };
    }
    let sender: FintavaSender;
    let wallet: LedgerWallet;
    if (e.walletKind === 'merchant') {
      sender = { kind: 'merchant' };
      wallet = { kind: 'merchant', accountNumber: e.accountNumber };
    } else {
      const w = await this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId: e.wawuUserId ?? '' },
        select: { customerId: true, wawuUserId: true },
      });
      if (!w) return { state: 'skipped', status: null };
      sender = { kind: 'customer', customerId: w.customerId };
      wallet = {
        kind: 'user',
        wawuUserId: w.wawuUserId,
        accountNumber: e.accountNumber,
      };
    }
    let r;
    try {
      r = await this.fintava.reconcile(
        e.customerReference,
        sender,
        e.occurredAt,
      );
    } catch (err) {
      if (err instanceof FintavaError)
        return { state: 'unknown', status: null };
      throw err;
    }
    if (r.state !== 'found') return { state: r.state, status: null };
    const t = r.transaction;
    const status = ledgerStatusOf(t.status) ?? 'pending';
    await this.ledger.record({
      wallet,
      direction: 'out',
      status,
      category: e.category,
      amountKobo: t.amountKobo,
      // Lookups and history carry no fee for a wallet-to-wallet send: the
      // row's own fee and total stand, and only the amount is compared.
      feeKobo: koboNumber(e.feeKobo),
      totalKobo: koboNumber(e.totalKobo),
      references: {
        customerReference: t.customerReference,
        fintavaReference: t.fintavaReference,
        tagapayTransRef: t.tagapayTransRef ?? (await this.tagapayOf(t)),
        fintavaTransactionId: t.id,
        sessionId: t.sessionId,
      },
      source: r.source,
      occurredAt: Number.isNaN(Date.parse(t.createdAt))
        ? null
        : new Date(t.createdAt),
    });
    return { state: 'found', status };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Locks the delivery, re-checks it is pending, runs `write` and marks it
   * with what `write` returned, all in one transaction. `write` returning
   * null leaves it pending (with `waitNote`).
   */
  private async finish(
    eventId: string,
    write: (
      tx: Prisma.TransactionClient,
    ) =>
      | Promise<{ status: 'processed' | 'failed'; note: string } | null>
      | { status: 'processed' | 'failed'; note: string }
      | null,
    waitNote = 'ledger: tried again on the next sweep',
  ): Promise<LedgerConsumeOutcome> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const held = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "FintavaWebhookEvent"
         WHERE "id" = ${eventId} AND "processingStatus" = 'pending'
         FOR UPDATE SKIP LOCKED`;
      if (held.length === 0) return 'skipped' as const;
      const result = await write(tx);
      if (result === null) return 'waiting' as const;
      await tx.fintavaWebhookEvent.update({
        where: { id: eventId },
        data: {
          processingStatus: result.status,
          processedAt: new Date(),
          note: result.note.slice(0, 1000),
        },
      });
      return result.status;
    });
    if (outcome === 'waiting') return this.wait(eventId, waitNote);
    return outcome;
  }

  /** Leaves the delivery pending, saying why. */
  private async wait(
    eventId: string,
    note: string,
  ): Promise<LedgerConsumeOutcome> {
    await this.prisma.fintavaWebhookEvent.updateMany({
      where: { id: eventId, processingStatus: 'pending' },
      data: { note: note.slice(0, 1000) },
    });
    return 'waiting';
  }

  /** 1, 2, 4 ... minutes, at most an hour, between tries of a waiting delivery. */
  private backOff(eventId: string, now: Date): void {
    const prev = this.retryAt.get(eventId);
    const delayMs = Math.min(prev ? prev.delayMs * 2 : MINUTE, 60 * MINUTE);
    this.retryAt.set(eventId, { at: now.getTime() + delayMs, delayMs });
  }

  /** WAWU's merchant account number, read from Fintava once per process. */
  private async merchantAccount(): Promise<string> {
    if (this.merchantAccountNumber) return this.merchantAccountNumber;
    try {
      const m = await this.fintava.getMerchantBalance();
      this.merchantAccountNumber = m.accountNumber;
      return m.accountNumber;
    } catch (e) {
      if (e instanceof FintavaError) throw new MerchantAccountUnknown();
      throw e;
    }
  }

  /** The WAWU wallet a party is, if any. */
  private async resolve(party: LedgerParty | null): Promise<OurWallet | null> {
    if (!party) return null;
    if (party.merchant) {
      return {
        wallet: {
          kind: 'merchant',
          accountNumber: await this.merchantAccount(),
        },
        customerId: null,
      };
    }
    const or: Prisma.FintavaWalletWhereInput[] = [];
    if (party.customerId) or.push({ customerId: party.customerId });
    if (party.accountNumbers.length) {
      or.push({ accountNumber: { in: party.accountNumbers } });
    }
    if (or.length === 0) return null;
    const w = await this.prisma.fintavaWallet.findFirst({
      where: { OR: or },
      select: { wawuUserId: true, accountNumber: true, customerId: true },
    });
    if (w) {
      return {
        wallet: {
          kind: 'user',
          wawuUserId: w.wawuUserId,
          accountNumber: w.accountNumber,
        },
        customerId: w.customerId,
      };
    }
    if (party.accountNumbers.length) {
      const merchant = await this.merchantAccount();
      if (party.accountNumbers.includes(merchant)) {
        return {
          wallet: { kind: 'merchant', accountNumber: merchant },
          customerId: null,
        };
      }
    }
    return null;
  }

  private senderOf(from: OurWallet | null): FintavaSender | null {
    if (!from) return null;
    if (from.wallet.kind === 'merchant') return { kind: 'merchant' };
    return from.customerId
      ? { kind: 'customer', customerId: from.customerId }
      : null;
  }

  /** The other side of a row, as the history shows it (W26, W27). */
  private counterparty(
    party: LedgerParty | null,
    ours: OurWallet | null,
  ): LedgerCounterparty | null {
    if (ours?.wallet.kind === 'user') {
      return {
        kind: 'wawu_user',
        name: party?.name ?? null,
        wawuUserId: ours.wallet.wawuUserId,
        accountNumber: ours.wallet.accountNumber,
      };
    }
    if (ours?.wallet.kind === 'merchant') {
      return {
        kind: 'wawu',
        name: party?.name ?? null,
        accountNumber: ours.wallet.accountNumber,
      };
    }
    if (!party) return null;
    return {
      kind: 'bank_account',
      name: party.name,
      accountNumber: party.accountNumbers[0] ?? null,
      bankCode: party.bankCode,
    };
  }

  /** The by-id record's tagapayTransRef: the only record that carries it. */
  private async tagapayOf(t: FintavaTransaction): Promise<string | null> {
    if (t.tagapayTransRef) return t.tagapayTransRef;
    try {
      const l = await this.fintava.getTransactionById(t.id);
      return l.state === 'found' ? l.transaction.tagapayTransRef : null;
    } catch (e) {
      if (e instanceof FintavaError) return null;
      throw e;
    }
  }

  /**
   * What Fintava knows about a movement named by these references: the
   * lookup by each (ours and Fintava's are findable), then, for a sender of
   * ours, its history (debits only), matching any reference, and rows of the
   * same amount read by id for their tagapayTransRef.
   */
  private async confirm(
    references: readonly string[],
    sender: FintavaSender | null,
    amountKobo: number,
    around: Date,
  ): Promise<Confirmation> {
    const refs = [...new Set(references)].filter(
      (r) => !r.startsWith('sha256:'),
    );
    let unclear = '';
    for (const ref of refs.slice(0, 4)) {
      try {
        const l = await this.fintava.getTransactionByReference(ref);
        if (l.state === 'found') {
          return {
            state: 'found',
            transaction: l.transaction,
            tagapayTransRef: await this.tagapayOf(l.transaction),
          };
        }
        if (l.state === 'unknown') unclear = 'empty_lookup';
      } catch (e) {
        if (!(e instanceof FintavaError)) throw e;
        unclear =
          e.kind === 'not_configured' ? 'not_configured' : 'unreachable';
        if (e.kind === 'not_configured' || e.kind === 'auth') {
          return { state: 'unknown', why: unclear };
        }
      }
    }
    if (sender) {
      const has = (t: FintavaTransaction) =>
        [t.customerReference, t.fintavaReference, t.tagapayTransRef].some(
          (v) => v !== null && refs.includes(v),
        );
      const sameAmount: FintavaTransaction[] = [];
      try {
        for (let page = 1; page <= LEDGER_DEFAULTS.historyPages; page += 1) {
          const rows =
            sender.kind === 'merchant'
              ? await this.fintava.getMerchantHistory({
                  page,
                  take: 100,
                  order: 'DESC',
                })
              : await this.fintava.getCustomerHistory({
                  customerId: sender.customerId,
                  page,
                  take: 100,
                });
          const hit = rows.items.find(has);
          if (hit) {
            return {
              state: 'found',
              transaction: hit,
              tagapayTransRef: await this.tagapayOf(hit),
            };
          }
          for (const t of rows.items) {
            const when = Date.parse(t.createdAt);
            if (
              t.amountKobo === amountKobo &&
              t.tagapayTransRef === null &&
              Math.abs(when - around.getTime()) < 24 * 60 * MINUTE
            ) {
              sameAmount.push(t);
            }
          }
          if (!rows.hasNextPage || rows.items.length === 0) break;
        }
        // Nearest in time first: history is not sorted the same way for
        // customers and for WAWU (`sandbox/09-`, `10-`).
        sameAmount.sort(
          (x, y) =>
            Math.abs(Date.parse(x.createdAt) - around.getTime()) -
            Math.abs(Date.parse(y.createdAt) - around.getTime()),
        );
        for (const t of sameAmount.slice(0, LEDGER_DEFAULTS.byIdChecks)) {
          const l = await this.fintava.getTransactionById(t.id);
          if (l.state === 'found' && has(l.transaction)) {
            return {
              state: 'found',
              transaction: l.transaction,
              tagapayTransRef: l.transaction.tagapayTransRef,
            };
          }
          if (l.state === 'unknown') unclear = unclear || 'empty_lookup';
        }
      } catch (e) {
        if (!(e instanceof FintavaError)) throw e;
        unclear = 'unreachable';
      }
    }
    return unclear ? { state: 'unknown', why: unclear } : { state: 'absent' };
  }
}
