import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AbroadRefusal,
  abroadOf,
  type AbroadHolder,
  type AbroadProvider,
} from '../../wallet-provider/abroad-provider';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import { isUniqueViolation } from '../prisma-unique';
import {
  ABROAD_COUNTRIES,
  ABROAD_DECIMALS,
  type AbroadCountryDef,
  type AbroadFieldDef,
  type AbroadRailDef,
  FIELDS,
  countryOf,
  fieldKeysFor,
  railOf,
} from './abroad-corridors';
import { AbroadSettings } from './abroad-settings';
import type {
  AbroadBankListView,
  AbroadCorridorsView,
  AbroadCountryView,
  AbroadFieldView,
  AbroadMethod,
  AbroadQuoteView,
  AbroadRailView,
  AbroadRecipientListView,
  AbroadRecipientView,
  AbroadSourcesView,
} from './abroad-view.type';
import type {
  AbroadQuoteDto,
  AbroadRecipientDto,
} from './dto/abroad-request.dto';

/** Nuvion's smallest amount to the recipient, in their currency's smallest unit (dev: "between 100 and ..."). */
export const ABROAD_MIN_RECEIVE_MINOR = 100;

const CURRENCY_NAMES: Record<string, string> = {
  NGN: 'Naira',
  USD: 'US dollar',
  EUR: 'Euro',
  GBP: 'British pound',
  CAD: 'Canadian dollar',
  AED: 'UAE dirham',
  GHS: 'Ghana cedi',
};

export const NOT_OFFERED_NOTE = 'We cannot send here yet.';
export const SWITCHED_OFF_MESSAGE =
  'Sending money abroad is switched off right now.';
export const FROZEN_MESSAGE =
  'Sending money abroad is paused on your account. Contact support to find out why.';
export const NOT_AVAILABLE_MESSAGE =
  'Sending money abroad is not available on this wallet yet.';

type RecipientRow = Prisma.AbroadRecipientGetPayload<object>;

/** The keys whose value is normalised before it is checked and sent. */
const SPACELESS = new Set([
  'account_number',
  'iban',
  'sort_code',
  'routing_number',
  'bsb',
  'transit_number',
  'bank_institution_number',
  'branch_code',
  'bank_code',
  'swift_bic',
  'phone_number',
]);

function normalise(key: string, raw: string): string {
  let v = raw.trim();
  if (SPACELESS.has(key)) v = v.replace(/[\s\-()]/g, '');
  if (key === 'iban' || key === 'swift_bic') v = v.toUpperCase();
  return v;
}

function fieldView(def: AbroadFieldDef): AbroadFieldView {
  return {
    key: def.key,
    label: def.label,
    kind: def.kind,
    pattern: def.pattern,
    hint: def.hint,
    options: def.options ? def.options.map((o) => ({ ...o })) : null,
  };
}

function railView(rail: AbroadRailDef): AbroadRailView {
  const schemes =
    rail.schemes.length > 0
      ? rail.schemes.map((s) => ({
          id: s.id as string | null,
          label: s.label,
          speed: s.speed,
          fields: fieldKeysFor(rail, s.id).map((k) => fieldView(FIELDS[k])),
        }))
      : [
          {
            id: null as string | null,
            label: rail.label,
            speed: rail.speed,
            fields: rail.fields.map((k) => fieldView(FIELDS[k])),
          },
        ];
  return {
    method: rail.method,
    label: rail.label,
    directory: rail.directory,
    schemes,
    minReceiveMinor: rail.minMinor,
    maxReceiveMinor: rail.maxMinor,
  };
}

export function countryView(
  c: AbroadCountryDef,
  off: ReadonlySet<string>,
): AbroadCountryView {
  const available = !off.has(c.country);
  return {
    country: c.country,
    name: c.name,
    currency: c.currency,
    decimals: ABROAD_DECIMALS,
    available,
    unavailableNote: available ? null : NOT_OFFERED_NOTE,
    rails: c.rails.map(railView),
  };
}

/** The sentence under a recipient in a list. */
function summaryOf(r: RecipientRow, country: AbroadCountryDef | null): string {
  const rail = country ? railOf(country, r.method as AbroadMethod) : null;
  const scheme = rail?.schemes.find((s) => s.id === r.scheme)?.label ?? null;
  const way = scheme ?? rail?.label ?? 'Account';
  const parts = [country?.name ?? r.country, way];
  if (r.last4) parts.push(`ending ${r.last4}`);
  return parts.join(', ');
}

export function recipientView(r: RecipientRow): AbroadRecipientView {
  const country = countryOf(r.country);
  return {
    id: r.id,
    country: r.country,
    countryName: country?.name ?? r.country,
    currency: r.currency,
    method: r.method as AbroadMethod,
    scheme: r.scheme,
    holderName: r.holderName,
    bankName: r.bankName,
    last4: r.last4,
    summary: summaryOf(r, country),
    createdAt: r.createdAt.toISOString(),
  };
}

/** How a person is told a corridor's speed, from the recipient's rail and scheme. */
export function speedOf(
  r: Pick<RecipientRow, 'country' | 'method' | 'scheme'>,
): string {
  const country = countryOf(r.country);
  const rail = country ? railOf(country, r.method as AbroadMethod) : null;
  if (!rail) return 'Not stated';
  return rail.schemes.find((s) => s.id === r.scheme)?.speed ?? rail.speed;
}

/** A refusal from the provider seam as the money error a person is shown. */
export function refusalError(r: AbroadRefusal, currency?: string): MoneyError {
  switch (r.reason) {
    case 'invalid_details':
      return new MoneyError('recipient_details_invalid', r.message, {
        fields: r.detail.fields,
      });
    case 'corridor_not_supported':
      return new MoneyError('corridor_not_supported', r.message);
    case 'rate_unavailable':
      return new MoneyError('rate_unavailable', r.message);
    case 'quote_expired':
      return new MoneyError('quote_expired', r.message);
    case 'amount_out_of_range':
      return new MoneyError('amount_out_of_range', r.message, {
        minimumMinor: r.detail.minimumMinor,
        currency,
      });
    case 'insufficient_funds':
      return new MoneyError('insufficient_funds', r.message, { currency });
    default:
      return new MoneyError('provider_declined', r.message);
  }
}

/** Any failure of a provider call as the error the route answers with. */
export function providerError(e: unknown, currency?: string): never {
  if (e instanceof AbroadRefusal) throw refusalError(e, currency);
  if (e instanceof WalletProviderError) throw e.toHttpException();
  throw e;
}

/**
 * Sending money abroad, the side that is not the send itself (task NUV-11,
 * R-84): what can be drawn (countries, rails, exact fields), the bank
 * directory, the accounts to send from, saved recipients and quotes. It
 * reaches the provider only through `WALLET_PROVIDER` and its `abroad` side
 * (src/wallet-provider/abroad-provider.ts); a provider without one (Fintava)
 * answers `currency_not_supported`. Nothing here is a balance: a source's
 * `availableMinor` is read from the provider on the request.
 */
@Injectable()
export class AbroadService {
  private readonly logger = new Logger(AbroadService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) readonly walletProvider: WalletProvider,
    readonly settings: AbroadSettings,
  ) {}

  // -- gates -----------------------------------------------------------------

  /** The provider's abroad side, or `currency_not_supported` when it has none. */
  provider(): AbroadProvider {
    const abroad = abroadOf(this.walletProvider);
    if (!abroad) {
      throw new MoneyError('currency_not_supported', NOT_AVAILABLE_MESSAGE);
    }
    return abroad;
  }

  /** The switch and the person's freeze, in that order. Reads our records only. */
  async assertOpenFor(wawuUserId: string): Promise<void> {
    if (!this.settings.enabled) {
      throw new MoneyError('fx_switched_off', SWITCHED_OFF_MESSAGE);
    }
    const frozen = await this.prisma.abroadFreeze.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (frozen) throw new MoneyError('account_frozen', FROZEN_MESSAGE);
  }

  /** The person's wallet as the provider seam names it. */
  static holder(
    wallet: Pick<OpenWallet, 'customerId' | 'walletId'>,
  ): AbroadHolder {
    return { customerId: wallet.customerId, walletId: wallet.walletId };
  }

  /** The holder of a person who is not making this request (the sweep, the admin). */
  async holderOf(wawuUserId: string): Promise<AbroadHolder | null> {
    const w = await this.prisma.fintavaWallet.findFirst({
      where: { wawuUserId, provider: this.walletProvider.name },
      select: { customerId: true, walletId: true },
    });
    return w ? { customerId: w.customerId, walletId: w.walletId } : null;
  }

  // -- what can be drawn -------------------------------------------------------

  corridors(): AbroadCorridorsView {
    const enabled = this.settings.enabled;
    const off = this.settings.countriesOff();
    return {
      enabled,
      minReceiveMinor: ABROAD_MIN_RECEIVE_MINOR,
      wawuFeeKobo: this.settings.wawuFeeKobo,
      countries: enabled
        ? ABROAD_COUNTRIES.map((c) => countryView(c, off))
        : [],
    };
  }

  async banks(country: string): Promise<AbroadBankListView> {
    const def = countryOf(country);
    if (!def || !def.rails.some((r) => r.directory)) {
      throw new MoneyError(
        'corridor_not_supported',
        'There is no bank list for that country.',
      );
    }
    const abroad = this.provider();
    try {
      return { country, banks: await abroad.banks(country) };
    } catch (e) {
      return providerError(e);
    }
  }

  async sources(wallet: OpenWallet): Promise<AbroadSourcesView> {
    const abroad = this.provider();
    try {
      const list = await abroad.sources(AbroadService.holder(wallet));
      return {
        sources: list.map((s) => ({
          currency: s.currency,
          name: `${CURRENCY_NAMES[s.currency] ?? s.currency} account`,
          decimals: ABROAD_DECIMALS,
          availableMinor: s.availableMinor,
        })),
      };
    } catch (e) {
      return providerError(e);
    }
  }

  // -- recipients ------------------------------------------------------------

  async listRecipients(wawuUserId: string): Promise<AbroadRecipientListView> {
    const rows = await this.prisma.abroadRecipient.findMany({
      where: { wawuUserId, removedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { items: rows.map(recipientView) };
  }

  async removeRecipient(wawuUserId: string, id: string): Promise<void> {
    const { count } = await this.prisma.abroadRecipient.updateMany({
      where: { id, wawuUserId, removedAt: null },
      data: { removedAt: new Date() },
    });
    if (count !== 1) {
      throw new MoneyError('not_found', 'We could not find that recipient.');
    }
  }

  /**
   * Checks a recipient's fields against its corridor: exactly the keys the
   * country and rail ask, each matching its pattern. Returns them normalised.
   * Refusals name the fields (`recipient_details_invalid`).
   */
  checkFields(
    rail: AbroadRailDef,
    scheme: string | null,
    given: Record<string, unknown>,
  ): Record<string, string> {
    const keys = fieldKeysFor(rail, scheme);
    const bad = new Set<string>();
    for (const k of Object.keys(given)) if (!keys.includes(k)) bad.add(k);
    const out: Record<string, string> = {};
    for (const k of keys) {
      const def = FIELDS[k];
      const raw = given[k];
      if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 200) {
        bad.add(k);
        continue;
      }
      const v = normalise(k, raw);
      if (def.pattern && !new RegExp(def.pattern).test(v)) bad.add(k);
      else if (def.options && !def.options.some((o) => o.value === v))
        bad.add(k);
      else out[k] = v;
    }
    if (bad.size > 0) {
      throw new MoneyError(
        'recipient_details_invalid',
        'Some details are missing or not in the form we need. Check the highlighted fields.',
        { fields: [...bad] },
      );
    }
    return out;
  }

  /** Tells a repeat of the same account without keeping it. */
  static fingerprint(
    wawuUserId: string,
    country: string,
    method: string,
    scheme: string | null,
    fields: Record<string, string>,
  ): string {
    const body = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k].toLowerCase()}`)
      .join('|');
    return createHash('sha256')
      .update([wawuUserId, country, method, scheme ?? '', body].join('\n'))
      .digest('hex');
  }

  async saveRecipient(
    wallet: OpenWallet,
    dto: AbroadRecipientDto,
  ): Promise<{ view: AbroadRecipientView; created: boolean }> {
    await this.assertOpenFor(wallet.wawuUserId);
    const abroad = this.provider();
    const country = countryOf(dto.country);
    if (!country || this.settings.countriesOff().has(dto.country)) {
      throw new MoneyError('corridor_not_supported', NOT_OFFERED_NOTE);
    }
    const rail = railOf(country, dto.method);
    if (!rail) {
      throw new MoneyError(
        'corridor_not_supported',
        `We cannot send to ${country.name} in that way.`,
      );
    }
    let scheme: string | null = null;
    if (rail.schemes.length > 0) {
      if (!rail.schemes.some((s) => s.id === dto.scheme)) {
        throw new MoneyError(
          'recipient_details_invalid',
          'Choose how it should arrive.',
          { fields: ['scheme'] },
        );
      }
      scheme = dto.scheme ?? null;
    } else if (dto.scheme !== undefined) {
      throw new MoneyError(
        'recipient_details_invalid',
        'That way of sending has no choice to make.',
        { fields: ['scheme'] },
      );
    }
    const holderName = dto.holderName.replace(/\s+/g, ' ').trim();
    if (holderName.length < 2) {
      throw new MoneyError(
        'recipient_details_invalid',
        'Enter the name on the account.',
        { fields: ['holderName'] },
      );
    }
    const fields = this.checkFields(rail, scheme, dto.fields);
    const fingerprint = AbroadService.fingerprint(
      wallet.wawuUserId,
      dto.country,
      dto.method,
      scheme,
      fields,
    );

    const existing = await this.prisma.abroadRecipient.findUnique({
      where: {
        wawuUserId_fingerprint: { wawuUserId: wallet.wawuUserId, fingerprint },
      },
    });
    if (existing) {
      const row =
        existing.removedAt === null
          ? existing
          : await this.prisma.abroadRecipient.update({
              where: { id: existing.id },
              data: { removedAt: null },
            });
      return { view: recipientView(row), created: false };
    }

    let saved;
    try {
      saved = await abroad.saveRecipient({
        holder: AbroadService.holder(wallet),
        country: dto.country,
        currency: country.currency,
        method: dto.method,
        scheme,
        holderName,
        fields,
        marker: fingerprint.slice(0, 40),
      });
    } catch (e) {
      return providerError(e);
    }

    const identity = ['account_number', 'iban', 'phone_number'].find(
      (k) => fields[k] !== undefined,
    );
    try {
      const row = await this.prisma.abroadRecipient.create({
        data: {
          wawuUserId: wallet.wawuUserId,
          country: dto.country,
          currency: country.currency,
          method: dto.method,
          scheme,
          holderName,
          bankName: saved.bankName,
          last4: identity ? fields[identity].slice(-4) : null,
          fingerprint,
          providerCounterpartyId: saved.counterpartyId,
          providerPaymentDetailId: saved.paymentDetailId,
        },
      });
      return { view: recipientView(row), created: true };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const row = await this.prisma.abroadRecipient.findUniqueOrThrow({
        where: {
          wawuUserId_fingerprint: {
            wawuUserId: wallet.wawuUserId,
            fingerprint,
          },
        },
      });
      return { view: recipientView(row), created: false };
    }
  }

  // -- limits ----------------------------------------------------------------

  /** What the person has sent abroad in the last 24 hours in a currency (failed, reversed and cancelled sends do not count). */
  async sentToday(
    tx: Prisma.TransactionClient | PrismaService,
    wawuUserId: string,
    currency: string,
    now = new Date(),
  ): Promise<bigint> {
    const sum = await tx.abroadSend.aggregate({
      _sum: { amountFromMinor: true },
      where: {
        wawuUserId,
        fromCurrency: currency,
        createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
        status: { notIn: ['failed', 'reversed', 'cancelled'] },
      },
    });
    return sum._sum.amountFromMinor ?? 0n;
  }

  /** WAWU's per-send and per-day most, when an admin set one. */
  async assertWithinLimits(
    tx: Prisma.TransactionClient | PrismaService,
    wawuUserId: string,
    currency: string,
    amountMinor: bigint,
  ): Promise<void> {
    const perSend = this.settings.maxPerSend(currency);
    if (perSend !== null && amountMinor > BigInt(perSend)) {
      throw new MoneyError(
        'amount_out_of_range',
        'That is more than can be sent in one go.',
        { maximumMinor: perSend, currency },
      );
    }
    const perDay = this.settings.maxPerDay(currency);
    if (perDay !== null) {
      const today = await this.sentToday(tx, wawuUserId, currency);
      if (today + amountMinor > BigInt(perDay)) {
        const left = Math.max(0, perDay - Number(today));
        throw new MoneyError(
          'daily_limit_exceeded',
          'That is more than you can send abroad today.',
          { remainingTodayMinor: left, limitMinor: perDay, currency },
        );
      }
    }
  }

  // -- quotes ----------------------------------------------------------------

  async quote(
    wallet: OpenWallet,
    dto: AbroadQuoteDto,
  ): Promise<AbroadQuoteView> {
    await this.assertOpenFor(wallet.wawuUserId);
    const abroad = this.provider();
    const recipient = await this.prisma.abroadRecipient.findFirst({
      where: {
        id: dto.recipientId,
        wawuUserId: wallet.wawuUserId,
        removedAt: null,
      },
    });
    if (!recipient) {
      throw new MoneyError('not_found', 'We could not find that recipient.');
    }
    const country = countryOf(recipient.country);
    if (!country || this.settings.countriesOff().has(recipient.country)) {
      throw new MoneyError('corridor_not_supported', NOT_OFFERED_NOTE);
    }
    const holder = AbroadService.holder(wallet);
    let sources;
    try {
      sources = await abroad.sources(holder);
    } catch (e) {
      return providerError(e);
    }
    const source = sources.find((s) => s.currency === dto.fromCurrency);
    if (!source) {
      throw new MoneyError(
        'fx_account_not_open',
        `You do not have a ${dto.fromCurrency} account to send from.`,
        { currency: dto.fromCurrency },
      );
    }
    const side = dto.side ?? 'send';
    let quote;
    try {
      quote = await abroad.quote({
        holder,
        fromCurrency: dto.fromCurrency,
        toCurrency: recipient.currency,
        fromAccountRef: source.accountRef,
        amountMinor: dto.amountMinor,
        side,
      });
    } catch (e) {
      return providerError(e, recipient.currency);
    }

    // The corridor's own range, in what the recipient gets.
    const rail = railOf(country, recipient.method as AbroadMethod);
    const min = Math.max(ABROAD_MIN_RECEIVE_MINOR, rail?.minMinor ?? 0);
    const max = rail?.maxMinor ?? null;
    if (
      quote.amountToMinor < min ||
      (max !== null && quote.amountToMinor > max)
    ) {
      throw new MoneyError(
        'amount_out_of_range',
        quote.amountToMinor < min
          ? 'That is less than this corridor can deliver.'
          : 'That is more than this corridor can deliver.',
        {
          minimumMinor: min,
          ...(max === null ? {} : { maximumMinor: max }),
          currency: recipient.currency,
        },
      );
    }

    const amountFrom = BigInt(quote.amountFromMinor);
    await this.assertWithinLimits(
      this.prisma,
      wallet.wawuUserId,
      dto.fromCurrency,
      amountFrom,
    );

    const feeKobo = this.settings.wawuFeeKobo;
    this.assertFunds(sources, dto.fromCurrency, quote.amountFromMinor, feeKobo);

    const row = await this.prisma.abroadQuote.create({
      data: {
        wawuUserId: wallet.wawuUserId,
        recipientId: recipient.id,
        fromCurrency: dto.fromCurrency,
        toCurrency: recipient.currency,
        fromAccountRef: source.accountRef,
        amountFromMinor: amountFrom,
        amountToMinor: BigInt(quote.amountToMinor),
        rate: quote.rate,
        providerQuoteId: quote.quoteRef,
        wawuFeeKobo: BigInt(feeKobo),
        expiresAt: quote.expiresAt,
      },
    });
    const validFor = Math.max(
      0,
      Math.min(
        quote.validForSeconds,
        Math.floor((quote.expiresAt.getTime() - Date.now()) / 1000),
      ),
    );
    return {
      id: row.id,
      recipientId: recipient.id,
      fromCurrency: row.fromCurrency,
      toCurrency: row.toCurrency,
      fromDecimals: ABROAD_DECIMALS,
      toDecimals: ABROAD_DECIMALS,
      amountFromMinor: quote.amountFromMinor,
      amountToMinor: quote.amountToMinor,
      converted: quote.quoteRef !== null,
      rate: quote.rate,
      providerFeeMinor: null,
      wawuFeeKobo: feeKobo,
      speed: speedOf(recipient),
      expiresAt: row.expiresAt.toISOString(),
      validForSeconds: validFor,
    };
  }

  /**
   * The account holds the amount (and, from the naira wallet, WAWU's fee on
   * top; from a foreign account the fee is taken from the naira wallet, so
   * that must hold it). The provider's balance, read just now, is the truth.
   */
  private assertFunds(
    sources: { currency: string; availableMinor: number | null }[],
    currency: string,
    amountMinor: number,
    feeKobo: number,
  ): void {
    const from = sources.find((s) => s.currency === currency);
    const owed = currency === 'NGN' ? amountMinor + feeKobo : amountMinor;
    if (from && from.availableMinor !== null && from.availableMinor < owed) {
      throw new MoneyError(
        'insufficient_funds',
        'There is not enough money in that account for this send.',
        {
          balanceMinor: from.availableMinor,
          totalMinor: owed,
          shortfallMinor: owed - from.availableMinor,
          currency,
        },
      );
    }
    if (currency !== 'NGN' && feeKobo > 0) {
      const naira = sources.find((s) => s.currency === 'NGN');
      if (
        naira &&
        naira.availableMinor !== null &&
        naira.availableMinor < feeKobo
      ) {
        throw new MoneyError(
          'insufficient_funds',
          "There is not enough in your naira wallet for WAWU's fee on this send.",
          {
            balanceKobo: naira.availableMinor,
            totalKobo: feeKobo,
            shortfallKobo: feeKobo - naira.availableMinor,
          },
        );
      }
    }
  }
}
