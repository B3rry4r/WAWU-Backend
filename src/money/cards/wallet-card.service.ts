import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma, WalletCard } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  WalletProviderError,
  walletProviderErrorToHttp,
} from '../../wallet-provider/wallet-provider-error';
import {
  WALLET_PROVIDER,
  type ProviderCard,
  type ProviderCards,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { FEE_LEG_SUFFIX } from '../../nuvion/fee-legs';
import { RATE_PROVIDER } from '../fees/engine/fee-kinds';
import { FeeRecordService } from '../fees/engine/fee-record.service';
import { FeeScheduleService } from '../fees/engine/fee-schedule.service';
import { FeeQuoteService } from '../fees/fee-quote.service';
import { LedgerService } from '../ledger/ledger.service';
import { lagosDayStart } from '../limits/lagos-window';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import {
  IdempotencyService,
  type IdempotencyScope,
} from '../payments/idempotency';
import { successBody } from '../payments/wallet-payment.service';
import { CARDS_ENABLED_SETTING, CardSettings } from './card-config';
import {
  recordCardFeeRow,
  recordIssuerFeeRow,
  WAWU_FEE_ROW_SUFFIX,
} from './card-fee-row';
import { cleanCardName, CreateCardDto } from './card-request.dto';
import {
  cardTargetFor,
  followCardStatus,
  GIVE_UP_FAILURE,
  stepWords,
} from './card-status';
import type {
  CardDetailsView,
  CardKind,
  CardListView,
  CardQuoteView,
  CardStatus,
  CardTransactionPage,
  CardView,
} from './card-view.type';

/** The label the Idempotency-Key is scoped to (as TRANSFER_ROUTE). */
export const CARD_CREATE_ROUTE = 'POST money/cards';

/** States that count as a card the person holds (and so against the limit). */
export const HELD_STATES = ['creating', 'unknown', 'active', 'frozen'];
const PENDING_STATES = ['creating', 'unknown'];

/** WAWU's fee on a card: the most tries after a failure, and the rest between them. */
const FEE_TRIES_MAX = 5;
const FEE_RETRY_EVERY_MS = 30_000;

/** How often one card is read from the issuer when its screen is opened. */
const READ_THROUGH_EVERY_MS = 60_000;
/** How long the bookkeeping of a card's screen reads is kept once the books are large. */
const MISSING_FORGOTTEN_MS = 60 * 60_000;

/** How long a card that nobody confirmed is waited for before it is looked for. */
const LOOK_AFTER_MS = 20_000;
/** How long an unconfirmed card that the issuer does not know is waited for before it is given up. */
const GIVE_UP_AFTER_MS = 10 * 60_000;

const DEFAULT_NAMES: Record<CardKind, string> = {
  virtual: 'Virtual card',
  single_use: 'Single-use card',
};

export const PENDING_MESSAGE =
  'We are confirming your card with the issuer. It will show here when it is ready. You will not be charged twice.';
const UNAVAILABLE_MESSAGE = 'Cards are not available right now.';
const FEE_MESSAGE =
  'Cards are not ready yet. Nothing was taken from your wallet.';
const LIMIT_ACTIVE_MESSAGE =
  'You have the most cards one person can hold. Block one to get another.';
const LIMIT_DAY_MESSAGE =
  'You have asked for the most cards one person can in a day. Try again tomorrow.';
const BLOCKED_MESSAGE = 'This card is blocked and cannot be used again.';
export const USED_MESSAGE =
  'This single-use card was used once and cannot be used again.';
/** What the card's fee transfer is called at the provider, as a send's fee leg is. */
const CARD_FEE_NARRATION = 'WAWU card fee';
const PENDING_ACTION_MESSAGE =
  'This card is still being made. Try again in a moment.';
const SUPPORT_FROZEN_MESSAGE =
  'Support has frozen this card. Contact support to use it again.';

function koboText(kobo: number): string {
  const naira = Math.floor(kobo / 100);
  const rest = String(kobo % 100).padStart(2, '0');
  return `₦${naira.toLocaleString('en-NG')}.${rest}`;
}

/** The kind a stored row has. */
function kindOf(row: Pick<WalletCard, 'type'>): CardKind {
  return row.type === 'single_use' ? 'single_use' : 'virtual';
}

function statusOf(row: Pick<WalletCard, 'state'>): CardStatus {
  switch (row.state) {
    case 'active':
      return 'active';
    case 'frozen':
      return 'frozen';
    case 'cancelled':
      return 'blocked';
    case 'used':
      return 'used';
    default:
      return 'pending';
  }
}

export function cardView(
  row: WalletCard,
  last4: string | null = null,
): CardView {
  const status = statusOf(row);
  return {
    id: row.id,
    kind: kindOf(row),
    name: row.name,
    status,
    currency: 'USD',
    frozenBySupport: row.state === 'frozen' && row.frozenBy === 'admin',
    last4,
    statusMessage: status === 'pending' ? PENDING_MESSAGE : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The WAWU card (task WALLET-31; R-84): virtual and single-use dollar cards
 * that Nuvion issues, funded from the person's own account, Nuvion
 * converting at use. WAWU keeps a row per card (WalletCard): whose, what
 * kind, its state and Nuvion's id. The card number, expiry and CVV are read
 * from Nuvion behind the PIN each time and never stored or logged here.
 *
 * - Making a card (W29): the Idempotency-Key and the PIN or a biometric
 *   approval, as a naira send. The row is claimed under a short lock, Nuvion
 *   is called holding nothing, the row is updated. The card's name at Nuvion
 *   is our reference, so a card made while the answer was lost is found
 *   again and adopted, never made twice. Nuvion takes its fee from the
 *   person's account when it makes the card (dev: 65,772 kobo).
 * - Freeze and block need nothing but a signed-in owner (a lost card must be
 *   stopped at once); unfreeze and showing the details need the PIN.
 * - Blocking is Nuvion's delete: for good.
 */
@Injectable()
export class WalletCardService implements OnModuleInit {
  private readonly logger = new Logger(WalletCardService.name);
  /** When each card was last read from the issuer for its screen: one read a minute per card, per process. */
  private readonly readThrough = new Map<string, number>();
  /** When a screen read of a card first answered "not found" and no read has found it since: per process, so a restart forgets it. */
  private readonly missingSince = new Map<string, number>();
  /** How often WAWU's fee on each card was asked after a failure (CARD-FEE-HISTORY, L3): per process, so a restart forgets it. */
  private readonly feeTries = new Map<string, { n: number; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly plan: PlanSettingsService,
    private readonly settings: CardSettings,
    private readonly keys: IdempotencyService,
    private readonly fees: FeeQuoteService,
    private readonly ledger: LedgerService,
    private readonly schedule: FeeScheduleService,
    private readonly feeRecords: FeeRecordService,
  ) {}

  /**
   * A request that died after it claimed the card (a restart) is answered
   * from the card it made, once it can no longer be running.
   */
  onModuleInit(): void {
    this.keys.onStale(CARD_CREATE_ROUTE, 3 * 60_000, async (row) => {
      const card = row.resourceId
        ? await this.prisma.walletCard.findUnique({
            where: { id: row.resourceId },
          })
        : null;
      return card ? { status: 201, body: successBody(cardView(card)) } : null;
    });
  }

  // -------------------------------------------------------------------------
  // What the product allows now
  // -------------------------------------------------------------------------

  enabled(): boolean {
    return this.plan.number(CARDS_ENABLED_SETTING) === 1;
  }

  /** The provider's card calls, or the refusal when this server's provider has none. */
  private cards(): ProviderCards {
    const cards = this.provider.cards;
    if (!cards) {
      throw new MoneyError('cards_unavailable', UNAVAILABLE_MESSAGE);
    }
    return cards;
  }

  /**
   * WAWU's own fee for making a card, now (R-140 point 2). Under Nuvion it is
   * the dashboard's `card_issue` fee in force plus VAT when VAT is on; the
   * fee is one fixed amount, so the amount worked from is 0. With no fee in
   * force the refusal is `503 fees_not_set` and nothing is sent. Under any
   * other provider it is the old setting, unchanged (`WAWU_FEE_CARD_KOBO`).
   * `totalKobo` is what the person pays WAWU and what the card row keeps.
   */
  wawuFee(): {
    feeKobo: number;
    vatKobo: number;
    totalKobo: number;
    scheduleId: string | null;
  } {
    if (this.provider.name !== 'nuvion') {
      const kobo = this.settings.wawuFeeKobo;
      return { feeKobo: kobo, vatKobo: 0, totalKobo: kobo, scheduleId: null };
    }
    const f = this.schedule.feeFor('card_issue', 0n);
    const feeKobo = Number(f.feeMinor);
    const vatKobo = Number(f.vatMinor);
    return {
      feeKobo,
      vatKobo,
      totalKobo: feeKobo + vatKobo,
      scheduleId: f.row.id,
    };
  }

  /** Off, not built for the running provider, or its fee not set: the refusal, before a PIN is looked at. */
  assertCreatable(): void {
    if (!this.enabled()) {
      throw new MoneyError('cards_unavailable', UNAVAILABLE_MESSAGE);
    }
    this.cards();
    if (this.settings.providerFeeKobo === null) {
      throw new MoneyError('fees_not_set', FEE_MESSAGE);
    }
    // WAWU's own fee moves as a send's fee does: from the person's account to
    // WAWU's, which only a provider with a fee transfer of its own can do.
    if (this.wawuFee().totalKobo > 0 && this.provider.wawuFeeLeg !== true) {
      throw new MoneyError('fees_not_set', FEE_MESSAGE);
    }
  }

  /** Reading and controlling cards that exist works while the product is off (a person can still block theirs). */
  assertReadable(): ProviderCards {
    return this.cards();
  }

  private async counts(
    wawuUserId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    now = new Date(),
  ): Promise<{ active: number; today: number }> {
    const [active, today] = await Promise.all([
      db.walletCard.count({
        where: { wawuUserId, state: { in: HELD_STATES } },
      }),
      db.walletCard.count({
        where: {
          wawuUserId,
          state: { not: 'failed' },
          createdAt: { gte: lagosDayStart(now) },
        },
      }),
    ]);
    return { active, today };
  }

  /** The refusal for a person already at a limit, before a PIN is looked at. */
  async assertWithinLimits(wawuUserId: string): Promise<void> {
    const c = await this.counts(wawuUserId);
    this.refuseOverLimit(c);
  }

  private refuseOverLimit(c: { active: number; today: number }): void {
    if (c.active >= this.settings.maxActive) {
      throw new MoneyError('card_limit_reached', LIMIT_ACTIVE_MESSAGE);
    }
    if (c.today >= this.settings.maxPerDay) {
      throw new MoneyError('card_limit_reached', LIMIT_DAY_MESSAGE);
    }
  }

  async quote(wallet: OpenWallet): Promise<CardQuoteView> {
    const enabled = this.enabled();
    const provider = this.settings.providerFeeKobo;
    if (enabled && provider === null) {
      throw new MoneyError('fees_not_set', FEE_MESSAGE);
    }
    const c = await this.counts(wallet.wawuUserId);
    let wawu = 0;
    try {
      wawu = this.wawuFee().totalKobo;
    } catch (e) {
      // A product that is off can still be read; one that is on and has no fee in force is refused.
      if (enabled) throw e;
    }
    const fee = {
      providerFeeKobo: provider ?? 0,
      wawuFeeKobo: wawu,
      totalFeeKobo: (provider ?? 0) + wawu,
    };
    const underLimits =
      c.active < this.settings.maxActive && c.today < this.settings.maxPerDay;
    return {
      enabled,
      currency: 'USD',
      kinds: ['virtual', 'single_use'],
      fee,
      limits: {
        maxActive: this.settings.maxActive,
        maxPerDay: this.settings.maxPerDay,
        activeNow: c.active,
        askedToday: c.today,
      },
      canCreate:
        enabled &&
        !!this.provider.cards &&
        (wawu === 0 || this.provider.wawuFeeLeg === true) &&
        underLimits,
    };
  }

  // -------------------------------------------------------------------------
  // The fees: Nuvion's is taken by Nuvion; WAWU's moves as a send's fee does
  // -------------------------------------------------------------------------

  /**
   * Refuses a request the person's balance cannot cover, before anything is
   * claimed or sent: Nuvion's fee and WAWU's both come out of the wallet. The
   * balance is the provider's, read now; a read that fails is the provider's
   * refusal, nothing is taken. The key is given back (nothing was attached).
   */
  private async assertCanAfford(
    wallet: OpenWallet,
    wawuKobo: number,
  ): Promise<void> {
    const need = (this.settings.providerFeeKobo ?? 0) + wawuKobo;
    if (need <= 0) return;
    let available: bigint;
    try {
      available = (
        await this.provider.getBalance({ walletId: wallet.walletId })
      ).availableKobo;
    } catch (e) {
      throw e instanceof WalletProviderError ? e.toHttpException() : e;
    }
    if (available < BigInt(need)) {
      throw new MoneyError(
        'insufficient_funds',
        `Your wallet needs ${koboText(need)} for the card fee.`,
      );
    }
  }

  /** What the fee's transfer moves: the fee less the provider's own charge for moving it, as a send's fee leg is worked out. */
  private feeLegKobo(wawuFee: number): number {
    if (!this.fees.feesSet) return wawuFee;
    const charge = (kobo: number) =>
      this.fees.providerFees.walletToWalletKobo(kobo);
    let leg = wawuFee - charge(wawuFee);
    for (let i = 0; i < 6 && leg > 0; i += 1) {
      const next = wawuFee - charge(leg);
      if (next === leg) break;
      leg = next;
    }
    return Math.max(0, Math.min(leg, wawuFee));
  }

  /**
   * WAWU's fee on a card, taken from the person to WAWU's own account at the
   * provider once the card exists (round 1, M1; the way a send's fee leg is,
   * FIX-52): one transfer under the card's reference plus `-fee`, which the
   * provider answers with the original when it is asked again, so a repeat
   * never moves it twice. Never throws and never undoes the card: a transfer
   * that is not confirmed is tried again the next time the card is read. The
   * ledger's side (money in on WAWU's account) is written once it moved.
   */
  async collectFee(wallet: OpenWallet, row: WalletCard): Promise<void> {
    if (
      row.wawuFeeKobo <= 0n ||
      row.feeCollectedAt !== null ||
      !['active', 'frozen', 'used'].includes(row.state) ||
      this.provider.wawuFeeLeg !== true
    ) {
      return;
    }
    // Bounded retry: at most FEE_TRIES_MAX asks per card per process, at
    // least FEE_RETRY_EVERY_MS apart. The provider's transfer is keyed by the
    // card's reference plus `-fee` and answers a repeat with the original, so
    // an ask can never debit twice; the bound only stops the asking.
    const tried = this.feeTries.get(row.id);
    if (tried) {
      if (tried.n >= FEE_TRIES_MAX) return;
      if (Date.now() - tried.at < FEE_RETRY_EVERY_MS) return;
    }
    const fee = Number(row.wawuFeeKobo);
    const leg = this.feeLegKobo(fee);
    try {
      if (leg > 0) {
        const platform = await this.provider.getPlatformAccount();
        const reference = `${row.reference}${FEE_LEG_SUFFIX}`;
        const receipt = await this.provider.walletToWallet({
          fromAccountNumber: wallet.accountNumber,
          toAccountNumber: platform.accountNumber,
          amountKobo: BigInt(leg),
          reference,
          narration: CARD_FEE_NARRATION,
        });
        // The person's side first, and not swallowed: a failure leaves the fee
        // "not collected" so the next read asks the provider again (it answers
        // with the original transfer) and writes the row then.
        await recordCardFeeRow(
          this.ledger,
          undefined,
          row,
          wallet.accountNumber,
          `${row.reference}${WAWU_FEE_ROW_SUFFIX}`,
          Number(receipt.amountKobo) + Number(receipt.feeKobo),
        );
        await this.recordFee(
          row,
          wallet,
          platform.accountNumber,
          reference,
          Number(receipt.amountKobo),
        );
      } else {
        this.logger.warn(
          `card ${row.id}: WAWU's fee (${fee} kobo) is not more than the provider's charge for moving it; not collected`,
        );
      }
      await this.prisma.walletCard.updateMany({
        where: { id: row.id, feeCollectedAt: null },
        data: { feeCollectedAt: new Date() },
      });
      row.feeCollectedAt = new Date();
      this.feeTries.delete(row.id);
    } catch (e) {
      const n = (tried?.n ?? 0) + 1;
      this.feeTries.set(row.id, { n, at: Date.now() });
      if (n >= FEE_TRIES_MAX) {
        this.logger.error(
          `card ${row.id}: WAWU's fee is still not booked after ${n} tries; not asked again until this server restarts (the transfer, if it moved, moved once)`,
        );
      }
      this.logger.warn(
        `card ${row.id}: WAWU's fee is not collected yet (${e instanceof WalletProviderError ? e.kind : 'error'}); tried again when the card is read`,
      );
    }
  }

  /** The ledger's side of the fee's transfer: money IN on WAWU's own account, written once. A failure is logged and the next look writes it. */
  private async recordFee(
    row: WalletCard,
    wallet: OpenWallet,
    platformNumber: string,
    reference: string,
    movedKobo: number,
  ): Promise<void> {
    if (movedKobo <= 0) return;
    try {
      await this.ledger.record(
        {
          wallet: { kind: 'merchant', accountNumber: platformNumber },
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: movedKobo,
          feeKobo: 0,
          totalKobo: movedKobo,
          narration: CARD_FEE_NARRATION,
          references: { customerReference: reference },
          counterparty: {
            kind: 'wawu_user',
            name: null,
            wawuUserId: row.wawuUserId,
            accountNumber: wallet.accountNumber,
          },
          source: 'send',
        },
        undefined,
        { quiet: true },
      );
    } catch (e) {
      this.logger.error(
        `card ${row.id}: the ledger could not record WAWU's fee transfer (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(wallet: OpenWallet): Promise<CardListView> {
    const enabled = this.enabled();
    if (!this.provider.cards) return { enabled: false, cards: [] };
    const rows = await this.prisma.walletCard.findMany({
      where: { wawuUserId: wallet.wawuUserId, state: { not: 'failed' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    const cards: CardView[] = [];
    for (const row of rows) {
      const settled = await this.settlePending(wallet, row);
      await this.collectFee(wallet, settled);
      if (settled.state !== 'failed') cards.push(cardView(settled));
    }
    return { enabled, cards };
  }

  async get(wallet: OpenWallet, id: string): Promise<CardView> {
    this.cards();
    const row = await this.own(wallet, id);
    const pending = await this.settlePending(wallet, row);
    if (pending.state === 'failed') throw this.notFound();
    const settled = await this.readThroughOnce(wallet, pending);
    await this.collectFee(wallet, settled);
    return cardView(settled);
  }

  /**
   * An active single-use card is read from the issuer when its screen is
   * opened, at most once a minute per card (CARD-USE, F1): the issuer sends no
   * event for the payment that uses it up, only a delivery that may be late.
   * Never on the list. The throttle is set before the call, so two screens at
   * once make one read, and nothing is held while the issuer answers. A read
   * that fails leaves the card as it was and never fails the screen.
   *
   * One "not found" never blocks a card for good: the person paid for it, and
   * one answer can be wrong (CARD-USE fix round 1, LOW-1). The first is noted
   * and logged and the card stays as it was; the card is blocked only when a
   * later read, at least a minute on, also gets Nuvion's own 404, and no read
   * has found the card in between.
   */
  private async readThroughOnce(
    wallet: OpenWallet,
    row: WalletCard,
  ): Promise<WalletCard> {
    if (
      row.state !== 'active' ||
      row.type !== 'single_use' ||
      !row.providerCardId
    ) {
      return row;
    }
    const now = Date.now();
    const last = this.readThrough.get(row.id);
    if (last !== undefined && now - last < READ_THROUGH_EVERY_MS) return row;
    for (const [book, keepMs] of [
      [this.readThrough, READ_THROUGH_EVERY_MS],
      [this.missingSince, MISSING_FORGOTTEN_MS],
    ] as const) {
      if (book.size < 500) continue;
      for (const [key, at] of book) {
        if (now - at >= keepMs) book.delete(key);
      }
    }
    this.readThrough.set(row.id, now);
    try {
      const card = await this.cards().getCard(
        { walletId: wallet.walletId },
        row.providerCardId,
      );
      this.missingSince.delete(row.id);
      const step = await followCardStatus(this.prisma, row, card.status);
      if (!step) return row;
      this.logger.log(
        `card ${row.id} (${row.type}): the issuer says ${card.status}; now ${stepWords(step)}`,
      );
    } catch (e) {
      // `not_found` is only ever Nuvion's own 404: a gateway page or an empty
      // body is `unavailable` (nuvion-error.ts, kindForStatus).
      const missing =
        e instanceof WalletProviderError &&
        e.kind === 'not_found' &&
        e.httpStatus === 404;
      if (!missing) {
        this.logger.warn(
          `card ${row.id}: not read from the issuer (${e instanceof WalletProviderError ? e.kind : 'error'}); left as it was`,
        );
        return row;
      }
      const first = this.missingSince.get(row.id);
      if (first === undefined || now - first < READ_THROUGH_EVERY_MS) {
        if (first === undefined) this.missingSince.set(row.id, now);
        this.logger.warn(
          `card ${row.id}: the issuer did not know it (not_found); left as it was`,
        );
        return row;
      }
      this.missingSince.delete(row.id);
      this.logger.warn(
        `card ${row.id}: the issuer did not know it on two reads a minute or more apart (not_found); blocked for good`,
      );
      await this.prisma.walletCard.updateMany({
        where: { id: row.id, state: 'active' },
        data: { state: 'cancelled', cancelledAt: new Date() },
      });
    }
    return (
      (await this.prisma.walletCard.findUnique({ where: { id: row.id } })) ??
      row
    );
  }

  async transactions(
    wallet: OpenWallet,
    id: string,
    query: { cursor?: string; limit?: number },
  ): Promise<CardTransactionPage> {
    const cards = this.cards();
    const row = await this.own(wallet, id);
    if (
      !row.providerCardId ||
      !['active', 'frozen', 'used'].includes(row.state)
    ) {
      return { items: [], nextCursor: null };
    }
    try {
      const page = await cards.listCardTransactions(
        { walletId: wallet.walletId },
        row.providerCardId,
        { cursor: query.cursor, limit: query.limit },
      );
      return {
        items: page.items.map((t) => ({
          id: t.id,
          kind: t.kind,
          amountCents: t.amountMinor,
          currency: t.currency,
          merchant: t.merchant,
          place: t.place,
          narration: t.narration,
          status: t.status,
          occurredAt: t.at ? t.at.toISOString() : null,
        })),
        nextCursor: page.nextCursor,
      };
    } catch (e) {
      throw await this.fail(e, row);
    }
  }

  // -------------------------------------------------------------------------
  // Making a card (W29)
  // -------------------------------------------------------------------------

  async create(
    wallet: OpenWallet,
    dto: CreateCardDto,
    scope: IdempotencyScope,
  ): Promise<CardView> {
    this.assertCreatable();
    const cards = this.cards();
    const wawu = this.wawuFee();
    await this.assertCanAfford(wallet, wawu.totalKobo);
    const kind: CardKind = dto.kind;
    const name = cleanCardName(dto.name) ?? DEFAULT_NAMES[kind];
    const reference = `wawu-card-${randomBytes(6).toString('hex')}`;

    // 1. Decide and claim under a short lock: one person's cards are counted
    //    and the row is written together, so two taps never pass the limit.
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wallet.wawuUserId}))`;
      this.refuseOverLimit(await this.counts(wallet.wawuUserId, tx));
      const made = await tx.walletCard.create({
        data: {
          wawuUserId: wallet.wawuUserId,
          provider: this.provider.name,
          reference,
          type: kind,
          name,
          state: 'creating',
          providerFeeKobo: BigInt(this.settings.providerFeeKobo ?? 0),
          wawuFeeKobo: BigInt(wawu.totalKobo),
        },
      });
      await this.keys.attach(tx, scope, made.id);
      return made;
    });
    await this.recordCardFee(row, wawu);

    // 2. Ask the provider, holding nothing.
    let card: ProviderCard;
    try {
      card = await cards.createCard({
        wallet: { walletId: wallet.walletId },
        type: kind,
        reference,
        currency: 'USD',
      });
    } catch (e) {
      return this.afterFailedCreate(wallet, row, e, scope);
    }

    // 3. Record it.
    return this.record(wallet, row, card, scope);
  }

  /**
   * The fee record of a card (R-140 point 2, kind `card_issue`): WAWU's fee,
   * the VAT, and what Nuvion is expected to charge for making it (the person
   * pays that on top, so WAWU keeps the whole fee). Written when the card is
   * claimed, once per card reference; never throws (the card goes on). Only
   * under Nuvion, whose fees the engine records.
   */
  private async recordCardFee(
    row: WalletCard,
    wawu: { feeKobo: number; vatKobo: number; scheduleId: string | null },
  ): Promise<void> {
    if (this.provider.name !== 'nuvion') return;
    try {
      await this.prisma.moneyFeeRecord.upsert({
        where: {
          provider_reference_kind: {
            provider: RATE_PROVIDER,
            reference: row.reference,
            kind: 'card_issue',
          },
        },
        create: {
          provider: RATE_PROVIDER,
          reference: row.reference,
          kind: 'card_issue',
          currency: 'NGN',
          amountMinor: 0n,
          wawuFeeMinor: BigInt(wawu.feeKobo),
          vatMinor: BigInt(wawu.vatKobo),
          providerExpectedMinor: BigInt(this.settings.providerFeeKobo ?? 0),
          keptMinor: BigInt(wawu.feeKobo),
          feeScheduleId: wawu.scheduleId,
        },
        update: {},
      });
    } catch (e) {
      this.logger.warn(
        `card ${row.id}: its fee record was not written (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** A card that failed: its record says WAWU kept nothing (status reversed, kept 0, VAT 0). */
  private async reverseCardFee(row: Pick<WalletCard, 'reference'>) {
    if (this.provider.name !== 'nuvion') return;
    await this.feeRecords.reverse(RATE_PROVIDER, row.reference, 'card_issue');
  }

  /**
   * The provider has made the card (and taken its fee): adopt it with its fee
   * row, collect WAWU's fee and finish the key. If the adoption cannot be
   * written (the ledger or the database failed), the card is NOT lost and the
   * key is not left open: the card is held `unknown`, the person is told it is
   * being confirmed (the same answer as a lost reply, 201 with PENDING_MESSAGE),
   * and the next read of the card (after 20 seconds) looks it up by its
   * reference and adopts it, with its fee row, exactly once. A replay of the key
   * returns the same answer.
   */
  private async record(
    wallet: OpenWallet,
    row: WalletCard,
    card: ProviderCard,
    scope: IdempotencyScope,
  ): Promise<CardView> {
    let saved: WalletCard;
    try {
      saved = await this.adopt(row, card, wallet);
    } catch (e) {
      this.logger.error(
        `card ${row.id}: the provider made it but it could not be recorded (${e instanceof Error ? e.name : 'error'}); held for the lookup by reference`,
      );
      const held = await this.prisma.walletCard.update({
        where: { id: row.id },
        data: { state: 'unknown' },
      });
      const view = cardView(held);
      await this.keys.finish(scope, 201, successBody(view));
      return view;
    }
    await this.collectFee(wallet, saved);
    const view = cardView(saved, card.last4);
    await this.keys.finish(scope, 201, successBody(view));
    return view;
  }

  private async afterFailedCreate(
    wallet: OpenWallet,
    row: WalletCard,
    e: unknown,
    scope: IdempotencyScope,
  ): Promise<CardView> {
    if (e instanceof WalletProviderError && e.recordMayExist) {
      // The call may have made the card: look for it by our reference.
      let found: ProviderCard | null = null;
      try {
        found = await this.cards().findCard(
          { walletId: wallet.walletId },
          row.reference,
        );
      } catch {
        found = null;
      }
      if (found) return this.record(wallet, row, found, scope);
      const unknown = await this.prisma.walletCard.update({
        where: { id: row.id },
        data: { state: 'unknown' },
      });
      const view = cardView(unknown);
      await this.keys.finish(scope, 201, successBody(view));
      this.logger.warn(
        `card ${row.id}: the answer was lost; it will be looked for by its reference`,
      );
      return view;
    }
    // A refusal: nothing was made. Say so, give the key back, and refuse.
    await this.prisma.walletCard.update({
      where: { id: row.id },
      data: { state: 'failed', failure: failureOf(e) },
    });
    await this.reverseCardFee(row);
    await this.keys.release(scope);
    throw await this.fail(e, row);
  }

  /**
   * The row now that the issuer has the card, by the same rules as every other
   * read of a card (`card-status.ts`): active; frozen when the issuer says
   * blocked; used when it says a single-use card is deactivated (it took its
   * one payment before it was found); frozen as support's for fraud, and for a
   * reusable card it calls deactivated. The write holds the row pending: a card
   * that was blocked for good, or used, while the issuer was being asked is not
   * brought back.
   */
  private async adopt(
    row: WalletCard,
    card: ProviderCard,
    wallet: Pick<OpenWallet, 'accountNumber'>,
  ): Promise<WalletCard> {
    const to = cardTargetFor(row, card.status);
    if (to.state === 'frozen' && to.frozenBy === 'admin') {
      this.logger.warn(
        `card ${row.id} (${row.type}): the issuer says ${card.status}; held as support's`,
      );
    }
    try {
      // The card is made and the issuer's fee is in the person's history in
      // one transaction (CARD-FEE-HISTORY): the provider has already taken the
      // fee, and a row that cannot be written leaves the card pending, to be
      // adopted again (the ledger keeps one row per reference).
      return await this.prisma.$transaction(async (tx) => {
        const made = await tx.walletCard.update({
          where: { id: row.id, state: { in: PENDING_STATES } },
          data: {
            providerCardId: card.id,
            state: to.state,
            frozenBy: to.frozenBy,
            failure: null,
          },
        });
        await recordIssuerFeeRow(this.ledger, tx, made, wallet.accountNumber);
        return made;
      });
    } catch (e) {
      // The delivery of `cards.created` may have adopted it a moment ago.
      const again = await this.prisma.walletCard.findUnique({
        where: { id: row.id },
      });
      if (again?.providerCardId === card.id) return again;
      throw e;
    }
  }

  /**
   * A row still waiting for the issuer's word is looked for by its reference
   * (once it is old enough), adopted when found, and given up when the issuer
   * does not know it for ten minutes. Reading never makes a card.
   */
  async settlePending(
    wallet: OpenWallet,
    row: WalletCard,
  ): Promise<WalletCard> {
    if (!PENDING_STATES.includes(row.state)) return row;
    const age = Date.now() - row.createdAt.getTime();
    if (age < LOOK_AFTER_MS) return row;
    try {
      const found = await this.cards().findCard(
        { walletId: wallet.walletId },
        row.reference,
      );
      if (found) return await this.adopt(row, found, wallet);
      if (age >= GIVE_UP_AFTER_MS) {
        const failed = await this.prisma.walletCard.update({
          where: { id: row.id },
          data: {
            state: 'failed',
            failure: GIVE_UP_FAILURE,
          },
        });
        await this.reverseCardFee(row);
        return failed;
      }
    } catch (e) {
      this.logger.warn(
        `card ${row.id}: not looked up yet (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // Details, freeze, unfreeze, block
  // -------------------------------------------------------------------------

  /** The number, expiry and CVV, read from the issuer now. Nothing is kept. */
  async reveal(wallet: OpenWallet, id: string): Promise<CardDetailsView> {
    const cards = this.cards();
    const row = await this.own(wallet, id);
    const live = this.needLive(row);
    try {
      const s = await cards.revealCard({ walletId: wallet.walletId }, live);
      return {
        number: s.number,
        expiryMonth: s.expirationMonth,
        expiryYear: s.expirationYear,
        cvv: s.cvv,
        cardholderName: s.cardholderName,
        billing: s.billing,
      };
    } catch (e) {
      throw await this.fail(e, row);
    }
  }

  async freeze(wallet: OpenWallet, id: string): Promise<CardView> {
    return this.control(wallet, id, 'person-freeze');
  }

  async unfreeze(wallet: OpenWallet, id: string): Promise<CardView> {
    return this.control(wallet, id, 'person-unfreeze');
  }

  /** Blocks the card for good (the issuer deletes it). */
  async block(wallet: OpenWallet, id: string): Promise<CardView> {
    return this.control(wallet, id, 'block');
  }

  /**
   * The one place a card changes state. `admin-*` acts for support on a
   * person's card (the person's own wallet ids are looked up by the caller).
   */
  async control(
    wallet: OpenWallet,
    id: string,
    action:
      | 'person-freeze'
      | 'person-unfreeze'
      | 'admin-freeze'
      | 'admin-unfreeze'
      | 'block',
  ): Promise<CardView> {
    const cards = this.cards();
    const row = await this.own(wallet, id);
    if (row.state === 'cancelled' || row.state === 'used') {
      if (action === 'block') return cardView(row);
      throw new MoneyError(
        'card_blocked',
        row.state === 'used' ? USED_MESSAGE : BLOCKED_MESSAGE,
      );
    }
    const live = this.needLive(row);
    const w = { walletId: wallet.walletId };
    try {
      if (action === 'block') {
        try {
          await cards.deleteCard(w, live);
        } catch (e) {
          // Already deleted at the issuer: it is blocked all the same.
          if (!(e instanceof WalletProviderError && e.kind === 'not_found')) {
            throw e;
          }
        }
        const done = await this.prisma.walletCard.update({
          where: { id: row.id },
          data: { state: 'cancelled', cancelledAt: new Date() },
        });
        return cardView(done);
      }
      if (action === 'person-freeze' || action === 'admin-freeze') {
        await cards.freezeCard(w, live);
        // A card support froze stays support's, whoever freezes it again.
        const frozenBy =
          action === 'admin-freeze' || row.frozenBy === 'admin'
            ? 'admin'
            : 'person';
        const done = await this.prisma.walletCard.update({
          where: { id: row.id },
          data: { state: 'frozen', frozenBy },
        });
        return cardView(done);
      }
      if (action === 'person-unfreeze' && row.frozenBy === 'admin') {
        throw new MoneyError('card_blocked', SUPPORT_FROZEN_MESSAGE);
      }
      await cards.unfreezeCard(w, live);
      const done = await this.prisma.walletCard.update({
        where: { id: row.id },
        data: { state: 'active', frozenBy: null },
      });
      return cardView(done);
    } catch (e) {
      if (e instanceof MoneyError) throw e;
      throw await this.fail(e, row);
    }
  }

  // -------------------------------------------------------------------------

  /** The person's own card, or 404: another person's id is never confirmed. */
  async own(wallet: OpenWallet, id: string): Promise<WalletCard> {
    const row = await this.prisma.walletCard.findFirst({
      where: { id, wawuUserId: wallet.wawuUserId },
    });
    if (!row) throw this.notFound();
    return row;
  }

  private notFound(): MoneyError {
    return new MoneyError('not_found', 'We could not find that card.');
  }

  /** The issuer's id of a card that can be acted on, or the refusal that says why not. */
  private needLive(row: WalletCard): string {
    if (row.state === 'cancelled') {
      throw new MoneyError('card_blocked', BLOCKED_MESSAGE);
    }
    if (row.state === 'used') {
      throw new MoneyError('card_blocked', USED_MESSAGE);
    }
    if (!row.providerCardId || PENDING_STATES.includes(row.state)) {
      throw new MoneyError('card_blocked', PENDING_ACTION_MESSAGE);
    }
    if (row.state === 'failed') throw this.notFound();
    return row.providerCardId;
  }

  /** A provider failure as the refusal a route answers with; a card the issuer no longer knows is blocked here. */
  private async fail(e: unknown, row: WalletCard): Promise<Error> {
    if (!(e instanceof WalletProviderError)) {
      return e instanceof Error ? e : new Error('card failed');
    }
    switch (e.kind) {
      case 'not_found':
        if (row.providerCardId && row.state !== 'cancelled') {
          await this.prisma.walletCard
            .update({
              where: { id: row.id },
              data: { state: 'cancelled', cancelledAt: new Date() },
            })
            .catch(() => undefined);
          return new MoneyError('card_blocked', BLOCKED_MESSAGE);
        }
        return this.notFound();
      case 'insufficient_funds': {
        const fee = this.settings.providerFeeKobo;
        return new MoneyError(
          'insufficient_funds',
          fee === null
            ? 'There is not enough money in the wallet for the card fee.'
            : `Your wallet needs ${koboText(fee)} for the card fee.`,
        );
      }
      case 'not_supported':
      case 'not_configured':
      case 'auth':
      case 'merchant_inactive':
      case 'validation':
      case 'refused':
      case 'identity_refused':
        this.logger.warn(`card ${row.id}: refused by the provider (${e.kind})`);
        return new MoneyError(
          'cards_unavailable',
          'We could not do that with your card right now. Nothing was taken from your wallet.',
        );
      case 'wallet_inactive':
        return walletProviderErrorToHttp('wallet_inactive');
      default:
        return e.toHttpException();
    }
  }
}

function failureOf(e: unknown): string {
  if (e instanceof WalletProviderError)
    return `The issuer refused it (${e.kind}).`;
  return 'The card could not be made.';
}
