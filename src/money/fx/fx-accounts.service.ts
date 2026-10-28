import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { FxAccount } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import { isUniqueViolation } from '../prisma-unique';
import type { ProviderFxChain } from '../../wallet-provider/wallet-provider-fx';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { OpenFxAccountDto } from './dto/fx-request.dto';
import { FX_CURRENCIES, fxCurrency } from './fx-currencies';
import { nameOwnLines } from './fx-own-lines';
import { FxPort, providerFailure } from './fx-provider';
import { FxSettings } from './fx-settings';
import { accountView, num } from './fx-views';
import type {
  FxAccountListView,
  FxAccountView,
  FxCurrenciesView,
  FxTransactionPage,
  FxTransactionView,
} from './fx-view.type';

/** An `opening` row older than this has lost its answer and may be tried again. */
const OPENING_STALE_MS = 2 * 60_000;
/** Months of statement walked back in one history, and lines read of one month. */
const MAX_MONTHS_BACK = 12;
const MONTH_LINES = 500;
const PAGE_LINES = 100;
/** How long the operational account's name is remembered, and how soon it is asked for again when the provider could not say. */
const OPERATIONAL_NAME_MS = 5 * 60_000;
const OPERATIONAL_NAME_RETRY_MS = 30_000;
/**
 * NUVION-FIX 9.5: the provider makes an account's details later (5 to 30 minutes), so they are asked for at most this often,
 * however often the wallet is read. Reading what exists is not limited.
 */
export const DETAILS_ASK_EVERY_MS = 5 * 60_000;

/** What an account's details say when the provider could not be asked at all. */
export const DETAILS_UNREAD_MESSAGE =
  'The provider could not be reached just now.';

export const OPENING_MESSAGE =
  'This account is still being opened. Check again in a moment.';

interface FxHistoryCursor {
  y: number;
  m: number;
  o: number;
}

function encodeCursor(c: FxHistoryCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(raw: string): FxHistoryCursor {
  try {
    const c = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<FxHistoryCursor>;
    if (
      Number.isInteger(c.y) &&
      Number.isInteger(c.m) &&
      Number.isInteger(c.o) &&
      c.m! >= 1 &&
      c.m! <= 12 &&
      c.o! >= 0 &&
      c.y! >= 2000 &&
      c.y! <= 2200
    ) {
      return c as FxHistoryCursor;
    }
  } catch {
    // falls through
  }
  throw new BadRequestException('cursor is not one this list gave');
}

/**
 * The person's foreign accounts (task WALLET-21, R-83, R-84): which currencies
 * can be opened, the accounts with the provider's balances and receiving
 * details, opening one, and an account's history from the provider's
 * statement. Everything goes through `WALLET_PROVIDER` (FxPort).
 */
@Injectable()
export class FxAccountsService {
  private readonly logger = new Logger(FxAccountsService.name);
  /** The last refusal of each account's details, told while the next ask is waited out (this server only; null-safe on any other). */
  private readonly refusals = new Map<
    string,
    { note: string; until: number }
  >();

  constructor(
    private readonly port: FxPort,
    private readonly prisma: PrismaService,
    private readonly settings: FxSettings,
  ) {}

  currencies(): FxCurrenciesView {
    this.port.get();
    return {
      currencies: FX_CURRENCIES.map((c) => ({
        code: c.code,
        name: c.name,
        kind: c.kind,
        decimals: this.settings.decimalsOf(c.code),
        chains: [...c.chains],
        enabled: this.settings.currencyOn(c.code),
      })),
      products: {
        openAccount: this.settings.productOn('open_account'),
        swap: this.settings.productOn('swap'),
        cryptoSend: this.settings.productOn('crypto_send'),
      },
      naira: { code: 'NGN', decimals: 2 },
    };
  }

  async list(wallet: OpenWallet): Promise<FxAccountListView> {
    this.port.get();
    const rows = await this.prisma.fxAccount.findMany({
      where: { wawuUserId: wallet.wawuUserId, provider: this.port.name },
      orderBy: { createdAt: 'asc' },
    });
    const accounts = await Promise.all(
      rows.map((r) => this.view(wallet, r, false)),
    );
    return { accounts };
  }

  async get(wallet: OpenWallet, id: string): Promise<FxAccountView> {
    this.port.get();
    return this.view(wallet, await this.rowFor(wallet.wawuUserId, id), true);
  }

  /** One of the caller's own accounts at the running provider, or `not_found`. */
  async rowFor(wawuUserId: string, id: string): Promise<FxAccount> {
    const row = await this.prisma.fxAccount.findUnique({ where: { id } });
    if (
      !row ||
      row.wawuUserId !== wawuUserId ||
      row.provider !== this.port.name
    ) {
      throw new MoneyError('not_found', 'We could not find that account.');
    }
    return row;
  }

  async open(
    wallet: OpenWallet,
    dto: OpenFxAccountDto,
  ): Promise<FxAccountView> {
    const fx = this.port.get();
    const def = fxCurrency(dto.currency);
    if (!def) throw new BadRequestException('currency is not one we hold');
    // WALLET-41: an admin froze this person's world wallet; nothing new opens.
    const frozen = await this.prisma.fintavaWalletOpening.findUnique({
      where: { wawuUserId: wallet.wawuUserId },
      select: { worldFrozenAt: true },
    });
    if (frozen?.worldFrozenAt) {
      throw new MoneyError(
        'account_frozen',
        'This wallet is frozen. No new account can be opened.',
      );
    }
    if (
      !this.settings.productOn('open_account') ||
      !this.settings.currencyOn(def.code)
    ) {
      throw new MoneyError(
        'fx_switched_off',
        `Opening ${def.code} accounts is switched off for now.`,
      );
    }
    let chain: ProviderFxChain | null = null;
    if (def.kind === 'stablecoin') {
      if (!dto.chain || !def.chains.includes(dto.chain)) {
        throw new MoneyError(
          'chain_mismatch',
          `${def.code} is held on ${def.chains.join(', ')}. Pick one of them.`,
        );
      }
      chain = dto.chain;
    } else if (dto.chain) {
      throw new MoneyError('chain_mismatch', `${def.code} has no chain.`);
    }
    const key = {
      wawuUserId: wallet.wawuUserId,
      provider: this.port.name,
      currency: def.code,
      chain: chain ?? '',
    };
    let row = await this.prisma.fxAccount.findUnique({
      where: { wawuUserId_provider_currency_chain: key },
    });
    if (row?.providerAccountId) return this.view(wallet, row, true);
    if (row && Date.now() - row.updatedAt.getTime() < OPENING_STALE_MS) {
      return this.view(wallet, row, false);
    }
    if (!row) {
      try {
        row = await this.prisma.fxAccount.create({
          data: {
            ...key,
            providerCustomerId: wallet.customerId,
            status: 'opening',
          },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        row = await this.prisma.fxAccount.findUnique({
          where: { wawuUserId_provider_currency_chain: key },
        });
        if (!row) throw e;
        return this.view(wallet, row, false);
      }
    } else {
      // A lost answer from long ago: claim it again for this try.
      await this.prisma.fxAccount.update({
        where: { id: row.id },
        data: { updatedAt: new Date() },
      });
    }
    // Holding nothing across the call: the row is the claim.
    let opened;
    try {
      opened = await fx.openAccount({
        person: this.port.person(wallet),
        currency: def.code,
        chain,
        displayName: `WAWU ${def.code}${chain ? ` ${chain}` : ''} ${row.id.slice(0, 8)}`,
        holderName: 'WAWU member',
      });
    } catch (e) {
      if (e instanceof WalletProviderError && !e.recordMayExist) {
        await this.prisma.fxAccount.deleteMany({
          where: { id: row.id, providerAccountId: null },
        });
      } else {
        this.logger.warn(
          `open ${def.code}: outcome unknown; the row stays opening until the provider says`,
        );
      }
      throw providerFailure(e);
    }
    const asked = new Date();
    const saved = await this.prisma.fxAccount.update({
      where: { id: row.id },
      data: {
        providerAccountId: opened.account.accountId,
        ban: opened.account.ban,
        detailsId: opened.details?.detailsId ?? null,
        status: 'open',
        // The details were asked for in the call above (NUVION-FIX 9.5), and a number ready at once is seen by the person
        // here, so it is not news later (9.6).
        detailsAskedAt: asked,
        ...(opened.details?.status === 'active'
          ? { detailsReadyAt: asked }
          : {}),
      },
    });
    this.rememberRefusal(saved, opened.details, opened.detailsRefusal);
    return accountView(
      saved,
      this.settings,
      opened.account,
      opened.details,
      opened.detailsRefusal,
    );
  }

  /** One account's view: the provider's balance and details, each null if it cannot be read. */
  private async view(
    wallet: OpenWallet,
    row: FxAccount,
    ensureDetails: boolean,
  ): Promise<FxAccountView> {
    if (!row.providerAccountId)
      return accountView(row, this.settings, null, null);
    const fx = this.port.get();
    const person = this.port.person(wallet);
    // Details never seen for this account are asked for (made, if the
    // provider holds none) so the app can say exactly where they stand: an
    // account whose details the provider refused is told so, in its words.
    // NUVION-FIX 9.5: asked for at most every 5 minutes (a conditional write is
    // the claim, so two reads at once ask once); between asks the details are
    // only read, and the last refusal is still told.
    const ensure =
      (ensureDetails || row.detailsId === null) && (await this.claimAsk(row));
    const [balance, read] = await Promise.all([
      fx
        .readAccount(person, row.providerAccountId)
        .catch((e: unknown) => this.unread(row, 'balance', e)),
      fx
        .readDetails(
          person,
          {
            accountId: row.providerAccountId,
            currency: row.currency,
            chain: (row.chain || null) as ProviderFxChain | null,
          },
          ensure,
        )
        .catch((e: unknown) => {
          this.unread(row, 'details', e);
          return { details: null, refusal: DETAILS_UNREAD_MESSAGE };
        }),
    ]);
    const details = read.details;
    if (details && details.detailsId !== row.detailsId) {
      await this.prisma.fxAccount
        .update({
          where: { id: row.id },
          data: { detailsId: details.detailsId },
        })
        .catch(() => undefined);
    }
    // NUVION-FIX 9.6: details the person sees ready on their own read are not news later (the ready notice is written once, by
    // whoever sees them active first, in src/nuvion/handlers/fx.handler.ts).
    if (details?.status === 'active' && row.detailsReadyAt === null) {
      await this.prisma.fxAccount
        .updateMany({
          where: { id: row.id, detailsReadyAt: null },
          data: { detailsReadyAt: new Date() },
        })
        .catch(() => undefined);
    }
    if (ensure || details) this.rememberRefusal(row, details, read.refusal);
    const refusal = read.refusal ?? (details ? null : this.remembered(row.id));
    return accountView(row, this.settings, balance, details, refusal);
  }

  /** One ask per account per 5 minutes: true for the read that wins the claim. */
  private async claimAsk(row: FxAccount): Promise<boolean> {
    const now = new Date();
    const claimed = await this.prisma.fxAccount.updateMany({
      where: {
        id: row.id,
        OR: [
          { detailsAskedAt: null },
          {
            detailsAskedAt: {
              lt: new Date(now.getTime() - DETAILS_ASK_EVERY_MS),
            },
          },
        ],
      },
      data: { detailsAskedAt: now },
    });
    return claimed.count === 1;
  }

  private rememberRefusal(
    row: Pick<FxAccount, 'id'>,
    details: unknown,
    refusal: string | null,
  ): void {
    if (details || refusal === null) {
      this.refusals.delete(row.id);
      return;
    }
    this.refusals.set(row.id, {
      note: refusal,
      until: Date.now() + DETAILS_ASK_EVERY_MS,
    });
  }

  private remembered(id: string): string | null {
    const r = this.refusals.get(id);
    if (!r) return null;
    if (r.until <= Date.now()) {
      this.refusals.delete(id);
      return null;
    }
    return r.note;
  }

  private unread(row: FxAccount, what: string, e: unknown): null {
    this.logger.warn(
      `fx account ${row.id}: ${what} could not be read (${e instanceof WalletProviderError ? e.kind : 'error'})`,
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  async transactions(
    wallet: OpenWallet,
    id: string,
    query: { cursor?: string; limit?: number },
  ): Promise<FxTransactionPage> {
    const fx = this.port.get();
    const row = await this.rowFor(wallet.wawuUserId, id);
    if (!row.providerAccountId) return { items: [], nextCursor: null };
    const limit = query.limit ?? 20;
    const now = new Date();
    let at: FxHistoryCursor = query.cursor
      ? decodeCursor(query.cursor)
      : { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, o: 0 };
    const earliest =
      row.createdAt.getUTCFullYear() * 12 + row.createdAt.getUTCMonth();
    const person = this.port.person(wallet);
    const items: FxTransactionView[] = [];
    const names = await this.operationalNames();
    let months = 0;
    try {
      while (items.length < limit && months < MAX_MONTHS_BACK) {
        const lines = await this.month(fx, person, row, at, names);
        const take = lines.slice(at.o, at.o + (limit - items.length));
        items.push(...take);
        if (at.o + take.length < lines.length) {
          return {
            items,
            nextCursor: encodeCursor({ ...at, o: at.o + take.length }),
          };
        }
        const prev =
          at.m === 1 ? { y: at.y - 1, m: 12 } : { y: at.y, m: at.m - 1 };
        months += 1;
        if (prev.y * 12 + (prev.m - 1) < earliest)
          return { items, nextCursor: null };
        at = { ...prev, o: 0 };
      }
    } catch (e) {
      throw providerFailure(e);
    }
    return {
      items,
      nextCursor:
        months >= MAX_MONTHS_BACK || items.length < limit
          ? null
          : encodeCursor(at),
    };
  }

  /**
   * The operational account's own display name as the provider reads it (FIX-P6 round 2): a line whose other side bears it is
   * WAWU's own, whatever the account is called. Remembered for a few minutes; a provider that cannot say gives none (the names
   * the adapter itself uses still stand) and is asked again soon.
   */
  private operational: { names: string[]; until: number } | null = null;

  private async operationalNames(): Promise<string[]> {
    const now = Date.now();
    if (this.operational && this.operational.until > now) {
      return this.operational.names;
    }
    let names: string[] = [];
    let keep = OPERATIONAL_NAME_MS;
    try {
      const account = await this.port.provider.getPlatformAccount();
      names = account.accountName ? [account.accountName] : [];
    } catch {
      keep = OPERATIONAL_NAME_RETRY_MS;
    }
    this.operational = { names, until: now + keep };
    return names;
  }

  /** A month's lines, newest first. */
  private async month(
    fx: ReturnType<FxPort['get']>,
    person: ReturnType<FxPort['person']>,
    row: FxAccount,
    at: FxHistoryCursor,
    operational: readonly string[],
  ): Promise<FxTransactionView[]> {
    const out: FxTransactionView[] = [];
    let cursor: string | null = null;
    const def = fxCurrency(row.currency)!;
    for (let page = 0; page < MONTH_LINES / PAGE_LINES; page += 1) {
      const p = await fx.statement(
        person,
        { accountId: row.providerAccountId!, currency: row.currency },
        { year: at.y, month: at.m, cursor, limit: PAGE_LINES },
      );
      for (const l of p.lines) {
        out.push({
          id: l.id,
          accountId: row.id,
          currency: def.code,
          direction: l.direction,
          status: l.status,
          amountMinor: num(l.amountMinor),
          feeMinor: num(l.feeMinor),
          balanceAfterMinor:
            l.balanceAfterMinor === null ? null : num(l.balanceAfterMinor),
          description: l.description,
          counterpartyName: l.counterpartyName,
          reference: l.reference,
          occurredAt: l.occurredAt,
          conversion: l.conversion
            ? {
                fromCurrency: l.conversion
                  .fromCurrency as FxTransactionView['currency'],
                toCurrency: l.conversion
                  .toCurrency as FxTransactionView['currency'],
                rate: l.conversion.rate,
                fromMinor: num(l.conversion.fromMinor),
                toMinor: num(l.conversion.toMinor),
              }
            : null,
        });
      }
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    // FIX-P6 L2: a line WAWU made is named by what it was for, never by WAWU's internal account.
    await nameOwnLines(
      this.prisma,
      { wawuUserId: row.wawuUserId, fxAccountId: row.id },
      out,
      operational,
    );
    return out.sort((a, b) =>
      a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
    );
  }
}
