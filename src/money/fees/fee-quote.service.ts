import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { BillCategory, FeeQuoteKind } from '../dto/money-enums';
import { MoneyError } from '../money-error';
import type {
  FeeBreakdown,
  FeeQuotePartView,
  FeeQuoteView,
} from '../money-view.type';
import { FeeSettings } from './fee-config';
import { feesNotSet } from './fees-not-set';
import {
  providerFeeSchedule,
  type ProviderFeeSchedule,
} from './provider-fee-schedule';

/** What is being quoted. `billCategory` only on a bill. */
export interface FeeQuoteInput {
  kind: FeeQuoteKind;
  amountKobo: number;
  billCategory?: BillCategory | null;
}

/** The fee part of a quote, before it is signed. */
export interface FeeLines {
  fee: FeeBreakdown;
  parts: FeeQuotePartView[];
  totalKobo: number;
}

/** What a quote token carries. Short keys: it travels in every send. */
interface QuoteClaims {
  v: 1;
  /** wawuUserId the quote was given to. */
  u: string;
  k: FeeQuoteKind;
  c: BillCategory | null;
  a: number;
  t: number;
  /** expiresAt, in epoch milliseconds. */
  x: number;
  /**
   * What the quote is for, when the caller binds it to one thing (MONEY-17:
   * `payment:<kind>:<targetId>`), so a quote for one item never pays
   * another. Absent on a plain fee quote.
   */
  s?: string;
}

const TOKEN_CONTEXT = 'wawu-fee-quote.v1.';

export const QUOTE_CHANGED_MESSAGE =
  'The fee has changed since you saw it. Check the new total and try again.';
export const AMOUNT_TOO_LARGE_MESSAGE =
  'This is more than can be paid in one go. Try a smaller amount.';
export const BILLS_UNAVAILABLE_MESSAGE = 'Bills cannot be paid right now.';

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Fee quotes (task WALLET-15): every fee shown before paying comes from
 * here, never from the app (R-10, R-31). Nothing here calls the provider or
 * reads a balance: a quote is the fee schedule applied to the amount.
 *
 * NUV-07: the provider's part of every quote comes from the running
 * provider's schedule (provider-fee-schedule.ts): Fintava's below, exactly
 * as WALLET-15 built it, or Nuvion's from the NUVION_FEE_* settings. WAWU's
 * fee on top (R-10) is the same under either. While any of the running
 * provider's fee settings is unset, every quote (and so every payment that
 * charges one, through `check()`) is `503 fees_not_set` before anything else
 * (R-42). A quote never asks the provider (no `POST /fee-simulations`):
 * NUV-08 compares the setting with Nuvion's own figure and reports a
 * difference.
 *
 *   wawu_transfer  amount + Fintava's balance-transfer charge (by band) + WAWU's ₦10
 *   bank_transfer  amount + Fintava's ₦40 + WAWU's ₦25
 *   purchase       price + Fintava's balance-transfer charge (by band); no WAWU fee,
 *                  WAWU's share is the 85/15 split (R-10)
 *   bill           the bill's amount + Fintava's bill charge (by category) + WAWU's
 *                  bill fee, all moved by the payer into WAWU's merchant wallet in one
 *                  balance transfer, + Fintava's balance-transfer charge on that
 *                  transfer (R-31, R-19)
 *
 * A quote is short-lived and checkable: `quote()` signs it (HMAC-SHA256
 * under FEE_QUOTE_KEY) with the person, the kind, the amount, the total and
 * when it stops being honoured; `check()` is what the send or payment that
 * follows calls (WALLET-07, WALLET-09, MONEY-17), and answers the quote as
 * it stands now or refuses with `409 quote_changed` and that new quote.
 * Nothing is stored and nothing is reserved.
 */
@Injectable()
export class FeeQuoteService {
  /** The running provider's part of every quote (NUV-07). */
  readonly providerFees: ProviderFeeSchedule;

  /**
   * `provider` and `config` are the running provider (WALLET_PROVIDER, whose
   * `name` picks the schedule) and the settings Nuvion's charges are read
   * from. Built without them (the WALLET-15 unit specs), the schedule is
   * Fintava's. A Nuvion charge that is set but unusable stops the app at
   * boot, naming the setting.
   */
  constructor(
    private readonly settings: FeeSettings,
    @Optional()
    @Inject(WALLET_PROVIDER)
    provider?: Pick<WalletProvider, 'name'>,
    @Optional() config?: ConfigService,
  ) {
    this.providerFees = providerFeeSchedule(
      provider?.name ?? 'fintava',
      settings,
      (key) => config?.get<string>(key),
    );
  }

  /** False while any of the running provider's fee settings is unset. */
  get feesSet(): boolean {
    return this.providerFees.unset.length === 0;
  }

  /** `503 fees_not_set` while any of the running provider's fee settings is unset. */
  assertFeesSet(): void {
    if (!this.feesSet) throw feesNotSet();
  }

  /**
   * The fee lines for this amount, unsigned. Refuses with `503
   * fees_not_set` while the running provider's fees are not set, with `409
   * target_not_payable` a bill where the provider has no bills (Nuvion), and
   * with `400 amount_out_of_range` (and `maximumKobo`) a purchase or bill
   * whose total is above MERCHANT_MAX_PER_TXN_KOBO, the cap on money through
   * WAWU's merchant wallet, and any total a JSON number cannot carry exactly.
   */
  lines(input: FeeQuoteInput): FeeLines {
    this.assertFeesSet();
    if (input.kind === 'bill' && !this.providerFees.bills) {
      throw new MoneyError('target_not_payable', BILLS_UNAVAILABLE_MESSAGE);
    }
    const lines = this.compute(input);
    const cap = this.capFor(input.kind);
    if (lines.totalKobo > cap) {
      throw new MoneyError('amount_out_of_range', AMOUNT_TOO_LARGE_MESSAGE, {
        maximumKobo: this.largestAmountUnder(input, cap),
      });
    }
    return lines;
  }

  /** A signed quote for this person, honoured until `expiresAt`. */
  quote(
    wawuUserId: string,
    input: FeeQuoteInput,
    now: Date = new Date(),
    subject?: string,
  ): FeeQuoteView {
    const { fee, parts, totalKobo } = this.lines(input);
    const billCategory =
      input.kind === 'bill' ? (input.billCategory ?? null) : null;
    const expires = now.getTime() + this.settings.quoteSeconds * 1000;
    const quoteToken = this.sign({
      v: 1,
      u: wawuUserId,
      k: input.kind,
      c: billCategory,
      a: input.amountKobo,
      t: totalKobo,
      x: expires,
      ...(subject === undefined ? {} : { s: subject }),
    });
    return {
      kind: input.kind,
      billCategory,
      amountKobo: input.amountKobo,
      fee,
      parts,
      totalKobo,
      // No launch task holds the daily limit yet (BACKEND_GAPS G-7 in the
      // mobile repo): nothing is known to stop this, and nothing is shown.
      withinDailyLimit: true,
      remainingTodayKobo: null,
      quoteToken,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  /**
   * For the request that pays a quote: answers the quote as it stands now
   * when `quoteToken` is one this server signed, for this person, kind,
   * category and amount, not past its `expiresAt`, and both its total and
   * `expectedTotalKobo` equal today's total. Otherwise throws `409
   * quote_changed` with the new quote in `reason.feeQuote`, so the person
   * sees what they would now pay before anything moves.
   */
  check(
    wawuUserId: string,
    input: FeeQuoteInput,
    expectedTotalKobo: number,
    quoteToken: string,
    now: Date = new Date(),
    subject?: string,
  ): FeeQuoteView {
    const fresh = this.quote(wawuUserId, input, now, subject);
    const claims = this.verify(quoteToken);
    const honoured =
      claims !== null &&
      claims.u === wawuUserId &&
      claims.k === fresh.kind &&
      claims.c === fresh.billCategory &&
      claims.a === fresh.amountKobo &&
      claims.t === fresh.totalKobo &&
      expectedTotalKobo === fresh.totalKobo &&
      claims.s === subject &&
      now.getTime() < claims.x;
    if (!honoured) {
      throw new MoneyError('quote_changed', QUOTE_CHANGED_MESSAGE, {
        feeQuote: fresh,
      });
    }
    return fresh;
  }

  private compute(input: FeeQuoteInput): FeeLines {
    const s = this.settings;
    const p = this.providerFees;
    const amount = input.amountKobo;
    const parts: FeeQuotePartView[] = [];
    const add = (
      code: FeeQuotePartView['code'],
      source: FeeQuotePartView['source'],
      amountKobo: number,
    ) => parts.push({ code, source, amountKobo });

    switch (input.kind) {
      case 'wawu_transfer':
        add('balance_transfer', 'provider', p.walletToWalletKobo(amount));
        add('wawu_fee', 'wawu', s.wawuTransferWawuFeeKobo);
        break;
      case 'bank_transfer':
        add('bank_transfer', 'provider', p.bankTransferKobo(amount));
        add('wawu_fee', 'wawu', s.bankTransferWawuFeeKobo);
        break;
      case 'purchase':
        add('balance_transfer', 'provider', p.walletToWalletKobo(amount));
        break;
      case 'bill': {
        const category = input.billCategory;
        if (!category) {
          throw new Error('A bill quote needs its billCategory.');
        }
        const billCharge = p.billChargeKobo(category);
        const intoWawu = amount + billCharge + s.billWawuFeeKobo;
        add('bill_charge', 'provider', billCharge);
        add('wawu_fee', 'wawu', s.billWawuFeeKobo);
        add('balance_transfer', 'provider', p.walletToWalletKobo(intoWawu));
        break;
      }
    }

    const sum = (source: FeeQuotePartView['source']) =>
      parts
        .filter((p) => p.source === source)
        .reduce((n, p) => n + p.amountKobo, 0);
    const providerFeeKobo = sum('provider');
    const wawuFeeKobo = sum('wawu');
    const totalFeeKobo = providerFeeKobo + wawuFeeKobo;
    return {
      fee: { providerFeeKobo, wawuFeeKobo, totalFeeKobo },
      parts,
      totalKobo: amount + totalFeeKobo,
    };
  }

  /** The largest total this kind may reach. */
  private capFor(kind: FeeQuoteKind): number {
    const merchantCap = this.providerFees.merchantMaxPerTxnKobo;
    return (kind === 'purchase' || kind === 'bill') && merchantCap !== null
      ? Math.min(merchantCap, Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
  }

  /**
   * The largest amount whose total stays within `cap`: start below the cap
   * by the fee there and step down by any overshoot (fees are bounded, so a
   * few steps settle it).
   */
  private largestAmountUnder(input: FeeQuoteInput, cap: number): number {
    const totalAt = (amountKobo: number) =>
      this.compute({ ...input, amountKobo }).totalKobo;
    let amount = cap - (totalAt(cap) - cap);
    for (let i = 0; i < 10 && amount > 0; i++) {
      const over = totalAt(amount) - cap;
      if (over <= 0) break;
      amount -= over;
    }
    return Math.max(0, amount);
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.settings.quoteKey())
      .update(TOKEN_CONTEXT + payload)
      .digest();
  }

  private sign(claims: QuoteClaims): string {
    const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
    return `${payload}.${b64url(this.mac(payload))}`;
  }

  /** The claims of a token this server signed, or null for anything else. */
  private verify(token: string): QuoteClaims | null {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = this.mac(payload);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    try {
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as QuoteClaims;
      return claims && claims.v === 1 ? claims : null;
    } catch {
      return null;
    }
  }
}
