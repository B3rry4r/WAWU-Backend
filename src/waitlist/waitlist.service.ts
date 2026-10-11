import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { WaitlistRegistration } from '../../generated/prisma/client';
import { WaitlistStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
  type FlutterwaveVerifyResult,
} from '../content-piece/flutterwave-client.interface';
import {
  type EventOffer,
  INT4_MAX,
  PLANS_CONFIG,
  type PlansConfig,
} from '../plans/plans-config';
import type {
  AdminWaitlistListQueryDto,
  CreateWaitlistRegistrationDto,
  VerifyWaitlistRegistrationDto,
} from './dto/waitlist.dto';
import {
  accessCodeLabel,
  firstNameOf,
  maskPhone,
  normaliseEmail,
  normalisePhone,
} from './waitlist-contact';
import {
  NAME_MAX,
  NAME_MIN,
  REFERENCE_ATTEMPTS,
  REFERENCE_BYTES,
  REFERENCE_PREFIX,
  SHORT_TEXT_MAX,
} from './waitlist-config';
import { WaitlistError } from './waitlist-error';
import {
  type RandomBytes,
  systemRandom,
  WAITLIST_RANDOM,
} from './waitlist-random';
import {
  WAITLIST_PAYMENT_LOOKUP,
  type WaitlistPaymentLookup,
} from './waitlist-payment-lookup';
import type {
  AdminWaitlistRegistrationView,
  WaitlistOfferView,
  WaitlistRegistrationStartView,
  WaitlistRegistrationStatusView,
} from './waitlist-view.type';

const KOBO_PER_NAIRA = 100;

/** Prisma's unique-constraint refusal (P2002). */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Flutterwave quotes naira with up to two decimals; this is that amount in
 * whole kobo, or null when it is not a whole number of kobo (or is negative,
 * not a number, or too big to store). Integer maths after one rounding, never
 * a float comparison.
 */
export function koboOf(naira: number): number | null {
  if (typeof naira !== 'number' || !Number.isFinite(naira) || naira < 0)
    return null;
  const kobo = Math.round(naira * KOBO_PER_NAIRA);
  if (Math.abs(naira * KOBO_PER_NAIRA - kobo) > 1e-6) return null;
  return kobo > INT4_MAX ? null : kobo;
}

/** Trimmed text, with runs of white space made single, or null when empty. */
function tidy(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/**
 * Whether `v` holds a control character: anything below U+0020, a NUL byte
 * included, with no exception (a tab or a line break is one too). Postgres
 * refuses a NUL in text outright, and no field of the form has a use for the
 * rest.
 */
function hasControlChar(v: string | undefined): boolean {
  if (v === undefined) return false;
  for (let i = 0; i < v.length; i += 1) if (v.charCodeAt(i) < 0x20) return true;
  return false;
}

/** The shape of every reference this server issues (REFERENCE_PREFIX plus 2 * REFERENCE_BYTES lower-case hex digits). */
const REFERENCE_SHAPE = new RegExp(
  `^${REFERENCE_PREFIX}[0-9a-f]{${REFERENCE_BYTES * 2}}$`,
);

/** A reference: random, at least 128 bits, safe to put in a URL. */
export function newReference(random: RandomBytes = systemRandom): string {
  return `${REFERENCE_PREFIX}${random(REFERENCE_BYTES).toString('hex')}`;
}

/**
 * THE EVENT REGISTRATION LINK (JOIN-01, R-48): a person at a WAWU event
 * registers on the website and pays the event fee by Flutterwave checkout.
 * It is a waiting list, not an account: nothing here creates, reads or
 * writes a WAWU ID account. Turning a paid registration into a plan is
 * JOIN-03's claim in the app (WaitlistClaimService, a signed-in route); this
 * service never writes `claimedByWawuId` or `claimedAt`.
 *
 * ── THE MONEY PATH ───────────────────────────────────────────────────────
 * Register writes a `pending` row (the price copied onto it), answers the
 * checkout settings and grants nothing. A payment counts only after the
 * server has asked Flutterwave itself, and only if Flutterwave says it
 * succeeded, carries THIS row's reference, was paid in naira and was not
 * less than the fee. A payment that fails any of those leaves the row
 * `pending` and is refused. The same checks run whoever brings the payment:
 * the browser's verify call, Flutterwave's webhook, or the sweep
 * (WaitlistSweepService) that finds payers who never came back.
 *
 * ── WHAT THE DATABASE KEEPS TRUE ─────────────────────────────────────────
 * A transaction id is unique, so it pays for one row once. At most one row
 * per offer and phone, and per offer and email, is `paid` (partial unique
 * indexes), so two payments racing for the same person leave one
 * registration. The second payer has still been charged: that row is kept
 * as `failed`, with its transaction id and amount, so it can be refunded.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly plans: PlansConfig,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
    @Inject(WAITLIST_PAYMENT_LOOKUP)
    private readonly lookup: WaitlistPaymentLookup,
    @Inject(WAITLIST_RANDOM)
    private readonly random: RandomBytes = systemRandom,
  ) {}

  // ---- the offer ----------------------------------------------------------

  /** Whether `offer` is open at `now`: after `openFrom`, and before `openUntil` when it has one. */
  private isOpen(offer: EventOffer, now: Date): boolean {
    return (
      offer.openFrom <= now &&
      (offer.openUntil === null || now <= offer.openUntil)
    );
  }

  /** The offers open at `now`, the one closing soonest first (one with no closing date last). */
  private openOffers(now: Date): EventOffer[] {
    return this.plans.eventOffers
      .filter((o) => this.isOpen(o, now))
      .sort(
        (a, b) =>
          (a.openUntil?.getTime() ?? Infinity) -
          (b.openUntil?.getTime() ?? Infinity),
      );
  }

  private offerView(offer: EventOffer): WaitlistOfferView {
    const tier = this.plans.tiers.find((t) => t.id === offer.tier)!;
    return {
      id: offer.id,
      name: offer.name,
      priceKobo: offer.priceKobo,
      tierName: tier.name,
      products: tier.products,
      days: offer.tierDays,
      closesAt: offer.openUntil === null ? null : offer.openUntil.toISOString(),
    };
  }

  /** GET /waitlist/offers/current. */
  currentOffer(now: Date = new Date()): WaitlistOfferView {
    const open = this.openOffers(now)[0];
    if (!open)
      throw new WaitlistError(
        'no_open_offer',
        'There is no event registration open right now.',
      );
    return this.offerView(open);
  }

  // ---- register -----------------------------------------------------------

  /** POST /waitlist/registrations. */
  async register(
    dto: CreateWaitlistRegistrationDto,
    now: Date = new Date(),
  ): Promise<WaitlistRegistrationStartView> {
    const offer = this.plans.eventOffers.find((o) => o.id === dto.offerId);
    if (!offer)
      throw new WaitlistError(
        'no_open_offer',
        'There is no event registration open right now.',
      );
    if (!this.isOpen(offer, now))
      throw new WaitlistError(
        'offer_closed',
        now < offer.openFrom
          ? 'Registration for this event has not opened yet.'
          : 'Registration for this event is closed.',
      );

    if (dto.consent !== true)
      throw new WaitlistError(
        'consent_required',
        'Please accept the privacy notice to register.',
      );
    if (hasControlChar(dto.fullName))
      throw new WaitlistError(
        'name_invalid',
        'Your name has a character we cannot accept. Please type it again using letters and normal punctuation.',
      );
    const fullName = tidy(dto.fullName);
    if (
      fullName === null ||
      fullName.length < NAME_MIN ||
      fullName.length > NAME_MAX
    )
      throw new WaitlistError('name_invalid', 'Enter your full name.');
    const phone = normalisePhone(dto.phone);
    if (phone === null)
      throw new WaitlistError(
        'phone_invalid',
        'Enter a valid phone number. A Nigerian number can start with 0 or +234; any other number needs its country code.',
      );
    const email = hasControlChar(dto.email) ? null : normaliseEmail(dto.email);
    if (email === null)
      throw new WaitlistError('email_invalid', 'Enter a valid email address.');
    // No `reason.code` for these two: they are optional free text, and a
    // control character there is a malformed body (the 400 with no `reason`).
    if (hasControlChar(dto.state))
      throw new BadRequestException(
        'Your state has a character we cannot accept. Please type it again using letters and normal punctuation.',
      );
    if (hasControlChar(dto.makes))
      throw new BadRequestException(
        'What you make has a character we cannot accept. Please type it again using letters and normal punctuation.',
      );
    const state = tidy(dto.state)?.slice(0, SHORT_TEXT_MAX) ?? null;
    const makes = tidy(dto.makes)?.slice(0, SHORT_TEXT_MAX) ?? null;

    // Before any charge: this phone or email already paid for the offer.
    const paid = await this.prisma.waitlistRegistration.findFirst({
      where: {
        offerId: offer.id,
        status: WaitlistStatus.paid,
        OR: [{ phone }, { email }],
      },
      select: { id: true },
    });
    if (paid)
      throw new WaitlistError(
        'already_registered',
        'You are already registered for this event. You have not been charged again.',
      );

    // The checkout needs the public key; without it the page could not pay.
    const charge = this.flutterwave.initCharge({
      amount: offer.priceKobo / KOBO_PER_NAIRA,
      purpose: 'waitlist',
      wawuUserId: 'waitlist',
    });
    if (!charge.publicKey)
      throw new WaitlistError(
        'payments_unavailable',
        'Payments are not available right now. Please try again later.',
      );

    // Every start is a new registration with its own random reference, which
    // is the Flutterwave tx_ref of that one checkout. An unpaid row is never
    // reused, even for the same offer, phone and email: a reference that
    // came back for a second checkout would hold two transactions, and the
    // re-check, which finds a payment by its reference, could settle only
    // one of them and would never show the other. Unpaid rows pile up (the
    // throttle bounds it), the re-check walks each by its own reference, and
    // the purge deletes them after a week. When two of one person's checkouts
    // both succeed, the second to settle becomes `failed` and is kept for a
    // refund (settle and refuseDuplicate).
    //
    // The access code (the first 8 hex characters of the reference, upper
    // case) is unique across ALL registrations: the database computes it from
    // the reference and holds a unique index on it. A draw that lands on a
    // taken code is refused with a unique violation (nothing is written), and
    // a new reference is drawn, up to REFERENCE_ATTEMPTS times.
    let row: WaitlistRegistration | null = null;
    for (
      let attempt = 1;
      row === null && attempt <= REFERENCE_ATTEMPTS;
      attempt += 1
    ) {
      try {
        row = await this.prisma.waitlistRegistration.create({
          data: {
            offerId: offer.id,
            fullName,
            phone,
            email,
            state,
            makes,
            consentAt: now,
            reference: newReference(this.random),
            amountKobo: offer.priceKobo,
          },
        });
      } catch (e) {
        // The only unique keys a new row can meet are the reference and the
        // access code derived from it (its transaction id is empty).
        if (!isUniqueViolation(e)) throw e;
        this.logger.warn(
          `A new reference met a taken access code (draw ${attempt} of ${REFERENCE_ATTEMPTS}); drawing another`,
        );
      }
    }
    if (row === null)
      throw new ServiceUnavailableException(
        'We could not start your registration just now. Please try again in a moment.',
      );

    return {
      reference: row.reference,
      offerId: row.offerId,
      amountKobo: row.amountKobo,
      flutterwaveConfig: {
        publicKey: charge.publicKey,
        txRef: row.reference,
        amount: row.amountKobo / KOBO_PER_NAIRA,
        currency: 'NGN',
        customerName: row.fullName,
        customerEmail: row.email,
        customerPhone: row.phone,
      },
    };
  }

  // ---- status and verify --------------------------------------------------

  private statusView(
    row: WaitlistRegistration,
  ): WaitlistRegistrationStatusView {
    return {
      reference: row.reference,
      status: row.status,
      firstName: firstNameOf(row.fullName),
    };
  }

  private notFound(): WaitlistError {
    return new WaitlistError(
      'not_found',
      'We could not find that registration.',
    );
  }

  /** GET /waitlist/registrations/{reference}. */
  async status(reference: string): Promise<WaitlistRegistrationStatusView> {
    const row = await this.byReference(reference);
    if (!row) throw this.notFound();
    return this.statusView(row);
  }

  private byReference(reference: string): Promise<WaitlistRegistration | null> {
    // A reference this server never issues (wrong shape, or any character
    // outside it, a NUL byte included) is a miss without a query, so it is
    // answered exactly as an unknown reference is.
    if (!REFERENCE_SHAPE.test(reference)) return Promise.resolve(null);
    return this.prisma.waitlistRegistration.findUnique({
      where: { reference },
    });
  }

  /**
   * POST /waitlist/registrations/verify: the browser brings a transaction id.
   * Idempotent: a registration that is already paid answers the same result,
   * whatever transaction id comes with the call.
   */
  async verify(
    dto: VerifyWaitlistRegistrationDto,
  ): Promise<WaitlistRegistrationStatusView> {
    const row = await this.byReference(dto.reference);
    if (!row) throw this.notFound();
    if (row.status === WaitlistStatus.paid) return this.statusView(row);
    if (row.status === WaitlistStatus.failed) throw this.alreadyRegistered();

    // A transaction id pays for one registration once.
    const used = await this.prisma.waitlistRegistration.findUnique({
      where: { flutterwaveTxId: dto.transactionId },
      select: { id: true },
    });
    if (used && used.id !== row.id)
      throw new WaitlistError(
        'transaction_already_used',
        'That payment has already been used for another registration.',
      );

    let result: FlutterwaveVerifyResult;
    try {
      result = await this.flutterwave.verifyCharge({
        transactionId: dto.transactionId,
        txRef: row.reference,
      });
    } catch (e) {
      this.logger.warn(
        `Payment check failed for ${row.reference.slice(0, 18)}: ${e instanceof Error ? e.name : 'error'}`,
      );
      throw new WaitlistError(
        'payment_check_unavailable',
        'We could not check your payment just now. Please try again in a moment. You will not be charged twice.',
      );
    }
    return this.statusView(await this.settle(row, result, dto.transactionId));
  }

  /**
   * The webhook brings a delivery's reference and transaction id: the same
   * check as the browser's verify, settled the same way.
   */
  settleFromWebhook(
    reference: string,
    transactionId: string,
  ): Promise<WaitlistRegistrationStatusView> {
    return this.verify({ reference, transactionId });
  }

  /**
   * The verify-time refusal: this payment is a second one for a person who
   * is already registered, kept for a refund. They WERE charged, so the
   * sentence must not say otherwise (register's own refusal, before any
   * charge, does say so).
   */
  private alreadyRegistered(): WaitlistError {
    return new WaitlistError(
      'already_registered',
      "You're already registered. This extra payment will be refunded. Email support@wawuafrica.com with your reference.",
    );
  }

  /**
   * Marks a registration paid from what Flutterwave says, or refuses.
   * Flutterwave's word is checked, never the caller's: succeeded, this row's
   * reference, naira, and not less than the fee. A refusal leaves the row as
   * it was.
   */
  async settle(
    row: WaitlistRegistration,
    result: FlutterwaveVerifyResult,
    askedTransactionId: string,
    now: Date = new Date(),
  ): Promise<WaitlistRegistration> {
    if (row.status === WaitlistStatus.paid) return row;
    if (row.status === WaitlistStatus.failed) throw this.alreadyRegistered();
    if (result.status !== 'successful')
      throw new WaitlistError(
        'payment_not_confirmed',
        'We have not received confirmation of your payment yet. Please check again in a moment.',
      );
    const paidKobo = koboOf(result.amount);
    if (
      result.txRef !== row.reference ||
      result.currency !== row.currency ||
      paidKobo === null ||
      paidKobo < row.amountKobo
    ) {
      this.logger.warn(
        `Payment does not match registration ${row.reference.slice(0, 18)}`,
      );
      throw new WaitlistError(
        'payment_mismatch',
        'That payment does not match this registration. If you were charged, contact support with your reference.',
      );
    }
    const transactionId = result.transactionId || askedTransactionId;

    try {
      const claimed = await this.prisma.waitlistRegistration.updateMany({
        where: { id: row.id, status: WaitlistStatus.pending },
        data: {
          status: WaitlistStatus.paid,
          flutterwaveTxId: transactionId,
          paidKobo,
          paidAt: now,
        },
      });
      if (claimed.count === 0) {
        // Another call settled it first: answer what it did.
        const current = await this.prisma.waitlistRegistration.findUnique({
          where: { id: row.id },
        });
        if (current?.status === WaitlistStatus.paid) return current;
        throw this.alreadyRegistered();
      }
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return this.refuseDuplicate(row, transactionId, paidKobo);
    }
    this.logger.log(
      `Registration ${row.reference.slice(0, 18)} paid (phone ${maskPhone(row.phone)})`,
    );
    return this.prisma.waitlistRegistration.findUniqueOrThrow({
      where: { id: row.id },
    });
  }

  /**
   * The paid write hit a unique key: this transaction id already paid for
   * another row, or this person (offer plus phone, or offer plus email)
   * already has a paid registration. Only the second leaves money to keep a
   * record of: the payer was charged, so the row is kept `failed` with the
   * transaction id and amount, for a refund.
   */
  private async refuseDuplicate(
    row: WaitlistRegistration,
    transactionId: string,
    paidKobo: number,
  ): Promise<never> {
    const holder = await this.prisma.waitlistRegistration.findUnique({
      where: { flutterwaveTxId: transactionId },
      select: { id: true },
    });
    if (holder && holder.id !== row.id)
      throw new WaitlistError(
        'transaction_already_used',
        'That payment has already been used for another registration.',
      );
    await this.prisma.waitlistRegistration.updateMany({
      where: { id: row.id, status: WaitlistStatus.pending },
      data: {
        status: WaitlistStatus.failed,
        flutterwaveTxId: transactionId,
        paidKobo,
      },
    });
    this.logger.warn(
      `Second payment for a registered person kept for refund: ${row.reference.slice(0, 18)} (phone ${maskPhone(row.phone)})`,
    );
    throw this.alreadyRegistered();
  }

  // ---- admin --------------------------------------------------------------

  private adminView(row: WaitlistRegistration): AdminWaitlistRegistrationView {
    return {
      id: row.id,
      offerId: row.offerId,
      fullName: row.fullName,
      phone: row.phone,
      email: row.email,
      state: row.state,
      makes: row.makes,
      status: row.status,
      amountKobo: row.amountKobo,
      paidKobo: row.paidKobo,
      paidAt: row.paidAt?.toISOString() ?? null,
      reference: row.reference,
      accessCode: accessCodeLabel(row.accessCode),
      flutterwaveTransactionId: row.flutterwaveTxId,
      claimed: row.claimedByWawuId !== null,
      claimedByWawuId: row.claimedByWawuId,
      claimedAt: row.claimedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** GET /admin/waitlist/registrations: newest first, every status unless one is asked for. */
  async adminList(
    query: AdminWaitlistListQueryDto,
  ): Promise<Paginated<AdminWaitlistRegistrationView>> {
    const where = {
      ...(query.offerId ? { offerId: query.offerId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.waitlistRegistration.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.waitlistRegistration.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.adminView(r)),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /** Every registration the filter matches, oldest first, in batches. */
  async *adminRows(filter: {
    offerId?: string;
    status?: WaitlistStatus;
  }): AsyncGenerator<WaitlistRegistration> {
    const where = {
      ...(filter.offerId ? { offerId: filter.offerId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.waitlistRegistration.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      for (const r of batch) yield r;
      if (batch.length < 1000) return;
      cursor = batch[batch.length - 1].id;
    }
  }

  // ---- sweeps -------------------------------------------------------------

  /** Asks Flutterwave about one reference and settles it if it succeeded. */
  async recheck(row: WaitlistRegistration): Promise<boolean> {
    const found = await this.lookup.findByReference(row.reference);
    if (!found) return false;
    try {
      await this.settle(row, found, found.transactionId);
      return true;
    } catch (e) {
      if (e instanceof WaitlistError) {
        this.logger.log(`Re-check of ${row.reference.slice(0, 18)}: ${e.code}`);
        return false;
      }
      throw e;
    }
  }
}
