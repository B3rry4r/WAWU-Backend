import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  MoneyCheckMailer,
  type MoneyCheckMail,
} from '../../check/money-check-mailer';
import { recipientsSetting } from '../../check/money-check-config';
import { START_SLACK_MS } from './fee-schedule.service';
import { feeOf, percentToPpm, ppmToPercent } from './percent-fee';
import { PROVIDER_RATE_KINDS, RATE_PROVIDER } from './fee-kinds';

const REFRESH_SECONDS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One provider rate, as the admin-only routes show it. */
export interface ProviderRateRow {
  id: string;
  provider: string;
  kind: string;
  currency: string;
  percent: string;
  minMinor: number;
  maxMinor: number | null;
  fixedMinor: number;
  startsAt: string;
  changedBy: string;
  note: string | null;
  createdAt: string;
}

export interface AddProviderRateInput {
  provider: string;
  kind: string;
  currency: string;
  percent: string;
  minMinor: number;
  maxMinor: number | null;
  fixedMinor: number;
  startsAt: string;
  note?: string | null;
}

interface Row {
  id: string;
  provider: string;
  kind: string;
  currency: string;
  percentPpm: number;
  minMinor: bigint;
  maxMinor: bigint | null;
  fixedMinor: bigint;
  startsAt: Date;
  changedBy: string;
  note: string | null;
  createdAt: Date;
}

/** What a provider is expected to charge on an amount, and the row it came from. */
export interface ExpectedCharge {
  minor: bigint;
  rowId: string | null;
}

/**
 * The provider's own rates (FEE-01, R-139 point 9): Nuvion's commercials,
 * kept apart from WAWU's fee schedule and shown only to superadmin and
 * finance. Nothing here is returned by an app route, written to a log line,
 * or put in an error. Used to work out the expected provider charge for the
 * fee record and the check, and to tell the owner when a rate changes
 * (Nuvion gives 30 days' notice) or when a real charge is not the expected
 * one, at most once a day per kind.
 */
@Injectable()
export class ProviderRateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProviderRateService.name);
  private rows: Row[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly recipients: readonly string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MoneyCheckMailer,
    config: ConfigService,
  ) {
    this.recipients = recipientsSetting(
      config.get<string>('MONEY_CHECK_RECIPIENT_WAWU_IDS'),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    try {
      this.rows = await this.prisma.providerRate.findMany({
        orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
    } catch {
      this.logger.warn(
        'The provider rates could not be read; using the last ones.',
      );
    }
  }

  private inForce(
    provider: string,
    kind: string,
    currency: string,
    at: Date,
  ): Row | null {
    let found: Row | null = null;
    for (const r of this.rows) {
      if (
        r.provider === provider &&
        r.kind === kind &&
        r.currency === currency &&
        r.startsAt <= at
      ) {
        found = r;
      }
    }
    return found;
  }

  /** What the provider is expected to charge on this amount; 0 with no row. */
  expected(
    kind: string,
    currency: string,
    amountMinor: bigint,
    provider: string = RATE_PROVIDER,
    at: Date = new Date(),
  ): ExpectedCharge {
    const r = this.inForce(provider, kind, currency, at);
    if (!r) return { minor: 0n, rowId: null };
    const pct = feeOf(
      { ppm: r.percentPpm, minMinor: r.minMinor, maxMinor: r.maxMinor },
      amountMinor,
    );
    return { minor: pct + r.fixedMinor, rowId: r.id };
  }

  view(r: Row): ProviderRateRow {
    return {
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      currency: r.currency,
      percent: ppmToPercent(r.percentPpm),
      minMinor: Number(r.minMinor),
      maxMinor: r.maxMinor === null ? null : Number(r.maxMinor),
      fixedMinor: Number(r.fixedMinor),
      startsAt: r.startsAt.toISOString(),
      changedBy: r.changedBy,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Every row, newest first. */
  async list(): Promise<ProviderRateRow[]> {
    await this.refresh();
    return [...this.rows].reverse().map((r) => this.view(r));
  }

  async add(
    changedBy: string,
    input: AddProviderRateInput,
  ): Promise<ProviderRateRow> {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(input.provider)) {
      throw new BadRequestException(['provider is not a provider name.']);
    }
    if (!(PROVIDER_RATE_KINDS as readonly string[]).includes(input.kind)) {
      throw new BadRequestException(['kind is not a rate kind.']);
    }
    if (!/^[A-Z]{3,5}$/.test(input.currency)) {
      throw new BadRequestException(['currency is not a currency code.']);
    }
    const ppm = percentToPpm(String(input.percent ?? ''));
    if (ppm === null) {
      throw new BadRequestException([
        'percent must be a decimal string such as "0.2", at most 100, up to four decimals.',
      ]);
    }
    const whole = (n: unknown): n is number =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    if (!whole(input.minMinor) || !whole(input.fixedMinor)) {
      throw new BadRequestException([
        "minMinor and fixedMinor must be whole numbers of the currency's smallest unit.",
      ]);
    }
    const max = input.maxMinor ?? null;
    if (max !== null && (!whole(max) || max < input.minMinor)) {
      throw new BadRequestException([
        'maxMinor must be a whole number and not below minMinor.',
      ]);
    }
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException(['startsAt must be a date and time.']);
    }
    if (startsAt.getTime() < Date.now() - START_SLACK_MS) {
      throw new BadRequestException(['startsAt cannot be in the past.']);
    }
    const row = await this.prisma.providerRate.create({
      data: {
        provider: input.provider,
        kind: input.kind,
        currency: input.currency,
        percentPpm: ppm,
        minMinor: BigInt(input.minMinor),
        maxMinor: max === null ? null : BigInt(max),
        fixedMinor: BigInt(input.fixedMinor),
        startsAt,
        changedBy,
        note: input.note?.slice(0, 500) ?? null,
      },
    });
    await this.refresh();
    await this.alert(
      input.kind,
      'rate_changed',
      `A provider rate for ${input.kind} was added. Check it against the notice the provider gave.`,
      row.id,
    );
    return this.view(row);
  }

  /**
   * Tells the owner a real provider charge is not the expected one. At most
   * once a day per kind, with no figure in the words.
   */
  async mismatch(kind: string, reference: string): Promise<void> {
    await this.alert(
      kind,
      'charge_differs',
      `The provider charged ${kind} differently from the rate on file. Look at the fee records.`,
      reference,
    );
  }

  /**
   * One email a day per kind through the money check's channel (WAWU ID owns
   * the address and the wording of the mail). Never throws: a failure to tell
   * must not fail a rate change or a transaction.
   */
  private async alert(
    kind: string,
    what: 'rate_changed' | 'charge_differs',
    sentence: string,
    ref: string,
  ): Promise<void> {
    try {
      if (this.recipients.length === 0) {
        this.logger.warn(
          'A provider rate alert is due but no recipient is set (MONEY_CHECK_RECIPIENT_WAWU_IDS).',
        );
        return;
      }
      const now = new Date();
      const since = new Date(now.getTime() - DAY_MS);
      // Claim the day for this kind: one row per kind, moved forward only when it is older than a day.
      const claimed = await this.prisma.$executeRaw`
        INSERT INTO "FeeAlertSent" ("kind", "sentAt") VALUES (${kind}, ${now})
        ON CONFLICT ("kind") DO UPDATE SET "sentAt" = ${now}
        WHERE "FeeAlertSent"."sentAt" <= ${since}`;
      if (claimed === 0) return;
      const mail: MoneyCheckMail = {
        night: now.toISOString().slice(0, 10),
        provider: RATE_PROVIDER,
        verdict: 'needs_a_look',
        ranAt: now.toISOString(),
        walletsTotal: 0,
        walletsChecked: 0,
        mismatchCount: 0,
        lookCount: 1,
        checks: [],
        held: {
          openCount: 0,
          openKobo: '0',
          requiredKobo: '0',
          merchantAvailableKobo: null,
        },
        items: [
          {
            check: 'merchant_charges',
            severity: 'look',
            kind: 'merchant_charge_differs',
            ref: ref.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80),
            detail:
              `${what === 'rate_changed' ? 'Provider rate change' : 'Provider charge differs'}: ${sentence}`
                .replace(/[^A-Za-z0-9 .,:;'"()_-]/g, ' ')
                .slice(0, 400),
          },
        ],
        itemsOmitted: 0,
        notices: {},
      };
      for (const id of this.recipients) {
        try {
          await this.mailer.send(id, mail);
        } catch {
          this.logger.warn(
            'A provider rate alert was not taken for one recipient.',
          );
        }
      }
    } catch {
      this.logger.warn('A provider rate alert could not be sent.');
    }
  }
}
