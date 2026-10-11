import { randomBytes } from 'node:crypto';
import { signNuvionDelivery } from '../../src/nuvion/webhook/nuvion-signature';
import {
  type NuvionAccountsStandin,
  type StandinAccount,
  standinId,
} from './accounts-standin';
import {
  envelope,
  errorBody,
  type NuvionStandin,
  type StandinAnswer,
  type StandinRequest,
} from './nuvion-standin';

/**
 * NUV-05's routes on the Nuvion stand-in (NUV-01's `NuvionStandin`, through
 * its `on(...)`, over NUV-04's accounts): book transfers, from Nuvion's own
 * docs (the lead's scratchpad `nuvion/docs/api-reference__transfers.md`,
 * `core-concepts__accounts.md`, `webhooks__event-types.md`, `errors.md`),
 * as the MONEY-17 seam stand-in (`test/payments/nuvion-seam-standin.ts`)
 * models them for the services, now over a real socket:
 *
 * - **WAWU's operational account** is an account of the parent entity, of
 *   type `operational`, read without an `entity_id`. A person's account is a
 *   child entity's `checking` account, read and debited with `entity_id`.
 * - `POST /transfers` with `payment_type: "book-transfer"`: the receiver
 *   named by `nuvion_ban` (the dashboard code's field; the public docs route
 *   a book transfer through `POST /payment-details`, which stays for the
 *   sandbox to settle: BACKEND_GAPS G-440), `unique_reference` at most 64
 *   characters and `narration` at most 100. "All transfers are
 *   asynchronous": the answer is `pending` by default (`mode`), then the
 *   transfer becomes `successful` (the receiver is credited), `failed` (the
 *   payer is given back) or later `reversed`. A repeated `unique_reference`
 *   for the account returns the ORIGINAL transfer: as a `409` carrying it
 *   (`duplicateAs: "409"`, the transfers page's error table) or as a `2xx`
 *   (`duplicateAs: "original"`, its parameter text); the same reference with
 *   other parameters is `409 error_idempotency_key_mismatch`.
 *   `applicable_fee` is charged to the payer on top of the amount.
 * - `GET /transfers/{id}` (a child's with its `entity_id`) and `GET
 *   /transfers` (`entity_id`, `account_id`, `status`, `limit`, `cursor`;
 *   newest first, each row carrying its `unique_reference`). There is NO
 *   lookup by our reference.
 * - Signed deliveries (`delivery`): `outflows.created`, `.completed`,
 *   `.failed`, `.cancelled` and `.refunded` in the docs' payload shape.
 *
 * A test double: no host is called, nothing is real money. Its fee and its
 * balances are the double's own; the adapter and the services never read
 * them as facts.
 */

export type BookMode =
  /** Accepted: the answer says `pending` and the transfer stays so until `settle`. */
  | 'pending'
  /** Accepted: the answer says `processing`. */
  | 'processing'
  /** Accepted and `successful` in the answer. */
  | 'successful'
  /** Accepted: `pending` in the answer, `successful` on the first read after `settleAfterMs`. */
  | 'pending_then_successful';

export type StandinBookStatus =
  'pending' | 'processing' | 'successful' | 'failed' | 'reversed';

export interface StandinBookTransfer extends Record<string, unknown> {
  id: string;
  entity_id: string;
  account_id: string;
  amount: number;
  applicable_fee: number;
  status: StandinBookStatus;
  status_reason: string;
  unique_reference: string;
  payment_type: 'book-transfer';
  type: 'outflow';
  currency: 'NGN';
  narration: string;
  created: number;
  updated: number;
}

interface Internal {
  transfer: StandinBookTransfer;
  toAccountId: string;
  /** When a `pending_then_successful` transfer finishes (ms), or null. */
  settleAt: number | null;
}

export class NuvionBookStandin {
  /** The parent entity (WAWU's) and its operational account. */
  readonly parentEntityId = standinId('01ENT');
  readonly operational: StandinAccount;
  private readonly transfers: Internal[] = [];
  private personSeq = 0;
  /** Every `POST /transfers` body, in order. */
  readonly createRequests: Array<Record<string, unknown>> = [];
  /** What the next transfers do. */
  mode: BookMode = 'pending';
  /** For `pending_then_successful`. */
  settleAfterMs = 200;
  /** How a repeated reference is answered. */
  duplicateAs: '409' | 'original' = '409';
  /** Nuvion's `applicable_fee` on a book transfer, in kobo (the owner's settings, NUV-10). */
  feeKobo: (amountKobo: number) => number = () => 0;
  /** Another amount than asked is moved (a stop for review). */
  extraKobo = 0;
  /** The `status_reason` of a transfer that `settle` fails. */
  failReason = 'compliance_hold';
  /** What happens to the answer of the next creates (consumed one per new transfer). */
  private readonly plans: Array<{
    created: boolean;
    answer: StandinAnswer;
  }> = [];

  constructor(
    readonly standin: NuvionStandin,
    readonly accounts: NuvionAccountsStandin,
  ) {
    this.operational = accounts.addAccount(this.parentEntityId, {
      type: 'operational',
      display_name: 'WAWU Operational',
      nuvion_ban: 'NVXYT1GUCM',
    });
  }

  /** A person's entity and naira account holding `kobo`; their NGN account number. */
  openPerson(kobo: number, accountNumber: string): StandinAccount {
    const entityId = standinId('01ENT');
    this.personSeq += 1;
    const a = this.accounts.addAccount(entityId, {
      // Unique, whatever the clock says (two people made in one millisecond).
      nuvion_ban: `NVN${String(this.personSeq).padStart(7, '0')}`,
      balance: { available: kobo, current: kobo, overdraft_used: 0 },
    });
    // The account details (the number people send to) are NUV-04's; the book
    // transfer does not read them.
    void accountNumber;
    return a;
  }

  /** Funds WAWU's operational account. */
  fundOperational(kobo: number): void {
    this.operational.balance.available = kobo;
    this.operational.balance.current = kobo;
  }

  availableOf(accountId: string): number {
    this.applyDue();
    return Number(this.accounts.accounts.get(accountId)!.balance.available);
  }

  all(): StandinBookTransfer[] {
    this.applyDue();
    return this.transfers.map((t) => t.transfer);
  }

  byReference(reference: string): StandinBookTransfer[] {
    return this.all().filter((t) => t.unique_reference === reference);
  }

  byId(id: string): StandinBookTransfer | undefined {
    return this.all().find((t) => t.id === id);
  }

  /** Moves a transfer Nuvion holds to its next status, as Nuvion's processing would. */
  settle(
    idOrReference: string,
    status: 'successful' | 'failed' | 'reversed' | 'processing',
  ): StandinBookTransfer {
    const t = this.transfers.find(
      (x) =>
        x.transfer.id === idOrReference ||
        x.transfer.unique_reference === idOrReference,
    );
    if (!t) throw new Error(`stand-in: no transfer ${idOrReference}`);
    this.move(t, status);
    return t.transfer;
  }

  private account(id: string): StandinAccount {
    const a = this.accounts.accounts.get(id);
    if (!a) throw new Error(`stand-in: no account ${id}`);
    return a;
  }

  private bump(a: StandinAccount, by: number): void {
    a.balance.available = Number(a.balance.available) + by;
    a.balance.current = Number(a.balance.current ?? a.balance.available) + by;
    a.updated = Date.now();
  }

  private move(i: Internal, to: StandinBookStatus): void {
    const t = i.transfer;
    const from = t.status;
    if (from === to) return;
    const payer = this.account(t.account_id);
    const payee = this.account(i.toAccountId);
    const unfinished = from === 'pending' || from === 'processing';
    const total = t.amount + t.applicable_fee;
    if (to === 'successful' && unfinished) {
      this.bump(payee, t.amount);
    } else if (to === 'failed' && unfinished) {
      this.bump(payer, total);
    } else if (to === 'reversed' && from === 'successful') {
      this.bump(payee, -t.amount);
      this.bump(payer, total);
    } else if (to !== 'processing') {
      throw new Error(`stand-in: ${from} cannot become ${to}`);
    }
    t.status = to;
    t.status_reason =
      to === 'failed'
        ? this.failReason
        : to === 'successful'
          ? 'processing_complete'
          : to === 'reversed'
            ? 'reversed_by_nuvion'
            : 'processing';
    t.updated = Date.now();
    i.settleAt = null;
  }

  /** Finishes the `pending_then_successful` transfers whose time has come. */
  private applyDue(): void {
    const now = Date.now();
    for (const i of this.transfers) {
      if (i.settleAt !== null && i.settleAt <= now) this.move(i, 'successful');
    }
  }

  /** The body of a signed delivery of `event` for a transfer, as Nuvion sends it. */
  delivery(
    secret: string,
    event: string,
    transfer: StandinBookTransfer | Record<string, unknown>,
    eventId: string = standinId('01EVT'),
  ): { eventId: string; timestamp: string; raw: string; signature: string } {
    const raw = JSON.stringify({ event, data: transfer });
    const timestamp = new Date().toISOString();
    return {
      eventId,
      timestamp,
      raw,
      signature: signNuvionDelivery(secret, timestamp, Buffer.from(raw)),
    };
  }

  install(): this {
    const s = this.standin;
    s.on('GET', /^\/accounts\/[A-Za-z0-9]+$/, (req) => {
      this.applyDue();
      const a = this.accounts.accounts.get(req.path.split('/')[2]);
      const operational = a?.id === this.operational.id;
      if (
        !a ||
        (operational
          ? req.query.entity_id !== undefined &&
            req.query.entity_id !== this.parentEntityId
          : a.entity_id !== req.query.entity_id)
      ) {
        return {
          status: 404,
          body: errorBody(
            'error_resource_not_found',
            'Resource does not exist',
          ),
        };
      }
      return {
        status: 200,
        body: envelope(
          {
            account: a,
            entity: {
              id: a.entity_id,
              type: operational ? 'business' : 'individual',
              verification_status: 'approved',
            },
            account_details: [],
          },
          'Account retrieved successfully',
        ),
      };
    });
    s.on('POST', '/transfers', (req) => this.create(req));
    s.on('GET', /^\/transfers\/[A-Za-z0-9]+$/, (req) => {
      this.applyDue();
      const i = this.transfers.find(
        (x) => x.transfer.id === req.path.split('/')[2],
      );
      if (!i || !this.mayRead(i.transfer, req)) {
        return {
          status: 404,
          body: errorBody(
            'error_resource_not_found',
            'Resource does not exist',
          ),
        };
      }
      return {
        status: 200,
        body: envelope(i.transfer, 'Transfer retrieved successfully'),
      };
    });
    s.on('GET', '/transfers', (req) => this.list(req));
    return this;
  }

  /** A child's transfer is read with its `entity_id`; the parent's without one. */
  private mayRead(t: StandinBookTransfer, req: StandinRequest): boolean {
    const parent = t.entity_id === this.parentEntityId;
    const asked = req.query.entity_id;
    return parent
      ? asked === undefined || asked === this.parentEntityId
      : asked === t.entity_id;
  }

  private list(req: StandinRequest): StandinAnswer {
    this.applyDue();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20)));
    const askedEntity = req.query.entity_id ?? this.parentEntityId;
    let rows = this.transfers
      .map((i) => i.transfer)
      .filter((t) => t.entity_id === askedEntity)
      .filter(
        (t) => !req.query.account_id || t.account_id === req.query.account_id,
      )
      .filter((t) => !req.query.status || t.status === req.query.status)
      .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    if (req.query.cursor) {
      const at = rows.findIndex((t) => t.id === req.query.cursor);
      rows = at < 0 ? [] : rows.slice(at + 1);
    }
    const page = rows.slice(0, limit);
    const hasNext = rows.length > limit;
    return {
      status: 200,
      body: envelope(
        {
          data: page,
          meta: {
            pagination: {
              order: 'desc',
              has_next: hasNext,
              limit,
              has_previous: false,
              next_cursor: hasNext ? page[page.length - 1].id : null,
              previous_cursor: null,
            },
          },
        },
        'Transfers retrieved successfully',
      ),
    };
  }

  private create(req: StandinRequest): StandinAnswer {
    this.applyDue();
    const b = (req.body ?? {}) as Record<string, unknown>;
    this.createRequests.push(b);
    const bad = (message: string): StandinAnswer => ({
      status: 422,
      body: errorBody('error_validation_failed', message),
    });
    const accountId = typeof b.account_id === 'string' ? b.account_id : '';
    const payer = this.accounts.accounts.get(accountId);
    if (!payer) {
      return {
        status: 404,
        body: errorBody('error_resource_not_found', 'Resource does not exist'),
      };
    }
    const operational = payer.id === this.operational.id;
    const entity = typeof b.entity_id === 'string' ? b.entity_id : null;
    if (
      operational
        ? entity !== null && entity !== this.parentEntityId
        : entity !== payer.entity_id
    ) {
      return bad('entity_id: does not match the account');
    }
    if (b.payment_type !== 'book-transfer') {
      return bad('payment_type: expected book-transfer');
    }
    if (b.currency !== 'NGN' || payer.currency !== 'NGN') {
      return bad('currency: expected NGN');
    }
    const reference = b.unique_reference;
    if (
      typeof reference !== 'string' ||
      reference.length < 1 ||
      reference.length > 64
    ) {
      return bad('unique_reference: 1 to 64 characters');
    }
    const narration = b.narration;
    if (
      typeof narration !== 'string' ||
      narration.length < 1 ||
      narration.length > 100
    ) {
      return bad('narration: 1 to 100 characters');
    }
    const amount = b.amount;
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount < 1
    ) {
      return bad('amount: a whole number above zero');
    }
    const ban = typeof b.nuvion_ban === 'string' ? b.nuvion_ban : '';
    const payee = [...this.accounts.accounts.values()].find(
      (a) => a.nuvion_ban === ban,
    );
    if (!payee) {
      return {
        status: 404,
        body: errorBody('error_resource_not_found', 'Resource does not exist'),
      };
    }
    // The reference is unique for the account: the original comes back.
    const original = this.transfers.find(
      (x) =>
        x.transfer.account_id === payer.id &&
        x.transfer.unique_reference === reference,
    );
    if (original) {
      if (
        original.transfer.amount !== amount ||
        original.toAccountId !== payee.id
      ) {
        return {
          status: 409,
          body: errorBody(
            'error_idempotency_key_mismatch',
            'Idempotency key reused with different parameters',
          ),
        };
      }
      return this.duplicateAnswer(original.transfer);
    }
    const moved = amount + this.extraKobo;
    const fee = this.feeKobo(amount);
    if (Number(payer.balance.available) < moved + fee) {
      return {
        status: 422,
        body: errorBody(
          'error_transfer_insufficient_funds',
          "You don't have enough funds for this transfer.",
        ),
      };
    }
    const plan = this.plans.shift();
    // The answer is lost or a system error before Nuvion made anything.
    if (plan && !plan.created) return plan.answer;
    const now = Date.now();
    const status: StandinBookStatus =
      this.mode === 'successful'
        ? 'successful'
        : this.mode === 'processing'
          ? 'processing'
          : 'pending';
    const t: StandinBookTransfer = {
      id: standinId('01TRF'),
      amount: moved,
      currency: 'NGN',
      unique_reference: reference,
      counterparty_id: standinId('01CPY'),
      account_id: payer.id,
      entity_id: payer.entity_id,
      status: 'pending',
      status_reason: 'awaiting_processing',
      narration,
      type: 'outflow',
      payment_type: 'book-transfer',
      applicable_fee: fee,
      meta: {},
      account: { id: payer.id, display_name: payer.display_name },
      created: now,
      updated: now,
    };
    const internal: Internal = {
      transfer: t,
      toAccountId: payee.id,
      settleAt:
        this.mode === 'pending_then_successful'
          ? now + this.settleAfterMs
          : null,
    };
    this.transfers.push(internal);
    // Accepted: the amount and the fee leave `available` now; the receiver is
    // credited when the transfer succeeds.
    this.bump(payer, -(moved + fee));
    // A `pending` answer is the transfer as it stood when accepted.
    const answered = { ...t };
    if (status !== 'pending') {
      this.move(
        internal,
        status === 'processing' ? 'processing' : 'successful',
      );
    }
    // Made, but the answer is lost or a system error (Nuvion did take it).
    if (plan) return plan.answer;
    return {
      status: 201,
      body: envelope(
        status === 'pending' ? answered : { ...t },
        'Transfer created successfully',
      ),
    };
  }

  private duplicateAnswer(t: StandinBookTransfer): StandinAnswer {
    if (this.duplicateAs === 'original') {
      return {
        status: 200,
        body: envelope({ ...t }, 'Transfer already exists'),
      };
    }
    return {
      status: 409,
      body: {
        ...errorBody(
          'error_duplicate_resource',
          'A transfer with this unique_reference already exists.',
        ),
        data: { ...t },
      },
    };
  }

  /**
   * The next new transfer is taken by Nuvion (it exists, the payer is
   * debited) but the answer never reaches the caller: the socket is closed.
   */
  loseAnswerNext(created = true): this {
    this.plans.push({
      created,
      answer: { status: 0, hangUp: true },
    });
    return this;
  }

  /** The next new transfer is answered with a system error, made or not. */
  systemErrorNext(opts: {
    created: boolean;
    status?: 500 | 503 | 504;
    type?: string;
  }): this {
    this.plans.push({
      created: opts.created,
      answer: {
        status: opts.status ?? 503,
        body: errorBody(opts.type ?? 'error_system_service_unavailable'),
      },
    });
    return this;
  }
}

/** A fresh event id as Nuvion's are: 26 characters. */
export function newEventId(): string {
  return `01EVT${randomBytes(10).toString('hex').toUpperCase()}`.slice(0, 26);
}
