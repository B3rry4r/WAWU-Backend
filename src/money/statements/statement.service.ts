import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PAYMENT_KINDS, type PaymentKind } from '../dto/money-enums';
import type { OpenWallet } from '../gate/wallet-gate';
import {
  CATEGORY_LABELS,
  COUNTERPARTY_FALLBACK_NAMES,
  DESCRIPTION_SEPARATOR,
  LINK_KIND_LABELS,
  LINK_LABEL_CATEGORIES,
} from '../history/history-labels';
import { feeOf, koboFromText } from '../history/transaction-history.service';
import { MoneyError } from '../money-error';
import type { TransactionCategory } from '../money-view.type';
import {
  calendarDay,
  CSV_BOM,
  headerLine,
  lagosToday,
  movementLine,
  type StatementLine,
} from './statement-csv';
import { STATEMENT_MAX_ROWS, StatementSlots } from './statement-config';
import type { StatementQueryDto } from './statement-query.dto';
import { STATEMENT_TIME_ZONE, type StatementView } from './statement-view.type';

/**
 * PROVISIONAL(STATEMENT-MAX-DAYS, owner=YOU, why=no ruling or design names how long a period one statement may cover; W38 draws presets up to 3 months and a custom range)
 *
 * The longest period one statement covers, both days counted: a year,
 * leap day included. A longer period is refused with a 400. This bounds
 * days, not rows: a busy wallet can hold any number of movements in a year,
 * so the rows are capped on their own (STATEMENT_MAX_ROWS, counted before
 * the file is built), each person is limited (STATEMENT_RATE_LIMITS) and
 * two are built at once (STATEMENT_CONCURRENCY), all in statement-config.ts.
 */
export const STATEMENT_MAX_DAYS = 366;

export const STATEMENT_NOT_A_DAY_MESSAGE = (field: 'from' | 'to') =>
  `${field} is not a day on the calendar`;
export const STATEMENT_ORDER_MESSAGE = 'from must be on or before to';
export const STATEMENT_FUTURE_MESSAGE =
  'to cannot be after today in Lagos time';
export const STATEMENT_TOO_LONG_MESSAGE = `A statement covers at most ${STATEMENT_MAX_DAYS} days`;

export const STATEMENT_TOO_LARGE_MESSAGE = `This period has more than ${String(STATEMENT_MAX_ROWS).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} movements, more than one statement lists. Pick a shorter range.`;

export const STATEMENT_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** One ledger row as the SQL below answers it. Kobo travels as text. */
interface StatementRow {
  id: string;
  direction: 'in' | 'out';
  category: TransactionCategory;
  amountKobo: string;
  feeKobo: string;
  totalKobo: string;
  providerFeeKobo: string | null;
  wawuFeeKobo: string | null;
  cpKind: keyof typeof COUNTERPARTY_FALLBACK_NAMES | null;
  cpRecordedName: string | null;
  cpWalletName: string | null;
  cpHandle: string | null;
  cpBankName: string | null;
  linkKind: string | null;
  linkTitle: string | null;
  note: string | null;
  reference: string;
  day: string;
  time: string;
}

/**
 * Statements (task WALLET-27, W38): the caller's own movements over a
 * period of days, as a CSV file.
 *
 * - **Whose rows.** Only rows on the caller's own Fintava wallet, exactly
 *   as the history reads them (MONEY-15): `walletKind` user, the token's
 *   wawuUserId and the account number of the wallet the gate found. No
 *   request names a person or a wallet, so nobody can ask for anyone
 *   else's statement.
 * - **Which rows.** The `completed` movements whose `occurredAt` falls in
 *   the period: the money that moved, as Fintava confirmed it. A pending
 *   movement is not yet money, a failed one never was, and a reversed one
 *   came back; none of them is listed. These are the rows the history's
 *   month summary adds up, so a month's statement and W26's In and Out
 *   agree. Unlock earnings are listed one by one, never grouped.
 *   Default (agent), owner may override.
 * - **The period** is two calendar days in Africa/Lagos time, both
 *   included: from 00:00 on `from` to the end of `to`, Lagos time.
 * - **No balance.** A statement lists movements and nothing else: no
 *   opening or closing balance and no totals, because the only balance is
 *   Fintava's live one, and Fintava gives no balance at a past moment.
 *   Adding rows up and calling it a balance is what the money rules forbid.
 * - **The words** on each line are the history's (history-labels.ts):
 *   the same description, the same other side's name and the same
 *   reference, so a line can be found on W26 and W27.
 * - It never calls Fintava: the ledger is Fintava's records as WAWU
 *   mirrors them (MONEY-10).
 */
@Injectable()
export class StatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slots: StatementSlots,
  ) {}

  async statement(
    wallet: Pick<OpenWallet, 'wawuUserId' | 'accountNumber'>,
    query: StatementQueryDto,
    now: Date = new Date(),
  ): Promise<StatementView> {
    const { from, to } = checkedPeriod(query.from, query.to, now);
    // Two at once in the process; the rest wait their turn or are busy.
    return this.slots.run(() => this.build(wallet, query, from, to, now));
  }

  private async build(
    wallet: Pick<OpenWallet, 'wawuUserId' | 'accountNumber'>,
    query: StatementQueryDto,
    from: string,
    to: string,
    now: Date,
  ): Promise<StatementView> {
    // The rows a statement lists: the caller's own completed movements in
    // the period (the history's three keys, MONEY-15).
    const listed = Prisma.sql`e."walletKind" = 'user'
         AND e."wawuUserId" = ${wallet.wawuUserId}::text
         AND e."accountNumber" = ${wallet.accountNumber}::text
         AND e."status" = 'completed'
         AND e."occurredAt" >= ((${from}::date::timestamp AT TIME ZONE ${STATEMENT_TIME_ZONE}::text) AT TIME ZONE 'UTC')
         AND e."occurredAt" < ((((${to}::date + 1)::timestamp) AT TIME ZONE ${STATEMENT_TIME_ZONE}::text) AT TIME ZONE 'UTC')`;
    // Counted first, and no further than one past the cap: a period with
    // too many rows is refused before any row is read into a file.
    const [{ n }] = await this.prisma.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT COUNT(*)::int AS "n" FROM (
        SELECT 1 FROM "FintavaLedgerEntry" e WHERE ${listed}
         LIMIT ${STATEMENT_MAX_ROWS + 1}
      ) capped`,
    );
    if (n > STATEMENT_MAX_ROWS) {
      throw new MoneyError('statement_too_large', STATEMENT_TOO_LARGE_MESSAGE);
    }
    const rows = await this.prisma.$queryRaw<StatementRow[]>(Prisma.sql`
      SELECT e."id",
             e."direction"::text AS "direction",
             e."category"::text AS "category",
             e."amountKobo"::text AS "amountKobo",
             e."feeKobo"::text AS "feeKobo",
             e."totalKobo"::text AS "totalKobo",
             e."providerFeeKobo"::text AS "providerFeeKobo",
             e."wawuFeeKobo"::text AS "wawuFeeKobo",
             e."counterpartyKind"::text AS "cpKind",
             NULLIF(btrim(e."counterpartyName"), '') AS "cpRecordedName",
             NULLIF(btrim(cw."accountName"), '') AS "cpWalletName",
             p."handle" AS "cpHandle",
             NULLIF(btrim(e."counterpartyBankName"), '') AS "cpBankName",
             e."linkKind",
             NULLIF(btrim(e."linkTitle"), '') AS "linkTitle",
             e."note",
             COALESCE(e."customerReference", e."fintavaReference", e."sessionId",
                      e."fintavaTransactionId", e."tagapayTransRef", e."id") AS "reference",
             to_char((e."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${STATEMENT_TIME_ZONE}::text, 'YYYY-MM-DD') AS "day",
             to_char((e."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${STATEMENT_TIME_ZONE}::text, 'HH24:MI') AS "time"
        FROM "FintavaLedgerEntry" e
        LEFT JOIN "UserProfile" p
          ON e."counterpartyKind" = 'wawu_user'
         AND p."wawuUserId" = e."counterpartyWawuUserId"
        LEFT JOIN "FintavaWallet" cw
          ON e."counterpartyKind" = 'wawu_user'
         AND cw."wawuUserId" = e."counterpartyWawuUserId"
       WHERE ${listed}
       ORDER BY e."occurredAt" ASC, e."id" ASC
       LIMIT ${STATEMENT_MAX_ROWS + 1}
    `);
    // Movements that landed between the count and this read can only be
    // real ones; the cap still holds.
    if (rows.length > STATEMENT_MAX_ROWS) {
      throw new MoneyError('statement_too_large', STATEMENT_TOO_LARGE_MESSAGE);
    }
    const lines = rows.map((r) => movementLine(lineOf(r)));
    return {
      from,
      to,
      timeZone: STATEMENT_TIME_ZONE,
      format: query.format,
      fileName: `statement-${from}-to-${to}.csv`,
      contentType: STATEMENT_CONTENT_TYPE,
      rowCount: lines.length,
      content: `${CSV_BOM}${headerLine()}${lines.join('')}`,
      generatedAt: now.toISOString(),
    };
  }
}

/**
 * The period as asked, once it is a real one: two days on the calendar,
 * in order, not past today in Lagos, at most STATEMENT_MAX_DAYS long.
 */
export function checkedPeriod(
  from: string,
  to: string,
  now: Date,
): { from: string; to: string } {
  const a = calendarDay(from);
  if (a === null)
    throw new BadRequestException(STATEMENT_NOT_A_DAY_MESSAGE('from'));
  const b = calendarDay(to);
  if (b === null)
    throw new BadRequestException(STATEMENT_NOT_A_DAY_MESSAGE('to'));
  if (a > b) throw new BadRequestException(STATEMENT_ORDER_MESSAGE);
  const today = calendarDay(lagosToday(now));
  if (today !== null && b > today)
    throw new BadRequestException(STATEMENT_FUTURE_MESSAGE);
  if (b - a + 1 > STATEMENT_MAX_DAYS)
    throw new BadRequestException(STATEMENT_TOO_LONG_MESSAGE);
  return { from, to };
}

/** What the history calls a movement (history-labels.ts), without its group count. */
export function describeMovement(r: {
  category: TransactionCategory;
  linkKind: string | null;
  linkTitle: string | null;
  cpKind: string | null;
  cpBankName: string | null;
}): string {
  const isKind = (k: string | null): k is PaymentKind =>
    k !== null && (PAYMENT_KINDS as readonly string[]).includes(k);
  const label =
    LINK_LABEL_CATEGORIES.includes(r.category) && isKind(r.linkKind)
      ? LINK_KIND_LABELS[r.linkKind]
      : (CATEGORY_LABELS[r.category] ?? r.category);
  return [label, r.linkTitle, r.cpKind === 'bank_account' ? r.cpBankName : null]
    .filter((part): part is string => Boolean(part))
    .join(DESCRIPTION_SEPARATOR);
}

/** The other side's name as the history gives it: recorded, wallet name, @handle, a plain word. */
export function counterpartyName(r: {
  cpKind: keyof typeof COUNTERPARTY_FALLBACK_NAMES | null;
  cpRecordedName: string | null;
  cpWalletName: string | null;
  cpHandle: string | null;
}): string | null {
  if (r.cpKind === null) return null;
  return (
    r.cpRecordedName ??
    r.cpWalletName ??
    (r.cpHandle !== null ? `@${r.cpHandle}` : null) ??
    COUNTERPARTY_FALLBACK_NAMES[r.cpKind] ??
    null
  );
}

function lineOf(r: StatementRow): StatementLine {
  const amountKobo = koboFromText(r.amountKobo);
  const totalKobo = koboFromText(r.totalKobo);
  const fee = feeOf({
    direction: r.direction,
    amountKobo,
    feeKobo: koboFromText(r.feeKobo),
    totalKobo,
    providerFeeKobo:
      r.providerFeeKobo === null ? null : koboFromText(r.providerFeeKobo),
    wawuFeeKobo: r.wawuFeeKobo === null ? null : koboFromText(r.wawuFeeKobo),
  });
  return {
    date: r.day,
    time: r.time,
    description: describeMovement(r),
    counterparty: counterpartyName(r),
    reference: r.reference,
    note: r.note,
    direction: r.direction,
    totalKobo,
    feeKobo: fee.totalFeeKobo,
  };
}
