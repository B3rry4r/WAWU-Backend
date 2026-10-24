import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FxAccountsService } from '../fx/fx-accounts.service';
import {
  FX_CURRENCIES,
  FX_FIAT_CODES,
  type FxFiatCode,
  fxCurrency,
} from '../fx/fx-currencies';
import { FxSettings } from '../fx/fx-settings';
import { MoneyError } from '../money-error';
import { isFiatCode, listCountries } from './world-countries';
import { WorldSettings } from './world-settings';
import type {
  WorldCountriesView,
  WorldOptionsView,
  WorldWalletView,
} from './world-view.type';

/** A first-account request older than this lost its answer and may be tried again. */
const FIRST_ACCOUNT_STALE_MS = 2 * 60_000;

export const WORLD_SWITCHED_OFF_MESSAGE =
  'Opening a wallet from outside Nigeria is switched off for now. Try again later.';
export const WORLD_LIMIT_MESSAGE =
  'We are opening a limited number of wallets each day and today is full. Try again tomorrow.';
export const COUNTRY_NOT_SUPPORTED_MESSAGE =
  'We cannot open a wallet for a person in that country yet.';
export const CURRENCY_OFF_MESSAGE =
  'That currency is not available right now. Pick another.';

function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** The opening row's world columns, as the view and the first account read them. */
export interface WorldRow {
  worldCountry: string | null;
  worldFirstCurrency: string | null;
  worldAccountOpenedAt: Date | null;
  worldFrozenAt: Date | null;
  worldCancelledAt: Date | null;
}

/** GET /money/wallet's `world` block, from the opening row; undefined for a Nigerian opening. */
export function worldViewOf(row: WorldRow | null): WorldWalletView | undefined {
  if (!row?.worldCountry) return undefined;
  const first =
    row.worldFirstCurrency && isFiatCode(row.worldFirstCurrency)
      ? row.worldFirstCurrency
      : null;
  const state = row.worldCancelledAt
    ? 'cancelled'
    : row.worldFrozenAt
      ? 'frozen'
      : row.worldAccountOpenedAt
        ? 'open'
        : 'opening';
  return {
    country: row.worldCountry,
    firstCurrency: first,
    state,
    accountOpenedAt: row.worldAccountOpenedAt?.toISOString() ?? null,
  };
}

/**
 * A person outside Nigeria opens a wallet without a BVN (task WALLET-41,
 * R-87). What this service does:
 *
 * - `options`: what the person is offered before they open (the country's
 *   own currency first, every enabled one to pick from, the quoted fee);
 * - `guardOpen`: refuses an opening the switch, the country list or the
 *   day's cap does not allow, and settles the first currency;
 * - `ensureFirstAccount`: once Nuvion approved the person, opens the first
 *   account in the chosen currency, exactly once. It is called by Nuvion's
 *   `entities.updated` handler and by `POST /money/world/first-account`
 *   (for a delivery that never came).
 *
 * The opening itself (the entity, its documents and liveness) is the
 * reviewed opening's, unchanged (src/money/opening/reviewed-opening.ts).
 * Reaches the provider only through `FxAccountsService` (R-39).
 */
@Injectable()
export class WorldWalletService {
  private readonly logger = new Logger(WorldWalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: WorldSettings,
    private readonly fx: FxSettings,
    private readonly accounts: FxAccountsService,
  ) {}

  /** Every country a person may say they live in (region data, not a list of ours). */
  countries(): WorldCountriesView {
    return { countries: listCountries() };
  }

  async options(country: string): Promise<WorldOptionsView> {
    const suggested = this.settings.suggestedFor(country);
    const abroad = country !== 'NG';
    let unavailableReason: WorldOptionsView['unavailableReason'] = null;
    if (!abroad) unavailableReason = 'nigeria';
    else if (!this.settings.openOn() || !this.fx.productOn('open_account')) {
      unavailableReason = 'switched_off';
    } else if (this.settings.isBlocked(country)) {
      unavailableReason = 'country_blocked';
    } else if (await this.capReached()) unavailableReason = 'limit_reached';
    return {
      country,
      abroad,
      available: unavailableReason === null,
      unavailableReason,
      suggested,
      choices: FX_FIAT_CODES.map((code) => ({
        code,
        name: fxCurrency(code)!.name,
        decimals: this.fx.decimalsOf(code),
        enabled: this.fx.currencyOn(code),
      })),
      openFee: {
        currency: suggested,
        amountMinor: Number(this.settings.openFeeMinor(suggested)),
      },
    };
  }

  /**
   * Runs before a world opening is claimed. Refuses (nothing is sent on):
   * the switch off, a country held back, a currency that is off, and, for a
   * person with no world opening yet, the day's cap. Answers the first
   * currency: the person's pick, or the country's own.
   */
  async guardOpen(
    wawuUserId: string,
    country: string,
    picked: string | undefined,
  ): Promise<FxFiatCode> {
    if (!this.settings.openOn() || !this.fx.productOn('open_account')) {
      throw new MoneyError('world_switched_off', WORLD_SWITCHED_OFF_MESSAGE);
    }
    if (this.settings.isBlocked(country)) {
      throw new MoneyError(
        'country_not_supported',
        COUNTRY_NOT_SUPPORTED_MESSAGE,
      );
    }
    const code = picked ?? this.settings.suggestedFor(country);
    if (!isFiatCode(code) || !this.fx.currencyOn(code)) {
      throw new MoneyError('fx_switched_off', CURRENCY_OFF_MESSAGE);
    }
    const mine = await this.prisma.fintavaWalletOpening.findUnique({
      where: { wawuUserId },
      select: { worldCountry: true },
    });
    if (mine?.worldCountry == null && (await this.capReached())) {
      throw new MoneyError('world_limit_reached', WORLD_LIMIT_MESSAGE);
    }
    return code;
  }

  private async capReached(): Promise<boolean> {
    const limit = this.settings.dailyLimit();
    if (limit === null) return false;
    const today = await this.prisma.fintavaWalletOpening.count({
      where: {
        worldCountry: { not: null },
        createdAt: { gte: startOfUtcDay() },
      },
    });
    return today >= limit;
  }

  /**
   * Opens the first account of an approved world person, once. `opened`
   * when it is open now; `already` when it was before; `waiting` when
   * Nuvion has not approved the person yet or another request is on it;
   * `blocked` when an admin froze or cancelled it; `not_world` for anyone
   * else. A provider refusal reaches the caller as the money error the
   * foreign accounts routes give (`provider_declined`, `fx_switched_off` ...),
   * and the claim goes back so the next request tries again.
   */
  async ensureFirstAccount(
    wawuUserId: string,
    pick?: FxFiatCode,
  ): Promise<'opened' | 'already' | 'waiting' | 'blocked' | 'not_world'> {
    const row = await this.prisma.fintavaWalletOpening.findUnique({
      where: { wawuUserId },
      select: {
        worldCountry: true,
        worldFirstCurrency: true,
        worldAccountOpenedAt: true,
        worldFrozenAt: true,
        worldCancelledAt: true,
      },
    });
    if (!row?.worldCountry) return 'not_world';
    if (row.worldAccountOpenedAt) return 'already';
    if (row.worldFrozenAt || row.worldCancelledAt) return 'blocked';
    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { wawuUserId },
      select: { entityId: true, status: true },
    });
    // The person may choose another first currency until one is open (for
    // example when the provider declined the first for their country).
    if (pick !== undefined && pick !== row.worldFirstCurrency) {
      if (!this.fx.currencyOn(pick)) {
        throw new MoneyError('fx_switched_off', CURRENCY_OFF_MESSAGE);
      }
      await this.prisma.fintavaWalletOpening.updateMany({
        where: {
          wawuUserId,
          worldAccountOpenedAt: null,
          worldFrozenAt: null,
          worldCancelledAt: null,
        },
        data: { worldFirstCurrency: pick, worldAccountRequestedAt: null },
      });
      row.worldFirstCurrency = pick;
    }
    if (!entity?.entityId || entity.status !== 'approved') return 'waiting';
    const currency = row.worldFirstCurrency;
    if (!currency || !isFiatCode(currency)) return 'waiting';

    // The claim: one request asks Nuvion at a time; a lost one may be
    // asked again after the stale window (the foreign account service looks
    // for the account first, so nothing is made twice).
    const now = new Date();
    const claimed = await this.prisma.fintavaWalletOpening.updateMany({
      where: {
        wawuUserId,
        worldAccountOpenedAt: null,
        worldFrozenAt: null,
        worldCancelledAt: null,
        OR: [
          { worldAccountRequestedAt: null },
          {
            worldAccountRequestedAt: {
              lt: new Date(now.getTime() - FIRST_ACCOUNT_STALE_MS),
            },
          },
        ],
      },
      data: { worldAccountRequestedAt: now },
    });
    if (claimed.count !== 1) return 'waiting';
    const release = () =>
      this.prisma.fintavaWalletOpening.updateMany({
        where: { wawuUserId, worldAccountOpenedAt: null },
        data: { worldAccountRequestedAt: null },
      });
    let view;
    try {
      view = await this.accounts.open(
        {
          wawuUserId,
          customerId: entity.entityId,
          walletId: '',
          accountNumber: '',
        },
        { currency },
      );
    } catch (e) {
      await release();
      throw e;
    }
    if (view.status === 'opening') {
      // Nuvion has not answered yet: asked again on the next request.
      await release();
      return 'waiting';
    }
    const marked = await this.prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, worldAccountOpenedAt: null },
      data: { worldAccountOpenedAt: new Date() },
    });
    if (marked.count === 1) {
      this.logger.log(
        `world wallet: first account (${currency}) opened for a person in ${row.worldCountry}`,
      );
    }
    return 'opened';
  }

  /** The currencies an admin has left on, for tests and the options. */
  enabledFiat(): FxFiatCode[] {
    return FX_CURRENCIES.filter(
      (c) => c.kind === 'fiat' && this.fx.currencyOn(c.code),
    ).map((c) => c.code as FxFiatCode);
  }
}
