import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type {
  FxAccount,
  FxQuote,
  WalletPayment,
  WalletPaymentFx,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  ProviderForeignAccounts,
  ProviderFxQuote,
  ProviderFxTransfer,
  ProviderFxTransferLookup,
} from '../../wallet-provider/wallet-provider-fx';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { fxCurrency } from '../fx/fx-currencies';
import { FxPort, providerFailure } from '../fx/fx-provider';
import { FxSettings } from '../fx/fx-settings';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import type {
  PaymentPaidFromView,
  PaymentSourceView,
} from '../money-view.type';

/** What a firm quote's token looks like: `fx.` and our FxQuote row's id. */
const TOKEN_PREFIX = 'fx.';
/** A quote with less than this left is not used: the provider may refuse it on the way. */
const MARGIN_MS = 8_000;
export const SOURCE_CURRENCY_MESSAGE =
  "That currency can't be used to pay for this.";
export const NO_SOURCE_ACCOUNT_MESSAGE =
  "You don't have an open account in that currency.";
export const NO_REVERSE_MESSAGE =
  'This payment cannot be paid back to the account it came from right now.';

export const num = (n: bigint): number => Number(n);

/** The firm quote the buyer is shown, ready to pay with. */
export interface SourceQuote {
  row: FxQuote;
  account: FxAccount;
  view: PaymentSourceView;
}

/**
 * Paying a naira price from an account in another currency (task PAY-FX,
 * R-91). Through `WALLET_PROVIDER` only (R-39): a firm quote for the exact
 * naira price, the move into WAWU's own naira account with that quote, and,
 * for a refund, the conversion the other way back to the account the money
 * came from. What happens to the naira after it lands is the payment
 * service's, unchanged.
 *
 * The rules the other money movers follow hold here: the quote is spent in
 * the claim's own transaction, nothing is held across a provider call, a
 * lost answer is looked up by our reference and never sent again.
 */
@Injectable()
export class PaymentFxService {
  private readonly logger = new Logger(PaymentFxService.name);
  private sweepingFees = false;

  constructor(
    private readonly port: FxPort,
    private readonly prisma: PrismaService,
    private readonly settings: FxSettings,
  ) {}

  /** The provider's foreign accounts, or `currency_not_supported`. */
  provider(): ProviderForeignAccounts {
    return this.port.get();
  }

  /** A code Nuvion converts to naira and a person may pay from: a fiat currency of ours that is switched on. */
  private assertPayable(code: string): void {
    const def = fxCurrency(code);
    if (
      !def ||
      def.kind !== 'fiat' ||
      !this.settings.currencyOn(def.code) ||
      !this.settings.productOn('swap')
    ) {
      throw new MoneyError('currency_not_supported', SOURCE_CURRENCY_MESSAGE);
    }
  }

  private async accountOf(
    wawuUserId: string,
    code: string,
  ): Promise<FxAccount> {
    const account = await this.prisma.fxAccount.findFirst({
      where: {
        wawuUserId,
        provider: this.port.name,
        currency: code,
        chain: '',
        status: 'open',
        providerAccountId: { not: null },
      },
    });
    if (!account) {
      throw new MoneyError('fx_account_not_open', NO_SOURCE_ACCOUNT_MESSAGE);
    }
    return account;
  }

  // -------------------------------------------------------------------------
  // The quote
  // -------------------------------------------------------------------------

  /** A firm quote for exactly `priceKobo`, kept for this person and spent once by the payment. */
  async quote(
    wallet: OpenWallet,
    priceKobo: number,
    code: string,
  ): Promise<SourceQuote> {
    this.assertPayable(code);
    const fx = this.port.get();
    const account = await this.accountOf(wallet.wawuUserId, code);
    const person = this.port.person(wallet);
    let q: ProviderFxQuote;
    try {
      q = await fx.quote({
        person,
        from: { currency: code, accountId: account.providerAccountId },
        to: { currency: 'NGN', accountId: null },
        amountToMinor: BigInt(priceKobo),
      });
    } catch (e) {
      throw providerFailure(e, { currency: code });
    }
    if (q.amountToMinor !== BigInt(priceKobo)) {
      // The provider quoted another naira amount than the price: never paid with.
      this.logger.error(
        `payment fx quote: asked for ${priceKobo} kobo, quoted ${q.amountToMinor}`,
      );
      throw new MoneyError(
        'rate_unavailable',
        'We cannot give a rate for this right now. Nothing was taken.',
      );
    }
    const available = await this.availableOf(person, account);
    const row = await this.prisma.fxQuote.create({
      data: {
        wawuUserId: wallet.wawuUserId,
        provider: this.port.name,
        providerQuoteId: q.id,
        fromCurrency: code,
        toCurrency: 'NGN',
        fromAccountId: account.id,
        toAccountId: null,
        amountFromMinor: q.amountFromMinor,
        amountToMinor: q.amountToMinor,
        rate: q.rate,
        providerFeeMinor: this.settings.paymentProviderFeeMinor(code as never),
        wawuFeeMinor: this.settings.paymentFeeMinor(code as never),
        expiresAt: q.expiresAt,
      },
    });
    return { row, account, view: this.view(row, available) };
  }

  private async availableOf(
    person: { customerId: string; walletId: string },
    account: FxAccount,
  ): Promise<bigint | null> {
    try {
      return (
        await this.port.get().readAccount(person, account.providerAccountId!)
      ).availableMinor;
    } catch {
      return null;
    }
  }

  view(row: FxQuote, available: bigint | null): PaymentSourceView {
    const providerFee = row.providerFeeMinor ?? 0n;
    const total = row.amountFromMinor + providerFee + row.wawuFeeMinor;
    return {
      currency: row.fromCurrency,
      decimals: this.settings.decimalsOf(row.fromCurrency as never),
      amountMinor: num(row.amountFromMinor),
      providerFeeMinor: num(providerFee),
      wawuFeeMinor: num(row.wawuFeeMinor),
      totalMinor: num(total),
      rate: row.rate,
      availableMinor: available === null ? null : num(available),
      shortfallMinor:
        available === null
          ? null
          : num(total > available ? total - available : 0n),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** The quote a payment names, if it is still the buyer's, unspent, unexpired and for this price; else null. */
  async usable(
    wawuUserId: string,
    token: string,
    code: string,
    priceKobo: number,
  ): Promise<FxQuote | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const id = token.slice(TOKEN_PREFIX.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const row = await this.prisma.fxQuote.findUnique({ where: { id } });
    if (
      !row ||
      row.wawuUserId !== wawuUserId ||
      row.provider !== this.port.name ||
      row.usedAt ||
      row.fromCurrency !== code ||
      row.toCurrency !== 'NGN' ||
      row.amountToMinor !== BigInt(priceKobo) ||
      row.expiresAt.getTime() - Date.now() < MARGIN_MS
    ) {
      return null;
    }
    return row;
  }

  tokenOf(row: FxQuote): string {
    return `${TOKEN_PREFIX}${row.id}`;
  }

  /** The balance check the claim is preceded by: what leaves the account against what it holds. */
  async assertFunds(
    wallet: OpenWallet,
    row: FxQuote,
  ): Promise<{ account: FxAccount }> {
    const account = await this.accountOf(wallet.wawuUserId, row.fromCurrency);
    if (account.id !== row.fromAccountId) {
      throw new MoneyError('fx_account_not_open', NO_SOURCE_ACCOUNT_MESSAGE);
    }
    const available = await this.availableOf(this.port.person(wallet), account);
    if (available === null) {
      throw new MoneyError(
        'provider_unreachable',
        'We could not reach your account just now. Nothing was taken. Try again in a moment.',
        { retryAfterSeconds: 30 },
      );
    }
    const total =
      row.amountFromMinor + (row.providerFeeMinor ?? 0n) + row.wawuFeeMinor;
    if (available < total) {
      throw new MoneyError(
        'insufficient_funds',
        'There is not enough in the account for this.',
        { currency: row.fromCurrency, balanceMinor: num(available) },
      );
    }
    return { account };
  }

  // -------------------------------------------------------------------------
  // Paying
  // -------------------------------------------------------------------------

  /** The move: the buyer's account to WAWU's naira account, at the quote, under our reference. */
  send(
    p: Pick<WalletPayment, 'customerReference' | 'merchantAccountNumber'>,
    fx: WalletPaymentFx,
    person: { customerId: string; walletId: string },
  ): Promise<ProviderFxTransfer> {
    return this.port.get().swap({
      person,
      reference: p.customerReference,
      quoteId: fx.providerQuoteId,
      from: { currency: fx.sourceCurrency, accountId: fx.providerAccountId },
      to: { currency: 'NGN', accountId: null, ban: p.merchantAccountNumber },
      amountFromMinor: fx.sourceAmountMinor,
      narration: 'WAWU purchase',
    });
  }

  /** What the provider knows of the move, found by its id or our reference. */
  async lookup(
    p: Pick<WalletPayment, 'customerReference' | 'payerWawuUserId'>,
    fx: WalletPaymentFx,
  ): Promise<ProviderFxTransferLookup> {
    const account = await this.prisma.fxAccount.findUnique({
      where: { id: fx.fxAccountId },
    });
    if (!account) return { state: 'unknown' };
    const person = { customerId: account.providerCustomerId, walletId: '' };
    const fxp = this.port.get();
    try {
      return fx.providerTransferId
        ? await fxp.readTransfer(person, fx.providerTransferId)
        : await fxp.findTransferByReference(
            person,
            fx.providerAccountId,
            p.customerReference,
          );
    } catch (e) {
      if (e instanceof WalletProviderError) return { state: 'unknown' };
      throw e;
    }
  }

  /** WAWU's conversion fee is collected once the payment has completed: a same-currency move to the collector. */
  async collectFee(
    p: Pick<WalletPayment, 'customerReference'>,
    fx: WalletPaymentFx,
  ): Promise<void> {
    if (fx.wawuFeeMinor <= 0n || fx.feeLeg === 'done') return;
    const ban = this.settings.feeCollector(fx.sourceCurrency as never);
    const account = await this.prisma.fxAccount.findUnique({
      where: { id: fx.fxAccountId },
    });
    if (!ban || !account) {
      this.logger.error(
        `payment fx ${fx.paymentId}: no collector account is set for ${fx.sourceCurrency}; the fee stays owed`,
      );
      return;
    }
    let state: 'done' | 'owed' = 'owed';
    try {
      const t = await this.port.get().swap({
        person: { customerId: account.providerCustomerId, walletId: '' },
        reference: `${p.customerReference}-fee`,
        quoteId: null,
        from: { currency: fx.sourceCurrency, accountId: fx.providerAccountId },
        to: { currency: fx.sourceCurrency, accountId: null, ban },
        amountFromMinor: fx.wawuFeeMinor,
        narration: 'WAWU fee',
      });
      if (t.status === 'completed') state = 'done';
    } catch (e) {
      this.logger.warn(
        `payment fx ${fx.paymentId}: WAWU's conversion fee is not confirmed yet (${e instanceof WalletProviderError ? e.kind : 'error'}); asked again under the same reference`,
      );
    }
    await this.prisma.walletPaymentFx.updateMany({
      where: { id: fx.id, feeLeg: fx.feeLeg },
      data: { feeLeg: state },
    });
  }

  /** The fee legs still owed, asked again every minute under their own reference. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'payment-fx-fee-sweep' })
  async sweepFees(): Promise<void> {
    if (this.sweepingFees || !this.port.supported) return;
    this.sweepingFees = true;
    try {
      const owed = await this.prisma.walletPaymentFx.findMany({
        where: {
          feeLeg: 'owed',
          wawuFeeMinor: { gt: 0n },
          payment: { status: 'completed', provider: this.port.name },
        },
        include: { payment: true },
        take: 50,
        orderBy: { createdAt: 'asc' },
      });
      for (const { payment, ...fx } of owed) {
        await this.collectFee(payment, fx);
      }
    } catch (e) {
      this.logger.error(
        `payment fx fee sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweepingFees = false;
    }
  }

  // -------------------------------------------------------------------------
  // What a payment shows
  // -------------------------------------------------------------------------

  paidFrom(fx: WalletPaymentFx): PaymentPaidFromView {
    const providerFee = fx.providerFeeMinor ?? 0n;
    return {
      currency: fx.sourceCurrency,
      decimals: this.settings.decimalsOf(fx.sourceCurrency as never),
      amountMinor: num(fx.sourceAmountMinor),
      providerFeeMinor: num(providerFee),
      wawuFeeMinor: num(fx.wawuFeeMinor),
      totalMinor: num(fx.sourceAmountMinor + providerFee + fx.wawuFeeMinor),
      rate: fx.rate,
      refundedMinor:
        fx.refundedAt && fx.refundMinor !== null ? num(fx.refundMinor) : null,
    };
  }

  // -------------------------------------------------------------------------
  // The refund: the same amount, back to the account it came from
  // -------------------------------------------------------------------------

  /** The conversion a refund of a foreign payment is, or null for an ordinary (naira) payment. */
  forPayment(paymentId: string): Promise<WalletPaymentFx | null> {
    return this.prisma.walletPaymentFx.findUnique({ where: { paymentId } });
  }

  /**
   * What goes back, set once when the refund is decided: the amount taken for
   * the price, and, when the payer did not cause the refund, the charges too
   * (R-10, as for a naira refund). Returns the row.
   */
  async planRefund(
    paymentId: string,
    returnCharge: boolean,
  ): Promise<WalletPaymentFx | null> {
    const fx = await this.forPayment(paymentId);
    if (!fx) return null;
    if (fx.refundMinor === null) {
      const minor =
        fx.sourceAmountMinor +
        (returnCharge ? (fx.providerFeeMinor ?? 0n) + fx.wawuFeeMinor : 0n);
      await this.prisma.walletPaymentFx.updateMany({
        where: { id: fx.id, refundMinor: null },
        data: { refundMinor: minor },
      });
    }
    return this.forPayment(paymentId);
  }

  /** The destination account of a refund, or why there is none. */
  async refundAccount(fx: WalletPaymentFx): Promise<FxAccount | null> {
    return this.prisma.fxAccount.findUnique({ where: { id: fx.fxAccountId } });
  }

  /** A firm quote for the reverse conversion: WAWU's naira account to the buyer's account, for exactly the amount to return. */
  async refundQuote(
    fx: WalletPaymentFx,
    account: FxAccount,
  ): Promise<ProviderFxQuote> {
    const fxp = this.port.get();
    if (!fxp.quoteFromMerchant || fx.refundMinor === null) {
      throw new MoneyError('currency_not_supported', NO_REVERSE_MESSAGE);
    }
    return fxp.quoteFromMerchant({
      to: {
        currency: fx.sourceCurrency,
        accountId: account.providerAccountId,
        ban: account.ban,
      },
      amountToMinor: fx.refundMinor,
    });
  }

  refundSend(
    reference: string,
    fx: WalletPaymentFx,
    account: FxAccount,
    quote: { id: string; amountFromMinor: bigint },
  ): Promise<ProviderFxTransfer> {
    const fxp = this.port.get();
    if (!fxp.swapFromMerchant) {
      throw new MoneyError('currency_not_supported', NO_REVERSE_MESSAGE);
    }
    return fxp.swapFromMerchant({
      reference,
      quoteId: quote.id,
      to: {
        currency: fx.sourceCurrency,
        accountId: account.providerAccountId,
        ban: account.ban,
      },
      amountFromMinor: quote.amountFromMinor,
      narration: 'WAWU refund',
    });
  }

  async refundLookup(reference: string): Promise<ProviderFxTransferLookup> {
    const fxp = this.port.get();
    if (!fxp.findMerchantTransfer) return { state: 'unknown' };
    try {
      return await fxp.findMerchantTransfer(reference);
    } catch (e) {
      if (e instanceof WalletProviderError) return { state: 'unknown' };
      throw e;
    }
  }

  /** The refund is confirmed: what it cost WAWU in kobo and what went back are kept on the conversion. */
  async refundDone(
    fx: WalletPaymentFx,
    done: {
      costKobo: bigint;
      quoteId: string | null;
      rate: string | null;
      transferId: string | null;
    },
  ): Promise<void> {
    await this.prisma.walletPaymentFx.updateMany({
      where: { id: fx.id, refundedAt: null },
      data: {
        refundCostKobo: done.costKobo,
        refundQuoteId: done.quoteId,
        refundRate: done.rate,
        refundTransferId: done.transferId,
        refundedAt: new Date(),
      },
    });
  }
}
