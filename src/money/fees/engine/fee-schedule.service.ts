import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { feesNotSet } from '../fees-not-set';
import {
  FEE_CURRENCIES,
  FEE_KIND_CURRENCY,
  FEE_KINDS,
  PASS_THROUGH_KINDS,
  type FeeKind,
} from './fee-kinds';
import { feeOf, percentToPpm, ppmToPercent, shareOf } from './percent-fee';

/** How often each server reads the schedule again, in seconds. An admin's change also refreshes the server that took it at once. */
export const FEE_SCHEDULE_REFRESH_SECONDS = 15;

/** The longest a start time may lie in the past, so a "now" typed a moment ago is taken. */
const START_SLACK_MS = 5 * 60 * 1000;

/** One row of the history, as the admin routes show it. */
export interface FeeRow {
  id: string;
  kind: string;
  currency: string;
  percent: string;
  minMinor: number;
  maxMinor: number | null;
  passThrough: boolean;
  startsAt: string;
  changedBy: string;
  note: string | null;
  createdAt: string;
}

export interface FeeKindView {
  kind: string;
  currency: string;
  on: boolean;
  current: FeeRow | null;
  history: FeeRow[];
}

/** What `POST /admin/money/fees` takes. */
export interface AddFeeInput {
  kind: string;
  currency: string;
  percent?: string;
  minMinor?: number;
  maxMinor?: number | null;
  passThrough?: boolean;
  startsAt: string;
  note?: string;
}

interface Row {
  id: string;
  kind: string;
  currency: string;
  percentPpm: number;
  minMinor: bigint;
  maxMinor: bigint | null;
  passThrough: boolean;
  startsAt: Date;
  changedBy: string;
  note: string | null;
  createdAt: Date;
}

/** The fee a kind carries on one amount, and the row that decided it. */
export interface FeeResult {
  feeMinor: bigint;
  vatMinor: bigint;
  row: Row;
}

const num = (n: bigint): number => Number(n);

/**
 * WAWU's own fee schedule (FEE-01, R-139). Every fee a person pays on a
 * Nuvion money move is worked out here, from the row in force: the latest
 * row of its (kind, currency) whose start time has passed. Rows are never
 * edited or deleted, so the history is the table. Rows are read into memory
 * and read again every few seconds (and at once after a change on this
 * server), so a quote is a plain read and a fee change needs no release.
 *
 * No figure lives in code: the starting fees are the migration's first rows.
 */
@Injectable()
export class FeeScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeeScheduleService.name);
  private rows: Row[] = [];
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly plan: PlanSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, FEE_SCHEDULE_REFRESH_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads the whole history. A failed read keeps what was loaded. */
  async refresh(): Promise<void> {
    try {
      const rows = await this.prisma.feeSchedule.findMany({
        orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      this.rows = rows;
      this.loaded = true;
    } catch {
      this.logger.warn(
        'The fee schedule could not be read; using the last one.',
      );
    }
  }

  /** The row in force for a kind and currency at `at`, or null when none has started. */
  inForce(kind: string, currency: string, at: Date = new Date()): Row | null {
    let found: Row | null = null;
    for (const r of this.rows) {
      if (r.kind === kind && r.currency === currency && r.startsAt <= at) {
        found = r;
      }
    }
    return found;
  }

  /** True when this kind has a row in force now. */
  isSet(kind: FeeKind, at: Date = new Date()): boolean {
    return this.inForce(kind, FEE_KIND_CURRENCY[kind], at) !== null;
  }

  /** The kinds every Nuvion money move needs a row for before anything is quoted or sent. */
  static readonly CORE_KINDS: readonly FeeKind[] = [
    'ngn_bank_withdrawal',
    'wallet_to_wallet',
  ];

  /** True when every core kind has a row in force. */
  coreSet(at: Date = new Date()): boolean {
    return FeeScheduleService.CORE_KINDS.every((k) => this.isSet(k, at));
  }

  /** The smallest withdrawal for a currency, in its smallest unit, or null when none is set (R-139 point 8). */
  minWithdrawalMinor(currency: string): bigint | null {
    for (const line of this.plan.lines('money.min_withdrawal_minor')) {
      const [code, amount] = line.split(' ');
      if (code === currency) return BigInt(amount);
    }
    return null;
  }

  /** True once the first read has finished. */
  get ready(): boolean {
    return this.loaded;
  }

  /** `503 fees_not_set` when no row is in force for the kind. */
  assertSet(kind: FeeKind, at: Date = new Date()): void {
    if (!this.isSet(kind, at)) throw feesNotSet();
  }

  /** Whether VAT is on, and its rate in millionths. */
  vat(): { on: boolean; ppm: number } {
    const on = this.plan.value('tax.vat_on') === 1;
    const raw = this.plan.value('tax.vat_percent');
    const text = typeof raw === 'string' ? raw : '0';
    return { on, ppm: percentToPpm(text) ?? 0 };
  }

  /** VAT on a fee: 0 when VAT is off, else the rate's share of the fee, halves up. */
  vatOf(feeMinor: bigint): bigint {
    const v = this.vat();
    return v.on ? shareOf(v.ppm, feeMinor) : 0n;
  }

  /**
   * The fee on an amount for a kind, from the row in force. `503 fees_not_set`
   * when none is in force. A pass-through kind (adding money) is 0: the
   * provider's charge is passed on, nothing extra.
   */
  feeFor(
    kind: FeeKind,
    amountMinor: bigint,
    at: Date = new Date(),
    currency: string = FEE_KIND_CURRENCY[kind],
  ): FeeResult {
    const row = this.inForce(kind, currency, at);
    if (!row) throw feesNotSet();
    const feeMinor = row.passThrough
      ? 0n
      : feeOf(
          {
            ppm: row.percentPpm,
            minMinor: row.minMinor,
            maxMinor: row.maxMinor,
          },
          amountMinor,
        );
    return { feeMinor, vatMinor: this.vatOf(feeMinor), row };
  }

  /** The admin view of one row. */
  view(r: Row): FeeRow {
    return {
      id: r.id,
      kind: r.kind,
      currency: r.currency,
      percent: ppmToPercent(r.percentPpm),
      minMinor: num(r.minMinor),
      maxMinor: r.maxMinor === null ? null : num(r.maxMinor),
      passThrough: r.passThrough,
      startsAt: r.startsAt.toISOString(),
      changedBy: r.changedBy,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Every kind with the fee in force, whether its product is on, and its history (newest first). */
  async kinds(): Promise<FeeKindView[]> {
    await this.refresh();
    const now = new Date();
    return FEE_KINDS.map((kind) => {
      const currency = FEE_KIND_CURRENCY[kind];
      const history = this.rows
        .filter((r) => r.kind === kind && r.currency === currency)
        .reverse()
        .map((r) => this.view(r));
      const cur = this.inForce(kind, currency, now);
      return {
        kind,
        currency,
        on: this.productOn(kind),
        current: cur ? this.view(cur) : null,
        history,
      };
    });
  }

  /** Whether the product a kind prices is switched on. Swaps and local dollars have switches; the rest are on. */
  productOn(kind: FeeKind): boolean {
    if (kind === 'fx_swap') return this.plan.value('fx.product.swap.on') === 1;
    if (kind === 'usd_local_in') {
      return this.plan.value('fx.product.local_usd_in.on') === 1;
    }
    return true;
  }

  /** Adds one row. Validates the shape, never touches an old row. */
  async add(changedBy: string, input: AddFeeInput): Promise<FeeRow> {
    const kind = input.kind as FeeKind;
    if (!FEE_KINDS.includes(kind)) {
      throw new BadRequestException(['kind is not a fee kind.']);
    }
    if (!(FEE_CURRENCIES as readonly string[]).includes(input.currency)) {
      throw new BadRequestException(['currency is not one fees are set in.']);
    }
    if (input.currency !== FEE_KIND_CURRENCY[kind]) {
      throw new BadRequestException([
        `currency must be ${FEE_KIND_CURRENCY[kind]} for ${kind}.`,
      ]);
    }
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException(['startsAt must be a date and time.']);
    }
    if (startsAt.getTime() < Date.now() - START_SLACK_MS) {
      throw new BadRequestException(['startsAt cannot be in the past.']);
    }
    const passThrough = PASS_THROUGH_KINDS.includes(kind);
    let ppm = 0;
    let min = 0;
    let max: number | null = null;
    if (passThrough) {
      if (input.passThrough !== true) {
        throw new BadRequestException([
          `${kind} passes the provider's charge on: send passThrough true.`,
        ]);
      }
    } else {
      if (input.passThrough === true) {
        throw new BadRequestException([`${kind} cannot be a pass-through.`]);
      }
      const p = percentToPpm(String(input.percent ?? ''));
      if (p === null) {
        throw new BadRequestException([
          'percent must be a decimal string such as "0.4", at most 100, up to four decimals.',
        ]);
      }
      ppm = p;
      min = input.minMinor ?? 0;
      max = input.maxMinor ?? null;
      const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
      if (!whole(min) || (max !== null && !whole(max))) {
        throw new BadRequestException([
          "minMinor and maxMinor must be whole numbers of the currency's smallest unit.",
        ]);
      }
      if (max !== null && max < min) {
        throw new BadRequestException(['maxMinor cannot be below minMinor.']);
      }
    }
    const row = await this.prisma.feeSchedule.create({
      data: {
        kind,
        currency: input.currency,
        percentPpm: ppm,
        minMinor: BigInt(min),
        maxMinor: max === null ? null : BigInt(max),
        passThrough,
        startsAt,
        changedBy,
        note: input.note?.slice(0, 500) ?? null,
      },
    });
    await this.refresh();
    return this.view(row);
  }
}
