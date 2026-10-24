import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
import type { AdminRole } from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  type AddMoneyProvider,
  type AddMoneyRail,
  addMoneyOf,
  type ProviderAddMoneyAttempt,
  type ProviderAddMoneyWallet,
} from '../../wallet-provider/add-money';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { lagosDayStart } from '../limits/lagos-window';
import type { LedgerSource } from '../ledger/ledger.interface';
import { LedgerService } from '../ledger/ledger.service';
import { MoneyError } from '../money-error';
import {
  type IdempotencyScope,
  IdempotencyService,
} from '../payments/idempotency';
import { MerchantWallet } from '../payments/merchant-wallet';
import type { AddMoneyDto } from './add-money.dto';
import { AddMoneySettings } from './add-money-config';
import type {
  AddMoneyOptionsView,
  AddMoneyPage,
  AddMoneyQuoteView,
  AddMoneyRailView,
  AddMoneyStatus,
  AddMoneyView,
  AdminAddMoneyPage,
  AdminAddMoneyView,
} from './add-money-view.type';

/** The answer a repeat of the key gets: the same body the first answer had (the response interceptor's envelope). */
export function addMoneyBody(view: AddMoneyView): string {
  return JSON.stringify({ statusCode: 200, message: 'OK', data: view });
}

/** The route key the Idempotency-Key is kept under. */
export const ADD_MONEY_ROUTE = 'money/add-money';

/** The plan settings that switch the two products on or off (1 on, 0 off; default 1). */
export const ADD_MONEY_CARD_SETTING = 'money.add_money_card_on';
export const ADD_MONEY_USSD_SETTING = 'money.add_money_ussd_on';

const OPEN: readonly AddMoneyStatus[] = [
  'created',
  'awaiting_user',
  'processing',
];
const MINUTE = 60_000;
/** A rail Nuvion refused for naira is shown as not available for this long, then tried again. */
export const REFUSAL_MEMORY_MS = 15 * MINUTE;
/** An attempt with no provider id yet is looked for at the provider after this long. */
const LOST_START_AFTER_MS = 2 * MINUTE;
/** A hosted page or a prompt left alone this long is ended on our side. */
const WAITING_ENDS_AFTER_MS = 2 * 60 * MINUTE;
/** A paid attempt whose inflow has not landed after this long is marked for a person. */
const PAID_REVIEW_AFTER_MS = 3 * 24 * 60 * MINUTE;
const SWEEP_BATCH = 25;
const CHECK_EVERY_MS = 20_000;

const LABEL: Record<AddMoneyRail, string> = {
  card: 'Debit card',
  apple_pay: 'Apple Pay',
  ussd: 'USSD',
  open_banking: 'Bank checkout',
};
const NOT_AVAILABLE = 'This is not available yet.';
const OFF_NOW = 'This is switched off for now.';
const NOT_SWITCHED_ON =
  'This is not switched on for naira yet. It shows here as soon as it is.';
const DOWN_NOW =
  'This is not available right now. Nothing was charged. Try again later.';
const UNREACHABLE =
  'We could not reach the payment service. Nothing was charged. Try again in a moment.';

type Session = Prisma.AddMoneySessionGetPayload<object>;

/** What a failed attempt says, in our words, by the provider's code. */
export function failureWords(code: string | null): string {
  switch ((code ?? '').toLowerCase()) {
    case 'payment_cancelled':
    case 'cancelled':
      return 'The payment was cancelled. Nothing was added to your wallet.';
    case 'insufficient_funds':
      return 'There was not enough money in that account. Nothing was added to your wallet.';
    case 'payment_blocked':
    case 'payment_rejected':
      return 'Your bank turned the payment down. Nothing was added to your wallet.';
    case 'institution_unavailable':
    case 'institution_not_supported':
      return 'Your bank could not take the payment right now. Nothing was added to your wallet.';
    case 'session_expired':
      return 'The page timed out before the payment was made. Nothing was added to your wallet.';
    case 'card_declined':
      return 'Your card was declined. Nothing was added to your wallet.';
    default:
      return 'The payment did not go through. Nothing was added to your wallet.';
  }
}

/** One plain line for where an attempt stands. */
export function statusLine(s: {
  status: string;
  rail: string;
  failureMessage: string | null;
}): string {
  switch (s.status) {
    case 'created':
      return 'Getting your payment ready.';
    case 'awaiting_user':
      return s.rail === 'ussd'
        ? 'Check your phone and answer the prompt to pay.'
        : 'Finish the payment on the page that opened.';
    case 'processing':
      return 'Paid. Your wallet is being topped up. This can take a little while.';
    case 'settled':
      return 'The money is in your wallet.';
    case 'cancelled':
      return 'You cancelled this payment. Nothing was added to your wallet.';
    default:
      return s.failureMessage ?? failureWords(null);
  }
}

function money(n: bigint): number {
  const v = Number(n);
  if (!Number.isSafeInteger(v))
    throw new RangeError('A kobo figure is too large.');
  return v;
}

/** The phone details 3-D Secure asks for, with a plain default for each part the app did not send. */
export function browserOf(
  device: NonNullable<NonNullable<AddMoneyDto['card']>['device']> | undefined,
  req: { ip: string; userAgent: string },
) {
  return {
    acceptHeader:
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    userAgent: req.userAgent.slice(0, 250) || 'WhoMadeThis/1',
    language: device?.language ?? 'en-NG',
    screenWidth: device?.screenWidth ?? '390',
    screenHeight: device?.screenHeight ?? '844',
    colorDepth: device?.colorDepth ?? '24',
    timezoneOffset: device?.timezoneOffset ?? '-60',
    ipAddress: req.ip,
  };
}

export interface AddMoneyCaller {
  sub: string;
  email: string | null;
  phone: string;
  firstName: string;
  lastName: string;
  country: string;
}

/**
 * Adding money to a person's own wallet by card, Apple Pay, USSD or a bank
 * checkout (WALLET-25, WALLET-26; R-84), through the provider seam only
 * (`addMoneyOf`): a provider with none of it (Fintava's adapter) answers
 * `409 add_money_unavailable`.
 *
 * **The wallet is credited by the provider's inflow, once.** This service
 * never writes the credit from a payment's own status: a card is charged
 * before the money lands (Nuvion's card inflow is `pending` until it
 * settles, DEV-RESULTS), so the credit is written by NUV-04's inflow
 * recorder when the inflow settles, through `creditInflow` (the claim
 * the recorder calls for a rail that is not a bank transfer), keyed on the
 * transfer and our reference: a webhook, a replay and NUV-08's sweep land on
 * one ledger row. What this service reads from the provider says where an
 * attempt stands (a decline is shown at once); `paid` is shown as "being
 * topped up" until the credit lands.
 *
 * Fees (R-10): the person pays the amount plus the provider's charge plus
 * WAWU's, both from config; the wallet gets the amount. WAWU's fee, when
 * above 0, is moved from the wallet to WAWU's account once the credit is in.
 *
 * Never holds a transaction or a lock across a provider call: the attempt is
 * written, the provider called holding nothing, the answer recorded.
 */
@Injectable()
export class AddMoneyService implements OnModuleInit {
  private readonly logger = new Logger(AddMoneyService.name);
  private readonly refused = new Map<
    AddMoneyRail,
    { until: number; reason: string }
  >();
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly settings: AddMoneySettings,
    private readonly planSettings: PlanSettingsService,
    private readonly ledger: LedgerService,
    private readonly keys: IdempotencyService,
    private readonly merchant: MerchantWallet,
  ) {}

  onModuleInit(): void {
    // A key left `in_progress` by a request that died after it made the attempt is answered from that attempt.
    this.keys.onStale(
      ADD_MONEY_ROUTE,
      this.provider.timings.moneyTimeoutMs + MINUTE,
      async (row) => {
        const s = row.resourceId
          ? await this.prisma.addMoneySession.findUnique({
              where: { id: row.resourceId },
            })
          : null;
        return s ? { status: 201, body: addMoneyBody(this.view(s)) } : null;
      },
    );
  }

  private get addMoney(): (WalletProvider & AddMoneyProvider) | null {
    return this.provider.configured ? addMoneyOf(this.provider) : null;
  }

  // -------------------------------------------------------------------------
  // What the routes ask
  // -------------------------------------------------------------------------

  /** Why a rail cannot be used now, in plain words, or null when it can. */
  railProblem(rail: AddMoneyRail, now = Date.now()): string | null {
    const p = this.addMoney;
    if (!p || !p.addMoneyRails.includes(rail)) return NOT_AVAILABLE;
    const setting =
      rail === 'ussd' || rail === 'open_banking'
        ? ADD_MONEY_USSD_SETTING
        : ADD_MONEY_CARD_SETTING;
    if (this.planSettings.number(setting) !== 1) return OFF_NOW;
    if (rail === 'card' && !this.settings.cardPublicKey) return NOT_AVAILABLE;
    if (rail !== 'card' && rail !== 'ussd' && !this.settings.returnUrl) {
      return NOT_AVAILABLE;
    }
    if (rail === 'card' && !this.settings.returnUrl) return NOT_AVAILABLE;
    if (rail === 'ussd' && !this.settings.ussdChannel) {
      return 'USSD is not available for Nigerian phone numbers yet.';
    }
    if (!this.settings.quote(rail, 1).ok) return NOT_AVAILABLE;
    const refused = this.refused.get(rail);
    if (refused !== undefined && refused.until > now) return refused.reason;
    return null;
  }

  options(now = Date.now()): AddMoneyOptionsView {
    const all: AddMoneyRailView[] = (
      ['card', 'apple_pay', 'ussd', 'open_banking'] as const
    ).map((rail) => {
      const reason = this.railProblem(rail, now);
      return {
        rail,
        available: reason === null,
        reason,
        hosted: rail !== 'card' && rail !== 'ussd',
      };
    });
    // R-84 (3) prefers the provider's hosted pages: a card number is the one thing that must be scrambled on the phone. So the
    // hosted ways that can be used come first, then the card, then USSD, then every way that cannot be used now (lead ruling,
    // fix round 1: the provider has no hosted page for a card, so the card stays and is listed after the hosted ways).
    const rank = (r: AddMoneyRailView) =>
      !r.available ? 3 : r.hosted ? 0 : r.rail === 'card' ? 1 : 2;
    const rails = [...all].sort((a, b) => rank(a) - rank(b));
    const cardOn = rails.some(
      (r) => (r.rail === 'card' || r.rail === 'apple_pay') && r.available,
    );
    const lim = (n: number) => (n > 0 ? n : null);
    return {
      currency: 'NGN',
      rails,
      cardPublicKey: cardOn ? this.settings.cardPublicKey : null,
      limits: {
        minKobo: lim(this.settings.minKobo),
        maxKobo: lim(this.settings.maxKobo),
        dailyMaxKobo: lim(this.settings.dailyMaxKobo),
      },
    };
  }

  /**
   * The card is the phone's ciphertext under the provider's key, so it is exactly as long as the key makes it (RSA: the modulus).
   * Any other base64 text, a card in the clear included, is a plain 400 before the PIN is looked at.
   */
  assertCardCiphertext(raw: unknown): void {
    const bytes = this.settings.cardCipherBytes;
    const ok =
      typeof raw === 'string' &&
      bytes !== null &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(raw) &&
      raw.length % 4 === 0 &&
      Buffer.from(raw, 'base64').length === bytes;
    if (!ok) {
      throw new BadRequestException([
        'card.encrypted must be the card as this phone scrambled it with the key from the options.',
      ]);
    }
  }

  /** The fees and the total for one amount, or the refusal a person gets. */
  quote(rail: AddMoneyRail, amountKobo: number): AddMoneyQuoteView {
    const problem = this.railProblem(rail);
    if (problem !== null)
      throw new MoneyError('add_money_unavailable', problem);
    const q = this.settings.quote(rail, amountKobo);
    if (!q.ok) {
      throw new MoneyError(
        'fees_not_set',
        'Adding money this way is not available yet.',
      );
    }
    return {
      rail,
      currency: 'NGN',
      amountKobo,
      providerFeeKobo: q.providerFeeKobo,
      wawuFeeKobo: q.wawuFeeKobo,
      feeKobo: q.providerFeeKobo + q.wawuFeeKobo,
      chargeKobo: amountKobo + q.providerFeeKobo + q.wawuFeeKobo,
    };
  }

  /**
   * Every check that can be made before the PIN: the way is on, the limits,
   * the day's total, and the total the person was shown. Changes nothing.
   */
  async precheck(
    wawuUserId: string,
    input: { rail: AddMoneyRail; amountKobo: number; chargeKobo: number },
    now = new Date(),
  ): Promise<AddMoneyQuoteView> {
    const quote = this.quote(input.rail, input.amountKobo);
    const s = this.settings;
    if (s.minKobo > 0 && input.amountKobo < s.minKobo) {
      throw new MoneyError(
        'below_minimum',
        `The least you can add is ${naira(s.minKobo)}.`,
        { minimumKobo: s.minKobo },
      );
    }
    if (s.maxKobo > 0 && input.amountKobo > s.maxKobo) {
      throw new MoneyError(
        'limit_reached',
        `The most you can add at once is ${naira(s.maxKobo)}.`,
        { limitKobo: s.maxKobo },
      );
    }
    await this.checkDaily(this.prisma, wawuUserId, input.amountKobo, now);
    if (input.chargeKobo !== quote.chargeKobo) {
      throw new MoneyError(
        'quote_changed',
        'The fees changed. Check the new total and try again.',
      );
    }
    return quote;
  }

  /** The day's total against the limit, read through `db` (the connection, or the transaction that holds the person's lock). */
  private async checkDaily(
    db: Pick<PrismaService, 'addMoneySession'>,
    wawuUserId: string,
    amountKobo: number,
    now = new Date(),
  ): Promise<void> {
    const max = this.settings.dailyMaxKobo;
    if (max <= 0) return;
    const today = await db.addMoneySession.aggregate({
      where: {
        wawuUserId,
        createdAt: { gte: lagosDayStart(now) },
        status: { in: [...OPEN, 'settled'] },
      },
      _sum: { amountKobo: true },
    });
    const used = Number(today._sum.amountKobo ?? 0n);
    if (used + amountKobo > max) {
      throw new MoneyError(
        'limit_reached',
        `You can add up to ${naira(max)} a day. Try again tomorrow.`,
        { limitKobo: max, remainingTodayKobo: Math.max(0, max - used) },
      );
    }
  }

  private async holdDailyLimit(
    tx: Prisma.TransactionClient,
    wawuUserId: string,
    amountKobo: number,
  ): Promise<void> {
    if (this.settings.dailyMaxKobo <= 0) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`add-money-daily:${wawuUserId}`}))`;
    await this.checkDaily(tx, wawuUserId, amountKobo);
  }

  /** Starts one attempt: the row, then the provider, then what it answered. */
  async create(
    caller: AddMoneyCaller,
    dto: AddMoneyDto,
    scope: IdempotencyScope,
    req: { ip: string; userAgent: string },
  ): Promise<AddMoneyView> {
    const quote = await this.precheck(caller.sub, dto);
    const p = this.addMoney;
    if (!p) throw new MoneyError('add_money_unavailable', NOT_AVAILABLE);
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: caller.sub },
      select: { customerId: true, walletId: true, provider: true },
    });
    if (!wallet) {
      throw new MoneyError(
        'wallet_not_open',
        "You don't have a wallet yet. Open your wallet to continue.",
      );
    }
    if (!isRowOf(this.provider.name, wallet.provider)) {
      throw new MoneyError('provider_unreachable', UNREACHABLE, {
        retryAfterSeconds: this.provider.timings.retryAfterSeconds,
      });
    }
    const isCard = dto.rail === 'card' || dto.rail === 'apple_pay';
    if (dto.rail === 'card' && !dto.card) {
      throw new BadRequestException(['card is needed to pay by card.']);
    }
    if (isCard && !caller.email) {
      throw new MoneyError(
        'email_not_verified',
        'Add an email address to your account to pay by card.',
      );
    }
    const msisdn =
      dto.rail === 'ussd' ? ussdNumber(dto.ussd?.msisdn ?? caller.phone) : null;
    if (dto.rail === 'ussd' && !msisdn) {
      throw new MoneyError(
        'add_money_unavailable',
        'Enter the phone number to pay from.',
      );
    }

    const id = randomUUID();
    const reference = `wawu-add-${id}`;
    await this.prisma.$transaction(async (tx) => {
      // The day's limit is read and the attempt written under one lock per person, so two taps at once cannot both pass it.
      await this.holdDailyLimit(tx, caller.sub, quote.amountKobo);
      await this.keys.attach(tx, scope, id);
      await tx.addMoneySession.create({
        data: {
          id,
          wawuUserId: caller.sub,
          provider: this.provider.name,
          rail: dto.rail,
          amountKobo: BigInt(quote.amountKobo),
          chargeKobo: BigInt(quote.chargeKobo),
          providerFeeKobo: BigInt(quote.providerFeeKobo),
          wawuFeeKobo: BigInt(quote.wawuFeeKobo),
          reference,
        },
      });
    });

    const w: ProviderAddMoneyWallet = {
      customerId: wallet.customerId,
      walletId: wallet.walletId,
    };
    const returnUrl = this.returnUrlFor(id);
    const payer = {
      firstName: caller.firstName,
      lastName: caller.lastName,
      email: caller.email ?? '',
      phone: caller.phone || null,
    };
    let attempt: ProviderAddMoneyAttempt | null = null;
    try {
      attempt = await p.startAddMoney({
        rail: dto.rail,
        wallet: w,
        chargeKobo: BigInt(quote.chargeKobo),
        reference,
        narration: `Add money by ${LABEL[dto.rail].toLowerCase()}`,
        returnUrl,
        countryCode: 'NG',
        ...(msisdn && this.settings.ussdChannel
          ? { ussd: { msisdn, channel: this.settings.ussdChannel } }
          : {}),
      });
      if (isCard) {
        await this.record(id, attempt);
        attempt = await p.confirmAddMoney({
          rail: dto.rail as 'card' | 'apple_pay',
          wallet: w,
          providerRef: attempt.providerRef,
          returnUrl,
          payer,
          countryCode: 'NG',
          ...(dto.rail === 'card' && dto.card
            ? {
                encryptedCard: dto.card.encrypted,
                billing: {
                  line1: dto.card.billing.line1,
                  city: dto.card.billing.city,
                  state: dto.card.billing.state,
                  country: 'NG',
                  postalCode: dto.card.billing.postalCode ?? null,
                },
                browser: browserOf(dto.card.device, req),
              }
            : {}),
        });
      }
      await this.record(id, attempt);
    } catch (e) {
      await this.onStartFailure(id, dto.rail, w, attempt, e);
    }
    const row = await this.load(id);
    const view = this.view(row);
    await this.keys.finish(scope, 201, addMoneyBody(view));
    return view;
  }

  /** One attempt of the caller's, refreshed from the provider when it is still open and was not asked about lately. */
  async read(wawuUserId: string, id: string): Promise<AddMoneyView> {
    let s = await this.mine(wawuUserId, id);
    if (OPEN.includes(s.status as AddMoneyStatus) && this.stale(s)) {
      s = await this.refresh(s);
    }
    return this.view(s);
  }

  async list(
    wawuUserId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<AddMoneyPage> {
    const take = q.limit ?? 20;
    const rows = await this.prisma.addMoneySession.findMany({
      where: { wawuUserId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > take;
    const page = more ? rows.slice(0, take) : rows;
    return {
      items: page.map((r) => this.view(r)),
      nextCursor: more ? page[page.length - 1].id : null,
    };
  }

  /** The person cancels an attempt that is not paid yet. A paid or credited one cannot be cancelled. */
  async cancel(wawuUserId: string, id: string): Promise<AddMoneyView> {
    let s = await this.mine(wawuUserId, id);
    if (s.status === 'cancelled') return this.view(s);
    s = await this.cancelRow(s, null);
    return this.view(s);
  }

  // -------------------------------------------------------------------------
  // The provider's word: the webhook handler and the sweep
  // -------------------------------------------------------------------------

  /** The attempt a provider id or our reference names, or null. */
  async findByProvider(keys: {
    providerRef?: string | null;
    reference?: string | null;
  }): Promise<Session | null> {
    const or: Prisma.AddMoneySessionWhereInput[] = [];
    if (keys.providerRef) or.push({ providerRef: keys.providerRef });
    if (keys.reference) or.push({ reference: keys.reference });
    if (or.length === 0) return null;
    return this.prisma.addMoneySession.findFirst({
      where: { OR: or, provider: this.provider.name },
    });
  }

  /** Asks the provider where the attempt stands and records it. Never credits (the inflow does). */
  async refresh(s: Session): Promise<Session> {
    const p = this.addMoney;
    if (!p || !OPEN.includes(s.status as AddMoneyStatus)) return s;
    // An attempt whose account was deleted (anonymised, ACCOUNT_DATA_MAP) has no wallet to ask about.
    const w = s.wawuUserId ? await this.walletOf(s.wawuUserId) : null;
    if (!w) return s;
    try {
      let attempt: ProviderAddMoneyAttempt | null = null;
      if (s.providerRef) {
        attempt = await p.readAddMoney({
          rail: s.rail as AddMoneyRail,
          wallet: w,
          providerRef: s.providerRef,
        });
      } else if (Date.now() - s.createdAt.getTime() > LOST_START_AFTER_MS) {
        attempt = await p.findAddMoney(s.rail as AddMoneyRail, w, s.reference);
        if (!attempt) {
          await this.fail(
            s.id,
            'start_lost',
            'We could not start this payment. Nothing was charged.',
          );
          return this.load(s.id);
        }
      }
      if (attempt) await this.record(s.id, attempt);
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      this.logger.warn(
        `add money ${s.id}: the provider could not be read (${e.kind})`,
      );
    }
    await this.prisma.addMoneySession.updateMany({
      where: { id: s.id },
      data: { checkedAt: new Date() },
    });
    return this.load(s.id);
  }

  /**
   * The hook NUV-04's inflow recorder calls for an inflow that is not a bank
   * transfer. Returns null when the inflow is not one of ours (the recorder
   * then answers as it always did). A settled inflow credits the wallet
   * once; a pending one waits; a failed one ends the attempt.
   */
  async creditInflow(
    t: {
      id: string;
      amountKobo: number;
      feeKobo: number;
      currency: string;
      status: string;
      uniqueReference: string | null;
      paymentType: string | null;
      narration: string | null;
      createdAt: Date | null;
    },
    wallet: { wawuUserId: string; accountNumber: string },
    source: LedgerSource,
    sourceEventId: string | null,
  ): Promise<{ outcome: 'done' | 'wait' | 'failed'; note: string } | null> {
    if (!t.uniqueReference) return null;
    const s = await this.prisma.addMoneySession.findUnique({
      where: { reference: t.uniqueReference },
    });
    if (
      !s ||
      s.wawuUserId !== wallet.wawuUserId ||
      s.provider !== this.provider.name
    ) {
      return null;
    }
    const failed = (note: string, why: string) => {
      this.logger.error(
        `add money ${s.id}: ${note}; nothing credited (review)`,
      );
      return this.note(s.id, why).then(() => ({
        outcome: 'failed' as const,
        note: `${note}; nothing credited (review)`,
      }));
    };
    if (t.currency !== s.currency) {
      return failed(
        `the inflow is in ${t.currency}, the attempt in ${s.currency}`,
        'currency differs',
      );
    }
    if (BigInt(t.amountKobo) !== s.chargeKobo) {
      return failed(
        `the inflow is ${t.amountKobo} kobo, the attempt asked ${s.chargeKobo}`,
        'amount differs',
      );
    }
    if (s.status === 'settled') {
      return { outcome: 'done', note: 'already credited' };
    }
    if (s.status === 'cancelled') {
      return failed(
        'the attempt is cancelled but Nuvion took the payment',
        'paid after it was cancelled',
      );
    }
    if (s.frozen) {
      // Held, not stopped: the delivery stays pending and is offered again, and unfreezing makes it due at once (adminFreeze).
      await this.note(s.id, 'paid while frozen, held until it is unfrozen');
      return {
        outcome: 'wait',
        note: 'the attempt is frozen by an admin; the payment is held and credits when it is unfrozen',
      };
    }
    const st = t.status.toLowerCase();
    if (st === 'pending' || st === 'processing') {
      return { outcome: 'wait', note: `Nuvion says the inflow is still ${st}` };
    }
    if (st === 'failed' || st === 'reversed') {
      await this.fail(s.id, 'inflow_failed', failureWords(null));
      return {
        outcome: 'done',
        note: `Nuvion says the inflow is ${st}; nothing credited`,
      };
    }
    if (st !== 'successful') {
      return failed(
        `Nuvion's inflow status "${st}" is not one we know`,
        'unknown inflow status',
      );
    }
    const landed = t.amountKobo - t.feeKobo;
    if (landed < 1) {
      return failed(
        'the fee is as much as the payment',
        'fee takes the payment',
      );
    }
    const recorded = await this.ledger.record({
      wallet: {
        kind: 'user',
        wawuUserId: wallet.wawuUserId,
        accountNumber: wallet.accountNumber,
      },
      direction: 'in',
      status: 'completed',
      category: 'top_up',
      amountKobo: landed,
      feeKobo: t.feeKobo,
      providerFeeKobo: t.feeKobo,
      totalKobo: t.amountKobo,
      counterparty: {
        kind: 'bank_account',
        name: LABEL[s.rail as AddMoneyRail],
        accountNumber: null,
        bankCode: null,
      },
      narration: `Added by ${LABEL[s.rail as AddMoneyRail].toLowerCase()}`,
      references: {
        fintavaTransactionId: t.id,
        fintavaReference: t.uniqueReference,
        customerReference: s.reference,
      },
      source,
      sourceEventId,
      occurredAt: t.createdAt,
    });
    const differs = BigInt(t.feeKobo) !== s.providerFeeKobo;
    await this.prisma.addMoneySession.updateMany({
      // A payment that lands after we ended the attempt (failed or expired) is still money in the wallet.
      where: { id: s.id, status: { in: [...OPEN, 'failed', 'expired'] } },
      data: {
        status: 'settled',
        ledgerEntryId: recorded.entryId,
        creditedAt: new Date(),
        providerFeeKobo: BigInt(t.feeKobo),
        failureMessage: null,
        checkoutUrl: null,
        reviewNote: differs
          ? `Nuvion's fee was ${t.feeKobo} kobo, the quote said ${s.providerFeeKobo}`
          : null,
      },
    });
    await this.collectWawuFee(s.id).catch((e: unknown) => {
      this.logger.warn(
        `add money ${s.id}: WAWU's fee is collected later (${e instanceof Error ? e.message : 'error'})`,
      );
    });
    return {
      outcome: 'done',
      note: `${recorded.created ? 'credited' : 'already credited'} once${recorded.discrepancy ? `; ${recorded.discrepancy} (review)` : ''}`,
    };
  }

  /** WAWU's fee, from the wallet to WAWU's account, once the credit is in. Idempotent by its reference. */
  async collectWawuFee(id: string): Promise<void> {
    const s = await this.load(id);
    if (
      s.status !== 'settled' ||
      s.wawuFeeKobo <= 0n ||
      s.feeCollectedAt ||
      !s.wawuUserId
    )
      return;
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: s.wawuUserId },
      select: { accountNumber: true, provider: true },
    });
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) return;
    try {
      await this.provider.walletToWallet({
        fromAccountNumber: wallet.accountNumber,
        toAccountNumber: await this.merchant.account(),
        amountKobo: s.wawuFeeKobo,
        reference: `${s.reference}-wawufee`,
        narration: 'WAWU fee on adding money',
      });
    } catch (e) {
      // The reference is ours alone: a repeat of it means the first one went through.
      if (!(
        e instanceof WalletProviderError && e.kind === 'duplicate_reference'
      )) {
        throw e;
      }
    }
    await this.prisma.addMoneySession.updateMany({
      where: { id, feeCollectedAt: null },
      data: { feeCollectedAt: new Date() },
    });
  }

  /** Every minute: asks the provider about open attempts, ends the ones left waiting, collects fees still owed. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'add-money-sweep' })
  async sweepTick(): Promise<void> {
    if (this.sweeping || !this.addMoney) return;
    this.sweeping = true;
    try {
      await this.sweep();
    } catch (e) {
      this.logger.error(
        `add money sweep: ${e instanceof Error ? e.message : 'error'}`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  async sweep(
    now = new Date(),
  ): Promise<{ checked: number; ended: number; feesCollected: number }> {
    const due = await this.prisma.addMoneySession.findMany({
      where: {
        provider: this.provider.name,
        status: { in: [...OPEN] },
        OR: [
          { checkedAt: null },
          { checkedAt: { lte: new Date(now.getTime() - CHECK_EVERY_MS) } },
        ],
      },
      orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } },
      take: SWEEP_BATCH,
    });
    let ended = 0;
    for (const s of due) {
      const fresh = await this.refresh(s);
      if (!OPEN.includes(fresh.status as AddMoneyStatus)) {
        ended += 1;
        continue;
      }
      const age = now.getTime() - fresh.createdAt.getTime();
      if (
        fresh.status === 'awaiting_user' &&
        (age > WAITING_ENDS_AFTER_MS ||
          (fresh.expiresAt !== null &&
            fresh.expiresAt.getTime() < now.getTime()))
      ) {
        await this.prisma.addMoneySession.updateMany({
          where: { id: fresh.id, status: 'awaiting_user' },
          data: {
            status: 'expired',
            failureCode: 'session_expired',
            failureMessage: failureWords('session_expired'),
            checkoutUrl: null,
          },
        });
        ended += 1;
      } else if (
        fresh.status === 'processing' &&
        age > PAID_REVIEW_AFTER_MS &&
        !fresh.reviewNote
      ) {
        await this.note(fresh.id, 'paid at Nuvion, no inflow after 3 days');
      }
    }
    const owed = await this.prisma.addMoneySession.findMany({
      where: {
        provider: this.provider.name,
        status: 'settled',
        wawuFeeKobo: { gt: 0 },
        feeCollectedAt: null,
      },
      take: SWEEP_BATCH,
    });
    let feesCollected = 0;
    for (const s of owed) {
      try {
        await this.collectWawuFee(s.id);
        feesCollected += 1;
      } catch (e) {
        this.logger.warn(
          `add money ${s.id}: the fee could not be collected yet (${e instanceof Error ? e.message : 'error'})`,
        );
      }
    }
    return { checked: due.length, ended, feesCollected };
  }

  // -------------------------------------------------------------------------
  // Admin: list, freeze, unfreeze, cancel (owner-asked controls)
  // -------------------------------------------------------------------------

  async adminList(q: {
    cursor?: string;
    limit?: number;
    status?: string;
    rail?: string;
    wawuUserId?: string;
  }): Promise<AdminAddMoneyPage> {
    const take = q.limit ?? 25;
    const rows = await this.prisma.addMoneySession.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.rail ? { rail: q.rail } : {}),
        ...(q.wawuUserId ? { wawuUserId: q.wawuUserId } : {}),
      },
      include: { audits: { orderBy: { actedAt: 'desc' }, take: 5 } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > take;
    const page = more ? rows.slice(0, take) : rows;
    return {
      items: page.map((r) => this.adminView(r)),
      nextCursor: more ? page[page.length - 1].id : null,
    };
  }

  async adminGet(id: string): Promise<AdminAddMoneyView> {
    const r = await this.prisma.addMoneySession.findUnique({
      where: { id },
      include: { audits: { orderBy: { actedAt: 'desc' }, take: 20 } },
    });
    if (!r) throw new MoneyError('not_found', 'We could not find that.');
    return this.adminView(r);
  }

  /**
   * Freezes an open attempt: it cannot be credited until it is unfrozen. An
   * attempt that is credited, failed, expired or cancelled cannot be frozen
   * (`409`). The audit row is written with the change, in one transaction.
   */
  async adminFreeze(
    id: string,
    freeze: boolean,
    admin: { id: string; email: string; role: AdminRole },
    reason: string | null,
  ): Promise<AdminAddMoneyView> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; frozen: boolean }[]>`
        SELECT "status", "frozen" FROM "AddMoneySession" WHERE "id" = ${id} FOR UPDATE`;
      if (rows.length === 0)
        throw new MoneyError('not_found', 'We could not find that.');
      const row = rows[0];
      if (!OPEN.includes(row.status as AddMoneyStatus)) {
        throw new MoneyError(
          'add_money_unavailable',
          `This attempt is ${row.status}, so it cannot be ${freeze ? 'frozen' : 'unfrozen'}.`,
        );
      }
      if (row.frozen === freeze) return;
      await tx.addMoneySession.update({
        where: { id },
        data: { frozen: freeze },
      });
      await tx.addMoneyAudit.create({
        data: {
          sessionId: id,
          action: freeze ? 'freeze' : 'unfreeze',
          reason,
          fromStatus: row.status,
          toStatus: row.status,
          actedByAdminId: admin.id,
          actedByAdminEmail: admin.email,
          actedByAdminRole: admin.role,
        },
      });
    });
    if (!freeze) await this.offerHeldAgain(id);
    return this.adminGet(id);
  }

  /**
   * After an unfreeze: the attempt's inflow delivery, held while it was frozen, is made due now, so the dispatcher credits it on
   * its next turn instead of after its backoff (up to an hour). The dispatcher credits it once, as for any delivery.
   */
  private async offerHeldAgain(id: string): Promise<void> {
    const s = await this.load(id);
    await this.prisma.nuvionWebhookEvent.updateMany({
      where: {
        processingStatus: 'pending',
        event: { in: ['inflows.completed', 'inflows.failed'] },
        payload: { path: ['data', 'unique_reference'], equals: s.reference },
      },
      data: { nextAttemptAt: null, claimedUntil: null },
    });
  }

  async adminCancel(
    id: string,
    admin: { id: string; email: string; role: AdminRole },
    reason: string | null,
  ): Promise<AdminAddMoneyView> {
    const s = await this.load(id).catch(() => null);
    if (!s) throw new MoneyError('not_found', 'We could not find that.');
    await this.cancelRow(s, { admin, reason });
    return this.adminGet(id);
  }

  // -------------------------------------------------------------------------

  /** The row to cancel, if the provider has not taken the payment; an audit row when an admin does it. */
  private async cancelRow(
    s: Session,
    by: {
      admin: { id: string; email: string; role: AdminRole };
      reason: string | null;
    } | null,
  ): Promise<Session> {
    if (!OPEN.includes(s.status as AddMoneyStatus)) {
      throw new MoneyError(
        'add_money_unavailable',
        s.status === 'settled'
          ? 'The money is already in your wallet, so this cannot be cancelled.'
          : 'This payment has already ended.',
      );
    }
    // Ask the provider first (holding no lock): a payment it already took cannot be cancelled here.
    const fresh = await this.refresh(s);
    if (!OPEN.includes(fresh.status as AddMoneyStatus)) return fresh;
    const p = this.addMoney;
    const w = fresh.wawuUserId ? await this.walletOf(fresh.wawuUserId) : null;
    if (
      fresh.providerRef &&
      fresh.status === 'processing' &&
      fresh.rail !== 'ussd'
    ) {
      // Charged or taken by the provider, awaiting its inflow: the money is on its way.
      throw new MoneyError(
        'add_money_unavailable',
        'This payment has gone through and is being added to your wallet, so it cannot be cancelled.',
      );
    }
    if (
      p &&
      w &&
      fresh.providerRef &&
      (fresh.rail === 'card' || fresh.rail === 'apple_pay')
    ) {
      try {
        await p.cancelAddMoney({
          rail: fresh.rail,
          wallet: w,
          providerRef: fresh.providerRef,
        });
      } catch (e) {
        if (!(e instanceof WalletProviderError)) throw e;
        // Not cancelled at the provider (it may be confirmed already): ours ends, and a payment that later lands is kept for review, not credited.
        this.logger.warn(
          `add money ${fresh.id}: the provider would not cancel (${e.kind})`,
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.addMoneySession.updateMany({
        where: { id: fresh.id, status: { in: [...OPEN] } },
        data: { status: 'cancelled', checkoutUrl: null },
      });
      if (count === 1 && by) {
        await tx.addMoneyAudit.create({
          data: {
            sessionId: fresh.id,
            action: 'cancel',
            reason: by.reason,
            fromStatus: fresh.status,
            toStatus: 'cancelled',
            actedByAdminId: by.admin.id,
            actedByAdminEmail: by.admin.email,
            actedByAdminRole: by.admin.role,
          },
        });
      }
    });
    return this.load(fresh.id);
  }

  private async onStartFailure(
    id: string,
    rail: AddMoneyRail,
    wallet: ProviderAddMoneyWallet,
    started: ProviderAddMoneyAttempt | null,
    e: unknown,
  ): Promise<void> {
    if (!(e instanceof WalletProviderError)) throw e;
    this.logger.warn(
      `add money ${id}: ${rail} could not be started (${e.kind})`,
    );
    if (e.kind === 'not_supported' || e.kind === 'unavailable') {
      // The provider said no for naira (not switched on, or its partner is down): shown as such for a while, then tried again.
      const reason = e.kind === 'not_supported' ? NOT_SWITCHED_ON : DOWN_NOW;
      this.refused.set(rail, { until: Date.now() + REFUSAL_MEMORY_MS, reason });
      await this.fail(id, e.kind, reason);
    } else if (e.kind === 'outcome_unknown' || e.kind === 'not_confirmed') {
      // The answer was lost: the attempt may exist at the provider. It stays open; the sweep and the webhook find it by our reference.
      await this.prisma.addMoneySession.update({
        where: { id },
        data: { status: started ? 'processing' : 'created' },
      });
      return;
    } else if (e.kind === 'validation' && rail === 'card') {
      await this.fail(
        id,
        'card_invalid',
        'We could not take that card. Check the details and try again. Nothing was charged.',
      );
    } else {
      await this.fail(id, `provider_${e.kind}`, UNREACHABLE);
    }
    if (started && (rail === 'card' || rail === 'apple_pay')) {
      // Leave no open intent behind a refusal.
      await this.addMoney
        ?.cancelAddMoney({ rail, wallet, providerRef: started.providerRef })
        .catch(() => undefined);
    }
  }

  /** Writes what the provider says onto the row, never moving a finished attempt. */
  private async record(id: string, a: ProviderAddMoneyAttempt): Promise<void> {
    const status: AddMoneyStatus = a.state === 'paid' ? 'processing' : a.state;
    await this.prisma.addMoneySession.updateMany({
      where: { id, status: { in: [...OPEN] } },
      data: {
        status,
        providerRef: a.providerRef,
        ...(a.actionRef ? { actionRef: a.actionRef } : {}),
        checkoutUrl: status === 'awaiting_user' ? a.nextUrl : null,
        ...(a.card?.last4 ? { cardLast4: a.card.last4 } : {}),
        ...(a.card?.brand ? { cardBrand: a.card.brand.toLowerCase() } : {}),
        ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
        ...(a.feeKobo !== null ? { providerFeeKobo: a.feeKobo } : {}),
        ...(status === 'failed' ||
        status === 'expired' ||
        status === 'cancelled'
          ? {
              failureCode: a.failure?.code ?? status,
              failureMessage:
                status === 'cancelled'
                  ? null
                  : failureWords(a.failure?.code ?? null),
            }
          : {}),
      },
    });
  }

  private async fail(id: string, code: string, message: string): Promise<void> {
    await this.prisma.addMoneySession.updateMany({
      where: { id, status: { in: [...OPEN] } },
      data: {
        status: 'failed',
        failureCode: code,
        failureMessage: message,
        checkoutUrl: null,
      },
    });
  }

  private async note(id: string, note: string): Promise<void> {
    await this.prisma.addMoneySession.updateMany({
      where: { id },
      data: { reviewNote: note },
    });
  }

  private async walletOf(
    wawuUserId: string,
  ): Promise<ProviderAddMoneyWallet | null> {
    const w = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { customerId: true, walletId: true, provider: true },
    });
    return w && isRowOf(this.provider.name, w.provider)
      ? { customerId: w.customerId, walletId: w.walletId }
      : null;
  }

  private stale(s: Session): boolean {
    return !s.checkedAt || Date.now() - s.checkedAt.getTime() > CHECK_EVERY_MS;
  }

  private returnUrlFor(id: string): string {
    const base = this.settings.returnUrl;
    if (!base) throw new MoneyError('add_money_unavailable', NOT_AVAILABLE);
    return `${base.replace(/\/$/, '')}?id=${id}`;
  }

  private async load(id: string): Promise<Session> {
    return this.prisma.addMoneySession.findUniqueOrThrow({ where: { id } });
  }

  private async mine(wawuUserId: string, id: string): Promise<Session> {
    const s = await this.prisma.addMoneySession.findFirst({
      where: { id, wawuUserId },
    });
    if (!s) throw new MoneyError('not_found', 'We could not find that.');
    return s;
  }

  view(s: Session): AddMoneyView {
    return {
      id: s.id,
      rail: s.rail as AddMoneyRail,
      status: s.status as AddMoneyStatus,
      currency: 'NGN',
      amountKobo: money(s.amountKobo),
      chargeKobo: money(s.chargeKobo),
      providerFeeKobo: money(s.providerFeeKobo),
      wawuFeeKobo: money(s.wawuFeeKobo),
      checkoutUrl: s.status === 'awaiting_user' ? s.checkoutUrl : null,
      message: statusLine(s),
      failureMessage:
        s.status === 'failed' || s.status === 'expired'
          ? s.failureMessage
          : null,
      cardLast4: s.cardLast4,
      cardBrand: s.cardBrand,
      expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
      creditedAt: s.creditedAt ? s.creditedAt.toISOString() : null,
    };
  }

  private adminView(
    s: Session & {
      audits: {
        action: string;
        reason: string | null;
        fromStatus: string;
        toStatus: string;
        actedByAdminEmail: string;
        actedAt: Date;
      }[];
    },
  ): AdminAddMoneyView {
    return {
      ...this.view(s),
      wawuUserId: s.wawuUserId,
      provider: s.provider,
      reference: s.reference,
      providerRef: s.providerRef,
      frozen: s.frozen,
      failureCode: s.failureCode,
      reviewNote: s.reviewNote,
      feeCollectedAt: s.feeCollectedAt ? s.feeCollectedAt.toISOString() : null,
      audits: s.audits.map((a) => ({
        action: a.action,
        reason: a.reason,
        fromStatus: a.fromStatus,
        toStatus: a.toStatus,
        actedByAdminEmail: a.actedByAdminEmail,
        actedAt: a.actedAt.toISOString(),
      })),
    };
  }
}

function naira(kobo: number): string {
  const whole = Math.floor(kobo / 100);
  const frac = kobo % 100;
  const n = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${n}${frac === 0 ? '' : `.${String(frac).padStart(2, '0')}`}`;
}

/** A phone as Nuvion's mobile money takes it: digits only, international form, no plus. */
export function ussdNumber(raw: string): string | null {
  const d = raw.replace(/[^0-9]/g, '');
  if (/^0[0-9]{10}$/.test(d)) return `234${d.slice(1)}`;
  return /^[0-9]{10,15}$/.test(d) ? d : null;
}
