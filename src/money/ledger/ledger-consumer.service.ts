import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  type LedgerParty,
  type LedgerWebhookMovement,
  type LedgerWebhookReversal,
  type ProviderHolder,
  type ProviderMovementConfirmation,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
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
import { LedgerStatusService } from './ledger-status.service';
import { LedgerService } from './ledger.service';

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

/** A party that is one of WAWU's wallets. */
interface OurWallet {
  wallet: LedgerWallet;
  /** The provider's customerId, for the person's history; null on the merchant wallet. */
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
 *
 * Through the wallet provider seam (MONEY-20): the deliveries' events and
 * payload format are the provider's (`provider.deliveries`, Fintava's in
 * src/fintava/fintava-ledger-delivery.ts), and so is the confirmation walk
 * (`provider.confirmMovement`). This file keeps the ledger's own rules.
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
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    config: ConfigService,
    private readonly status: LedgerStatusService,
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
          event: { in: [...this.provider.deliveries.ledgerEvents] },
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
      !this.provider.deliveries.ledgerEvents.includes(event.event)
    ) {
      return 'skipped';
    }
    const reading = this.provider.deliveries.read(
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
      if (e instanceof RangeError) {
        // A figure the ledger cannot hold exactly. The reader refuses these
        // before any Fintava call; this is the backstop, so a delivery never
        // stays pending for ever on one.
        outcome = await this.finish(event.id, () => ({
          status: 'failed',
          note: `ledger: ${e.message}`,
        }));
      } else if (e instanceof MerchantAccountUnknown) {
        outcome = await this.wait(
          event.id,
          `ledger: WAWU's merchant account number could not be read from ${this.provider.label}; tried again on the next sweep`,
        );
      } else {
        throw e;
      }
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
    const fromParty = m.from;
    const toParty = m.to;
    const from = await this.resolve(fromParty);
    const to = await this.resolve(toParty);
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
    // Fintava's own record of the movement has another amount than the
    // delivery: a stop (WORKFLOW section 10). The rows are written with the
    // delivery's figures, left `pending`, and the difference goes on their
    // `discrepancy` (MONEY-08 round 2; it used to settle them and say so
    // only in the delivery's note).
    let disagreement: string | null = null;

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
        status = t.outcome ?? status;
        // Only a sender of ours wrote the record's CustomerReference.
        named.customerReference = from ? t.ourReference : null;
        named.fintavaReference = t.providerReference;
        named.tagapayTransRef = c.secondaryReference ?? t.secondaryReference;
        named.fintavaTransactionId = t.id;
        occurredAt = Number.isNaN(Date.parse(t.createdAt))
          ? null
          : new Date(t.createdAt);
        notes.push(`confirmed with ${this.provider.label}`);
        if (t.amountKobo !== BigInt(m.amountKobo)) {
          disagreement = `${this.provider.label}'s record says ${t.amountKobo} kobo, the delivery ${m.amountKobo}`;
          notes.push(disagreement, 'left pending for review');
        }
      } else if (c.state === 'unknown' && age < this.confirmWindowMs) {
        return this.wait(
          event.id,
          `ledger: waiting for ${this.provider.label} to confirm (${c.why}); tried again on the next sweep`,
        );
      } else {
        notes.push(
          c.state === 'absent'
            ? `recorded from the signed delivery: ${this.provider.label} does not find it by these references`
            : `recorded from the signed delivery: ${this.provider.label} could not confirm it within the window`,
        );
      }
    }
    // A wallet-to-wallet delivery reports no status but the balances after
    // the move; a bank send without a status is still on its way. A send to
    // a bank account is the only movement whose receiver is a bank account
    // (Fintava's `customer_bank_transfer`), so the rule reads that, not the
    // provider's event name (MONEY-20).
    const final: TransferStatus = disagreement
      ? 'pending'
      : (status ?? (m.to?.where === 'bank_account' ? 'pending' : 'completed'));

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
        if (disagreement) {
          await this.ledger.noteDiscrepancy(
            r.entryId,
            `webhook sighting: ${disagreement}`,
            tx,
          );
        }
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
            t.ourReference,
            t.providerReference,
            c.secondaryReference,
            t.secondaryReference,
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
        if (res.state === 'disagrees') {
          // A stop: the difference is on the debit's row for review
          // (MONEY-16); the delivery itself has been read in full.
          return {
            status: 'processed',
            note: `ledger: debit ${res.entryId} not reversed: the reversal disagrees with it, recorded on the row (review)`,
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
  // Reconciling one pending row with Fintava (history and lookup)
  // -------------------------------------------------------------------------

  /**
   * Asks Fintava about one `pending` row: MONEY-08's status check
   * (LedgerStatusService.check), which this used to duplicate. What Fintava
   * found settles the row (status forward only, references filled), unless
   * its amount differs, which is recorded on the row and settles nothing.
   * Fintava having no record of one of our sends, past the resend window,
   * fails the row with no money moved; anything unclear changes nothing.
   */
  async reconcileEntry(entryId: string): Promise<{
    state: 'found' | 'absent' | 'unknown' | 'skipped';
    status: TransferStatus | null;
  }> {
    const c = await this.status.check(entryId);
    if (c.fintava === null) return { state: 'skipped', status: null };
    return {
      state: c.fintava,
      status:
        c.fintava === 'found' || c.outcome === 'failed_absent'
          ? c.status
          : null,
    };
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
    const text = note.slice(0, 1000);
    // Written only when it changes: a delivery retried with the same reason
    // (Fintava not configured, say) leaves its row alone.
    await this.prisma.fintavaWebhookEvent.updateMany({
      where: {
        id: eventId,
        processingStatus: 'pending',
        OR: [{ note: null }, { note: { not: text } }],
      },
      data: { note: text },
    });
    return 'waiting';
  }

  /** 1, 2, 4 ... minutes, at most an hour, between tries of a waiting delivery. */
  private backOff(eventId: string, now: Date): void {
    const prev = this.retryAt.get(eventId);
    const delayMs = Math.min(prev ? prev.delayMs * 2 : MINUTE, 60 * MINUTE);
    this.retryAt.set(eventId, { at: now.getTime() + delayMs, delayMs });
  }

  /** WAWU's merchant account number, read from the provider once per process. */
  private async merchantAccount(): Promise<string> {
    if (this.merchantAccountNumber) return this.merchantAccountNumber;
    if (!this.provider.configured) {
      throw new MerchantAccountUnknown();
    }
    try {
      const m = await this.provider.getPlatformAccount();
      this.merchantAccountNumber = m.accountNumber;
      return m.accountNumber;
    } catch (e) {
      if (e instanceof WalletProviderError) throw new MerchantAccountUnknown();
      throw e;
    }
  }

  /**
   * The WAWU wallet a party is, if any. A NUBAN is unique only within its
   * bank, so an account number alone never names a WAWU wallet unless the
   * delivery puts that account at Fintava:
   * - a party the delivery names with Fintava's customerId is found by that
   *   id and nothing else (an id that is not ours is not ours);
   * - a `bank_account` is a WAWU wallet only when its bank code is
   *   the provider's own (`provider.walletBankCode`, Fintava's 090620);
   *   otherwise it is someone at another bank, never a WAWU user, whatever
   *   its number;
   * - a `provider_wallet` (or a `bank_account` at the provider's bank) is found by
   *   its account numbers, in the order the delivery gives them, among the
   *   people's wallets and then WAWU's merchant wallet.
   */
  private async resolve(party: LedgerParty | null): Promise<OurWallet | null> {
    if (!party) return null;
    if (party.where === 'merchant') {
      return {
        wallet: {
          kind: 'merchant',
          accountNumber: await this.merchantAccount(),
        },
        customerId: null,
      };
    }
    const select = { wawuUserId: true, accountNumber: true, customerId: true };
    const ours = (w: {
      wawuUserId: string;
      accountNumber: string;
      customerId: string;
    }): OurWallet => ({
      wallet: {
        kind: 'user',
        wawuUserId: w.wawuUserId,
        accountNumber: w.accountNumber,
      },
      customerId: w.customerId,
    });
    if (party.customerId) {
      const w = await this.prisma.fintavaWallet.findUnique({
        where: { customerId: party.customerId },
        select,
      });
      return w ? ours(w) : null;
    }
    if (
      party.where === 'bank_account' &&
      party.bankCode !== this.provider.walletBankCode
    ) {
      return null;
    }
    for (const accountNumber of party.accountNumbers) {
      const w = await this.prisma.fintavaWallet.findUnique({
        where: { accountNumber },
        select,
      });
      if (w) return ours(w);
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

  private senderOf(from: OurWallet | null): ProviderHolder | null {
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

  /**
   * What the provider knows about a movement named by these references:
   * the provider's own walk (Fintava: the lookup by each reference, then,
   * for a sender of ours, its history, and rows of the same amount read by
   * id), through the seam (MONEY-20).
   */
  private confirm(
    references: readonly string[],
    sender: ProviderHolder | null,
    amountKobo: number,
    around: Date,
  ): Promise<ProviderMovementConfirmation> {
    return this.provider.confirmMovement({
      references,
      sender,
      amountKobo,
      around,
      limits: {
        historyPages: LEDGER_DEFAULTS.historyPages,
        byIdChecks: LEDGER_DEFAULTS.byIdChecks,
      },
    });
  }
}
