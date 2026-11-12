import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import type { AbroadProvider } from '../../../wallet-provider/abroad-provider';
import { MoneyError } from '../../money-error';
import { foreignPort, settleLegWith } from '../../abroad/abroad-fee-legs';
import { RATE_PROVIDER, type FeeKind } from './fee-kinds';
import { FeeRecordService } from './fee-record.service';
import { FeeScheduleService } from './fee-schedule.service';
import { ProviderRateService } from './provider-rate.service';

/** What a dollar payout to a bank costs, worked out from the schedule (FEE-01 fix round 1, R-139 points 1, 6, 8, 9). */
export interface PayoutFee {
  /** WAWU's fee under the rule. The one fee the app sees. */
  feeMinor: bigint;
  vatMinor: bigint;
  /** What the provider is expected to charge (inside the fee, never shown to the app). */
  expectedMinor: bigint;
  expectedRowId: string | null;
  scheduleId: string;
  /** The book transfer to WAWU: fee plus VAT minus the provider's charge, never below 0. */
  legMinor: bigint;
}

/**
 * Whether a USD inflow carries WAWU's dollar-received fee (R-140 point 1). There is one fee for every bank transfer
 * into a dollar account: Nuvion's inflow says "bank-transfer" for an international wire and for a local transfer
 * alike, and nothing tells them apart, so nothing tries.
 */
export type InflowClass = 'bank' | null;

/** The `payment_type` of a bank transfer into an account, as Nuvion's inflow record says it. */
export const DOLLAR_BANK_TRANSFER_TYPE = 'bank-transfer';

/** The one kind that prices every dollar received by bank transfer. */
export const DOLLAR_RECEIVED_KIND: FeeKind = 'usd_local_in';

/** What happened to one foreign inflow. */
export interface InflowFeeResult {
  outcome: 'none' | 'recorded' | 'collected' | 'wait' | 'failed';
  note: string;
}

export interface InflowFeeInput {
  account: {
    wawuUserId: string;
    currency: string;
    providerAccountId: string;
    providerCustomerId: string;
  };
  walletId: string;
  abroad: AbroadProvider | undefined;
  transferId: string;
  paymentType: string | null;
  amountMinor: bigint;
  /** Nuvion's own `applicable_fee` on the transfer, as its record states it. */
  providerFeeMinor: bigint;
  status: 'completed' | 'pending' | 'failed' | 'reversed';
  occurredAt: Date;
  /** 'out' (a refunded or reversed payout of ours) is never priced; left out means a real inflow. */
  direction?: 'in' | 'out';
}

/** The names of the payment types (lower case) a config list holds. */
export function namesOf(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ''),
  );
}

/**
 * The dollar payout and the money-in side of the fee engine (FEE-01 fix
 * round 1). Prices a dollar payout to a bank from the schedule (money going
 * out: fee and VAT on top), keeps the fee record of each kind, and collects
 * WAWU's fee on dollars received by bank transfer into a dollar account (money
 * coming in: fee and VAT come off what arrives). The provider's charge is
 * worked out here and kept in the record; it is never returned to an app
 * route.
 *
 * R-140 (12 Nov 2026): every dollar bank transfer into a person's dollar
 * account is priced by ONE kind, `usd_local_in` (1.5%, minimum USD 7, no
 * maximum at the start; the dashboard changes it), always charged. Nuvion's
 * inflow `payment_type` is "bank-transfer" for a wire and a local transfer
 * alike, so there is no wire versus local split and nobody asks Nuvion which is
 * which. `FX_LOCAL_USD_PAYMENT_TYPES` may still add names that count as a bank
 * transfer; `FX_WIRE_PAYMENT_TYPES` is no longer read. A card inflow
 * (`card-acq`) and an inflow from another Nuvion account are on no list and are
 * charged nothing. `intl_wire_in` prices nothing now; its rows stay.
 */
@Injectable()
export class DollarFeeService {
  private readonly logger = new Logger(DollarFeeService.name);
  private readonly bankTypes: ReadonlySet<string>;
  private readonly collectorBan: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: FeeScheduleService,
    private readonly rates: ProviderRateService,
    private readonly records: FeeRecordService,
    private readonly plan: PlanSettingsService,
    @Optional() config?: ConfigService,
  ) {
    this.bankTypes = new Set([
      DOLLAR_BANK_TRANSFER_TYPE,
      ...namesOf(config?.get<string>('FX_LOCAL_USD_PAYMENT_TYPES')),
    ]);
    const ban = config?.get<string>('FX_FEE_COLLECTOR_USD_BAN')?.trim();
    this.collectorBan = ban && /^[A-Za-z0-9_-]{1,64}$/.test(ban) ? ban : null;
  }

  /** Whether VAT is on. */
  vatOn(): boolean {
    return this.schedule.vat().on;
  }

  // -- dollar payout to a bank (usd_bank_payout) ---------------------------------

  /**
   * The fee on a dollar payout of `amountMinor`. The provider's expected
   * charge is the rate row's when one is in force, else `estimateMinor` (the
   * configured estimate), else 0.
   */
  payoutFee(
    amountMinor: bigint,
    estimateMinor: number | null,
    at: Date = new Date(),
  ): PayoutFee {
    const fee = this.schedule.feeFor('usd_bank_payout', amountMinor, at);
    const exp = this.rates.expected(
      'usd_bank_payout',
      'USD',
      amountMinor,
      RATE_PROVIDER,
      at,
    );
    const expectedMinor =
      exp.rowId !== null ? exp.minor : BigInt(estimateMinor ?? 0);
    const owed = fee.feeMinor + fee.vatMinor;
    return {
      feeMinor: fee.feeMinor,
      vatMinor: fee.vatMinor,
      expectedMinor,
      expectedRowId: exp.rowId,
      scheduleId: fee.row.id,
      legMinor: owed > expectedMinor ? owed - expectedMinor : 0n,
    };
  }

  /**
   * Safety (R-139 point 8) for a dollar payout: below the smallest withdrawal
   * (the USD line of `money.min_withdrawal_minor`), or a fee bigger than the
   * amount, is refused before anything is sent.
   */
  assertPayoutSafe(amountMinor: bigint, at: Date = new Date()): void {
    const min = this.schedule.minWithdrawalMinor('USD');
    if (min !== null && amountMinor < min) {
      throw new MoneyError(
        'below_minimum_withdrawal',
        'This is less than the smallest amount you can withdraw. Try a larger amount.',
        { minimumMinor: Number(min), currency: 'USD' },
      );
    }
    const fee = this.schedule.feeFor('usd_bank_payout', amountMinor, at);
    if (fee.feeMinor + fee.vatMinor > amountMinor) {
      throw new MoneyError(
        'fee_exceeds_amount',
        'The fee is more than the amount. Try a larger amount.',
      );
    }
  }

  /** The record of a payout, written when the send is claimed. Idempotent on its reference; never throws. */
  async recordPayout(input: {
    reference: string;
    amountMinor: bigint;
    estimateMinor: number | null;
    at: Date;
  }): Promise<void> {
    try {
      const p = this.payoutFee(
        input.amountMinor,
        input.estimateMinor,
        input.at,
      );
      await this.prisma.moneyFeeRecord.upsert({
        where: {
          provider_reference_kind: {
            provider: RATE_PROVIDER,
            reference: input.reference,
            kind: 'usd_bank_payout',
          },
        },
        create: {
          provider: RATE_PROVIDER,
          reference: input.reference,
          kind: 'usd_bank_payout',
          currency: 'USD',
          amountMinor: input.amountMinor,
          wawuFeeMinor: p.feeMinor,
          vatMinor: p.vatMinor,
          providerExpectedMinor: p.expectedMinor,
          keptMinor: p.feeMinor - p.expectedMinor,
          feeScheduleId: p.scheduleId,
          providerRateId: p.expectedRowId,
        },
        update: {},
      });
    } catch (e) {
      this.logger.warn(
        `A payout fee record was not written (${e instanceof Error ? e.name : 'error'}).`,
      );
    }
  }

  /** Fills in the provider's own charge once its record states it. */
  settlePayout(reference: string, actualMinor: bigint): Promise<void> {
    return this.records.settle(
      RATE_PROVIDER,
      reference,
      'usd_bank_payout',
      actualMinor,
    );
  }

  /** The record of each payout reference: the one fee and the VAT the person was charged. */
  async payoutFeesFor(
    references: readonly string[],
  ): Promise<Map<string, { feeMinor: bigint; vatMinor: bigint }>> {
    const out = new Map<string, { feeMinor: bigint; vatMinor: bigint }>();
    if (references.length === 0) return out;
    const rows = await this.prisma.moneyFeeRecord.findMany({
      where: {
        provider: RATE_PROVIDER,
        kind: 'usd_bank_payout',
        reference: { in: [...references] },
      },
      select: { reference: true, wawuFeeMinor: true, vatMinor: true },
    });
    for (const r of rows) {
      out.set(r.reference, { feeMinor: r.wawuFeeMinor, vatMinor: r.vatMinor });
    }
    return out;
  }

  // -- naira added by bank transfer (ngn_add_money) ------------------------------

  /** The provider's receiving charge on an amount, passed on and nothing added: 0 with no rate row. */
  addMoneyCharge(amountMinor: bigint, at: Date = new Date()): bigint {
    return this.rates.expected(
      'ngn_add_money',
      'NGN',
      amountMinor,
      RATE_PROVIDER,
      at,
    ).minor;
  }

  /** The record of naira that arrived by bank transfer: WAWU's fee 0, the provider's charge as stated. Never throws. */
  async recordAddMoney(input: {
    reference: string;
    amountMinor: bigint;
    actualMinor: bigint;
    at?: Date;
  }): Promise<void> {
    try {
      const at = input.at ?? new Date();
      const exp = this.rates.expected(
        'ngn_add_money',
        'NGN',
        input.amountMinor,
        RATE_PROVIDER,
        at,
      );
      const row = this.schedule.inForce('ngn_add_money', 'NGN', at);
      await this.prisma.moneyFeeRecord.upsert({
        where: {
          provider_reference_kind: {
            provider: RATE_PROVIDER,
            reference: input.reference,
            kind: 'ngn_add_money',
          },
        },
        create: {
          provider: RATE_PROVIDER,
          reference: input.reference,
          kind: 'ngn_add_money',
          currency: 'NGN',
          amountMinor: input.amountMinor,
          wawuFeeMinor: 0n,
          vatMinor: 0n,
          providerExpectedMinor: exp.minor,
          providerActualMinor: input.actualMinor,
          // The charge is passed on to the person: WAWU keeps nothing and pays nothing.
          keptMinor: 0n,
          feeScheduleId: row?.id ?? null,
          providerRateId: exp.rowId,
        },
        update: {},
      });
      if (input.actualMinor !== exp.minor) {
        await this.rates.mismatch('ngn_add_money', input.reference);
      }
    } catch (e) {
      this.logger.warn(
        `An add-money fee record was not written (${e instanceof Error ? e.name : 'error'}).`,
      );
    }
  }

  // -- dollars received (usd_local_in, the one fee) ------------------------------

  /** 'bank' when the payment type is a bank transfer into the account; null for anything else (a card, another Nuvion account). */
  classify(paymentType: string | null): InflowClass {
    const t = paymentType?.trim().toLowerCase() ?? '';
    return t !== '' && this.bankTypes.has(t) ? 'bank' : null;
  }

  /**
   * One completed dollar inflow: the fee record, and WAWU's fee plus VAT
   * collected once by a book transfer from the person's dollar account to
   * WAWU's dollar collector (`<transfer id>-fee`). A replayed delivery finds
   * the record and the provider's leg and moves nothing again. Money arriving
   * is never refused: a fee larger than the amount is cut to the amount.
   */
  async onForeignInflow(i: InflowFeeInput): Promise<InflowFeeResult> {
    if (
      i.status !== 'completed' ||
      i.account.currency !== 'USD' ||
      i.direction === 'out'
    ) {
      return { outcome: 'none', note: 'not a completed dollar inflow' };
    }
    if (this.classify(i.paymentType) === null) {
      return { outcome: 'none', note: 'no fee: not a bank transfer' };
    }
    const kind = DOLLAR_RECEIVED_KIND;
    let rec = await this.findRecord(kind, i.transferId);
    if (!rec) {
      const at = i.occurredAt;
      const fee = this.schedule.feeFor(kind, i.amountMinor, at);
      let feeMinor = fee.feeMinor;
      let vatMinor = fee.vatMinor;
      if (feeMinor + vatMinor > i.amountMinor) {
        feeMinor = feeMinor > i.amountMinor ? i.amountMinor : feeMinor;
        vatMinor = i.amountMinor - feeMinor;
      }
      await this.writeInflowRecord(kind, i, feeMinor, vatMinor, fee.row.id);
      rec = await this.findRecord(kind, i.transferId);
    }
    if (!rec)
      return { outcome: 'wait', note: 'the fee record is not readable' };
    // R-139 (lead ruling F2): the person loses exactly F + VAT in all. Nuvion has already taken its own
    // charge off what arrived, so WAWU's leg collects the rest, and never less than 0.
    const providerTook = rec.providerActualMinor ?? i.providerFeeMinor;
    const total = rec.wawuFeeMinor + rec.vatMinor;
    const owed = total > providerTook ? total - providerTook : 0n;
    if (owed === 0n) return { outcome: 'recorded', note: 'no fee to collect' };
    if (!i.abroad?.feeLeg || !i.abroad.findFeeLeg || !this.collectorBan) {
      return {
        outcome: 'failed',
        note: "WAWU's fee on the dollars received could not be taken: no collecting account or no way to move it (review)",
      };
    }
    const port = foreignPort(
      i.abroad,
      {
        holder: {
          customerId: i.account.providerCustomerId,
          walletId: i.walletId,
        },
        currency: 'USD',
        accountRef: i.account.providerAccountId,
        collectorBan: this.collectorBan,
        direction: 'take',
      },
      owed,
      'WAWU fee',
    );
    const leg = await settleLegWith(port, `${i.transferId}-fee`, (m) =>
      this.logger.warn(`dollar inflow ${i.transferId}: WAWU's fee ${m}`),
    );
    if (leg.result === 'done') {
      return {
        outcome: 'collected',
        note: "WAWU's fee on the dollars received is taken",
      };
    }
    if (leg.result === 'wait') {
      return {
        outcome: 'wait',
        note: "WAWU's fee on the dollars received is not taken yet",
      };
    }
    return {
      outcome: 'failed',
      note: "the provider failed WAWU's fee on the dollars received under three references (review)",
    };
  }

  private findRecord(kind: FeeKind, reference: string) {
    return this.prisma.moneyFeeRecord.findUnique({
      where: {
        provider_reference_kind: {
          provider: RATE_PROVIDER,
          reference,
          kind,
        },
      },
    });
  }

  private async writeInflowRecord(
    kind: FeeKind,
    i: InflowFeeInput,
    feeMinor: bigint,
    vatMinor: bigint,
    scheduleId: string | null,
  ): Promise<void> {
    const exp = this.rates.expected(
      kind,
      'USD',
      i.amountMinor,
      RATE_PROVIDER,
      i.occurredAt,
    );
    await this.prisma.moneyFeeRecord.upsert({
      where: {
        provider_reference_kind: {
          provider: RATE_PROVIDER,
          reference: i.transferId,
          kind,
        },
      },
      create: {
        provider: RATE_PROVIDER,
        reference: i.transferId,
        kind,
        currency: 'USD',
        amountMinor: i.amountMinor,
        wawuFeeMinor: feeMinor,
        vatMinor,
        providerExpectedMinor: exp.minor,
        providerActualMinor: i.providerFeeMinor,
        keptMinor: feeMinor - i.providerFeeMinor,
        feeScheduleId: scheduleId,
        providerRateId: exp.rowId,
      },
      update: {},
    });
  }

  /** The fee records of dollar inflows, by transfer id, for the person's own view of them. */
  async inflowFeesFor(references: readonly string[]): Promise<
    Map<
      string,
      {
        feeMinor: bigint;
        vatMinor: bigint;
        amountMinor: bigint;
        /** Everything taken off what arrived: the provider's charge, WAWU's fee and VAT, as one figure. */
        takenMinor: bigint;
      }
    >
  > {
    const out = new Map<
      string,
      {
        feeMinor: bigint;
        vatMinor: bigint;
        amountMinor: bigint;
        takenMinor: bigint;
      }
    >();
    if (references.length === 0) return out;
    const rows = await this.prisma.moneyFeeRecord.findMany({
      where: {
        provider: RATE_PROVIDER,
        kind: { in: ['intl_wire_in', DOLLAR_RECEIVED_KIND] },
        reference: { in: [...references] },
      },
      select: {
        reference: true,
        wawuFeeMinor: true,
        vatMinor: true,
        amountMinor: true,
        providerExpectedMinor: true,
        providerActualMinor: true,
      },
    });
    for (const r of rows) {
      const p = r.providerActualMinor ?? r.providerExpectedMinor;
      const total = r.wawuFeeMinor + r.vatMinor;
      out.set(r.reference, {
        feeMinor: r.wawuFeeMinor,
        vatMinor: r.vatMinor,
        amountMinor: r.amountMinor,
        takenMinor: total > p ? total : p,
      });
    }
    return out;
  }
}
