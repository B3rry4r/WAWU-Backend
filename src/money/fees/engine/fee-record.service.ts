import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FeeScheduleService } from './fee-schedule.service';
import { ProviderRateService } from './provider-rate.service';
import { FEE_KIND_CURRENCY, type FeeKind } from './fee-kinds';

/** What is known when a transaction is claimed. */
export interface FeeRecordInput {
  provider: string;
  reference: string;
  kind: FeeKind;
  currency?: string;
  amountMinor: bigint;
  /** The fee quoted to the person, as the schedule worked it out. */
  at?: Date;
}

/**
 * The record of what each Nuvion transaction cost and earned (FEE-01, R-139
 * point 6): the amount, WAWU's fee, VAT, what the provider was expected to
 * charge, what it did charge (filled when known), what WAWU kept (the fee
 * minus the provider's charge; VAT is the tax's, not WAWU's), and the
 * schedule and rate rows used. One row per (provider, reference, kind),
 * written when the transaction is claimed and completed when the provider's
 * own figure is known. Never throws: a failed write is logged and the money
 * move goes on (the nightly fee check finds a missing record).
 */
@Injectable()
export class FeeRecordService {
  private readonly logger = new Logger(FeeRecordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: FeeScheduleService,
    private readonly rates: ProviderRateService,
  ) {}

  /** Writes the record for a claimed transaction (idempotent on its reference). */
  async record(input: FeeRecordInput): Promise<void> {
    try {
      const at = input.at ?? new Date();
      const currency = input.currency ?? FEE_KIND_CURRENCY[input.kind];
      const fee = this.schedule.feeFor(input.kind, input.amountMinor, at, currency);
      const expected = this.rates.expected(
        input.kind,
        currency,
        input.amountMinor,
        input.provider,
        at,
      );
      const kept = fee.feeMinor - expected.minor;
      await this.prisma.moneyFeeRecord.upsert({
        where: {
          provider_reference_kind: {
            provider: input.provider,
            reference: input.reference,
            kind: input.kind,
          },
        },
        create: {
          provider: input.provider,
          reference: input.reference,
          kind: input.kind,
          currency,
          amountMinor: input.amountMinor,
          wawuFeeMinor: fee.feeMinor,
          vatMinor: fee.vatMinor,
          providerExpectedMinor: expected.minor,
          keptMinor: kept,
          feeScheduleId: fee.row.id,
          providerRateId: expected.rowId,
        },
        update: {},
      });
    } catch (e) {
      this.logger.warn(
        `A fee record was not written (${e instanceof Error ? e.name : 'error'}).`,
      );
    }
  }

  /**
   * Fills in the provider's own charge once its record is read. When it is
   * not the expected one, the owner is told (once a day per kind).
   */
  async settle(
    provider: string,
    reference: string,
    kind: FeeKind,
    actualMinor: bigint,
  ): Promise<void> {
    try {
      const row = await this.prisma.moneyFeeRecord.findUnique({
        where: {
          provider_reference_kind: { provider, reference, kind },
        },
      });
      if (!row) return;
      await this.prisma.moneyFeeRecord.update({
        where: { id: row.id },
        data: {
          providerActualMinor: actualMinor,
          keptMinor: row.wawuFeeMinor - actualMinor,
        },
      });
      if (actualMinor !== row.providerExpectedMinor) {
        await this.rates.mismatch(kind, reference);
      }
    } catch (e) {
      this.logger.warn(
        `A fee record was not settled (${e instanceof Error ? e.name : 'error'}).`,
      );
    }
  }
}
