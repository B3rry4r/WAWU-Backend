import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  MonthlySummaryQueryDto,
  TransactionListQueryDto,
} from '../dto/money-request.dto';
import {
  PAYMENT_KINDS,
  type PaymentKind,
  type TransactionFilter,
} from '../dto/money-enums';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import type {
  FeeBreakdown,
  MonthlySummaryView,
  TransactionCategory,
  TransactionCounterpartyView,
  TransactionPage,
  TransactionView,
  TransferStatus,
} from '../money-view.type';
import {
  decodeCursor,
  decodeGroupKey,
  encodeCursor,
  encodeGroupKey,
  type HistoryCursor,
  type HistoryGroupKey,
} from './history-keys';
import {
  CATEGORY_LABELS,
  CONTENT_LINK_KINDS,
  COUNTERPARTY_FALLBACK_NAMES,
  DESCRIPTION_SEPARATOR,
  FILTER_RULES,
  GROUP_COUNT_SUFFIX,
  LINK_KIND_LABELS,
  LINK_LABEL_CATEGORIES,
} from './history-labels';

/** No such row for this caller: someone else's is the same 404 (CONVENTIONS.md section 3). */
export const HISTORY_NOT_FOUND_MESSAGE = 'We could not find that transaction.';

export const BAD_MONTH_MESSAGE = 'month must look like 2026-09';

/** The caller's wallet, as the ledger keys its rows (the gate's OpenWallet). */
type HistoryWallet = Pick<OpenWallet, 'wawuUserId' | 'accountNumber'>;

/** Which rows a query reads. */
type Scope =
  | {
      kind: 'history';
      filter: TransactionFilter;
      q: string | null;
      month: string | null;
    }
  | { kind: 'group'; key: HistoryGroupKey }
  | { kind: 'one'; id: string };

/** One row as the SQL below answers it. Kobo travels as text: BIGINT and sums stay exact. */
interface HistoryRow {
  id: string;
  direction: 'in' | 'out';
  category: TransactionCategory;
  status: TransferStatus;
  amountKobo: string;
  feeKobo: string;
  totalKobo: string;
  providerFeeKobo: string | null;
  wawuFeeKobo: string | null;
  cpKind: TransactionCounterpartyView['kind'] | null;
  cpName: string | null;
  cpWawuUserId: string | null;
  cpAccount: string | null;
  cpBankName: string | null;
  cpAvatarUrl: string | null;
  linkKind: string | null;
  linkTargetId: string | null;
  linkTitle: string | null;
  note: string | null;
  reference: string;
  transferId: string | null;
  paymentId: string | null;
  occurredAt: Date;
  day: string;
  isGroup: boolean;
  groupCount: string;
  groupFirstAt: Date;
  description: string;
}

/** BIGINT text to a number, refusing anything a number cannot hold exactly. */
export function koboFromText(text: string): number {
  const big = BigInt(text);
  const n = Number(big);
  if (!Number.isSafeInteger(n) || BigInt(n) !== big) {
    throw new RangeError(
      'A history figure is beyond what a number holds exactly.',
    );
  }
  return n;
}

/** `%`, `_` and `\` mean something to ILIKE; a search for them finds them. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The search text as it is used: trimmed, NUL removed; null when nothing is left. */
export function searchText(q: string | undefined): string | null {
  if (q === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const t = q.replace(/\u0000/g, '').trim();
  return t === '' ? null : t;
}

/**
 * What a money-out row cost, as W27 shows it (R-10): the amount, Fintava's
 * charge, WAWU's fee and the total. The split the sending feature quoted is
 * shown when it adds up to what Fintava says left the wallet; otherwise
 * Fintava's own charge is the provider fee and WAWU's is 0, so the receipt
 * never shows a fee Fintava's record does not back. A money-in row has no
 * fees (the contract's rule).
 */
export function feeOf(row: {
  direction: 'in' | 'out';
  amountKobo: number;
  feeKobo: number;
  totalKobo: number;
  providerFeeKobo: number | null;
  wawuFeeKobo: number | null;
}): FeeBreakdown {
  if (row.direction === 'in') {
    return { providerFeeKobo: 0, wawuFeeKobo: 0, totalFeeKobo: 0 };
  }
  const p = row.providerFeeKobo;
  const w = row.wawuFeeKobo;
  if (p !== null && w !== null && row.amountKobo + p + w === row.totalKobo) {
    return { providerFeeKobo: p, wawuFeeKobo: w, totalFeeKobo: p + w };
  }
  return {
    providerFeeKobo: row.feeKobo,
    wawuFeeKobo: 0,
    totalFeeKobo: row.feeKobo,
  };
}

function last4(account: string | null): string | null {
  if (!account) return null;
  const digits = account.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/* ------------------------------------------------------------------ */
/* SQL pieces                                                          */
/* ------------------------------------------------------------------ */

const text = (v: string) => Prisma.sql`${v}::text`;

/** The row's day in Africa/Lagos time (`occurredAt` is stored as UTC). */
const LOCAL_DAY = Prisma.sql`to_char((e."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`;

/**
 * The rows that may group (WALLET.md, Lead ruling 3): unlock earnings of a
 * piece. Only `completed` ones, so a grouped row's status and sums are
 * always money Fintava confirmed; a pending or failed unlock stays its own
 * row. Default (agent), owner may override.
 */
const GROUPABLE = Prisma.sql`(
  e."category" = 'earning' AND e."direction" = 'in' AND e."status" = 'completed'
  AND e."linkKind" = ${text('content_unlock')} AND e."linkTargetId" IS NOT NULL
)`;

/** The label, from history-labels.ts. */
const LABEL = Prisma.sql`CASE
  ${Prisma.join(
    (PAYMENT_KINDS as readonly PaymentKind[]).map(
      (kind) =>
        Prisma.sql`WHEN e."category"::text IN (${Prisma.join(
          LINK_LABEL_CATEGORIES.map(text),
        )}) AND e."linkKind" = ${text(kind)} THEN ${text(LINK_KIND_LABELS[kind])}`,
    ),
    ' ',
  )}
  ${Prisma.join(
    (Object.keys(CATEGORY_LABELS) as TransactionCategory[]).map(
      (c) =>
        Prisma.sql`WHEN e."category"::text = ${text(c)} THEN ${text(CATEGORY_LABELS[c])}`,
    ),
    ' ',
  )}
  ELSE e."category"::text END`;

const FALLBACK_NAME = Prisma.sql`CASE e."counterpartyKind"::text
  ${Prisma.join(
    Object.entries(COUNTERPARTY_FALLBACK_NAMES).map(
      ([k, v]) => Prisma.sql`WHEN ${text(k)} THEN ${text(v)}`,
    ),
    ' ',
  )}
  END`;

/** The month as a UTC range: Africa/Lagos midnight on the 1st to the next 1st. */
function monthRange(month: string): Prisma.Sql {
  const first = `${month}-01`;
  return Prisma.sql`e."occurredAt" >= ((${first}::timestamp AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'UTC')
    AND e."occurredAt" < ((((${first}::date + interval '1 month')::timestamp) AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'UTC')`;
}

/** A month the database can hold: year 0001 and later. */
function checkedMonth(month: string): string {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000')) {
    throw new BadRequestException(BAD_MONTH_MESSAGE);
  }
  return month;
}

/**
 * The caller's history (task MONEY-15, W26 to W28), read from the ledger
 * (MONEY-10) and nothing else: it never calls Fintava, and it never adds
 * rows up into a balance (the balance is Fintava's, GET /money/wallet/balance).
 *
 * - **Whose rows.** Only rows on the caller's own Fintava wallet
 *   (`walletKind` user, the token's wawuUserId and the account number of
 *   the wallet the gate found, MONEY-13). Someone else's row is the same
 *   404 as no row. No wallet yet never reaches here: the gate answers it.
 * - **Status.** Each row's status is the ledger's, which only Fintava's own
 *   word moves (a send's answer, a signed delivery, a lookup, MONEY-08's
 *   sweep). A row the sweep has not settled stays `pending`; a row whose
 *   sightings disagree stays where it was (`discrepancy`, MONEY-16).
 * - **Order and pages.** Newest first by when the money moved
 *   (`occurredAt`), then id; the cursor is the last row's pair, so a row
 *   landing while someone scrolls never shifts a page.
 * - **Groups** (WALLET.md, Lead ruling 3): two or more completed unlock
 *   earnings of one piece on one Africa/Lagos day are one row; its id,
 *   reference and createdAt are its latest movement's, its amounts the
 *   sums. `group=<key>` lists the movements, one per row.
 * - **The other side's name** is the one the movement recorded, else (for
 *   someone on WAWU) their wallet's account name as Fintava gave it when it
 *   opened (MONEY-12), else their @handle, else a plain word for the kind:
 *   a Fintava delivery names nobody, so a row it wrote has only the id.
 * - **Search** (`q`) looks at what the row shows: the counterparty's name
 *   (and handle), the description, the note and the reference. A grouped
 *   row is searched by its description only (it has no single counterparty,
 *   note or reference of its own).
 * - **The month summary** adds up that month's `completed` rows by
 *   direction, the totals W26 shows (out: what left, fees included; in:
 *   what arrived). Pending, failed and reversed rows are not in it.
 */
@Injectable()
export class TransactionHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    wallet: OpenWallet,
    query: TransactionListQueryDto,
  ): Promise<TransactionPage> {
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const scope: Scope = query.group
      ? { kind: 'group', key: decodeGroupKey(query.group) }
      : {
          kind: 'history',
          filter: query.filter ?? 'all',
          q: searchText(query.q),
          month: query.month ? checkedMonth(query.month) : null,
        };
    const rows = await this.read(wallet, scope, cursor, limit + 1);
    const page = rows.slice(0, limit);
    const lastRow = page[page.length - 1];
    return {
      items: page.map((r) => this.view(r)),
      nextCursor:
        rows.length > limit && lastRow
          ? encodeCursor({
              at: lastRow.occurredAt.toISOString(),
              id: lastRow.id,
            })
          : null,
    };
  }

  async detail(wallet: OpenWallet, id: string): Promise<TransactionView> {
    const [row] = await this.read(wallet, { kind: 'one', id }, null, 1);
    if (!row) throw new MoneyError('not_found', HISTORY_NOT_FOUND_MESSAGE);
    return this.view(row);
  }

  async summary(
    wallet: OpenWallet,
    query: MonthlySummaryQueryDto,
  ): Promise<MonthlySummaryView> {
    const month = checkedMonth(query.month);
    const totals = await this.prisma.$queryRaw<
      Array<{ direction: 'in' | 'out'; total: string }>
    >(Prisma.sql`
      SELECT e."direction"::text AS "direction", SUM(e."totalKobo")::text AS "total"
        FROM "FintavaLedgerEntry" e
       WHERE e."walletKind" = 'user'
         AND e."wawuUserId" = ${wallet.wawuUserId}::text
         AND e."accountNumber" = ${wallet.accountNumber}::text
         AND e."status" = 'completed'
         AND ${monthRange(month)}
       GROUP BY e."direction"
    `);
    const of = (d: 'in' | 'out') => {
      const t = totals.find((x) => x.direction === d);
      return t ? koboFromText(t.total) : 0;
    };
    return { month, inKobo: of('in'), outKobo: of('out') };
  }

  private read(
    wallet: HistoryWallet,
    scope: Scope,
    cursor: HistoryCursor | null,
    take: number,
  ): Promise<HistoryRow[]> {
    const where: Prisma.Sql[] = [
      Prisma.sql`e."walletKind" = 'user'`,
      Prisma.sql`e."wawuUserId" = ${wallet.wawuUserId}::text`,
      Prisma.sql`e."accountNumber" = ${wallet.accountNumber}::text`,
    ];
    if (scope.kind === 'one')
      where.push(Prisma.sql`e."id" = ${scope.id}::text`);
    if (scope.kind === 'group') {
      where.push(
        GROUPABLE,
        Prisma.sql`e."linkTargetId" = ${scope.key.targetId}::text`,
        Prisma.sql`${LOCAL_DAY} = ${scope.key.day}::text`,
      );
    }
    if (scope.kind === 'history' && scope.month)
      where.push(monthRange(scope.month));

    // Only the history collapses groups; a group's own list and one row never do.
    const partition =
      scope.kind === 'history'
        ? Prisma.sql`COALESCE(b."gk", b."id")`
        : Prisma.sql`b."id"`;

    const shown: Prisma.Sql[] = [];
    if (scope.kind === 'history') {
      const rule = FILTER_RULES[scope.filter];
      if (rule.kind === 'direction') {
        shown.push(Prisma.sql`d."direction" = ${rule.direction}::text`);
      } else if (rule.kind === 'bills') {
        shown.push(
          Prisma.sql`(d."category" = 'bill' OR d."linkKind" = 'bill')`,
        );
      } else if (rule.kind === 'content') {
        shown.push(
          Prisma.sql`d."linkKind" IN (${Prisma.join(CONTENT_LINK_KINDS.map(text))})`,
        );
      }
      if (scope.q !== null) {
        const p = likePattern(scope.q);
        shown.push(Prisma.sql`(
          d."description" ILIKE ${p}::text ESCAPE '\\'
          OR (NOT d."isGroup" AND (
            d."cpName" ILIKE ${p}::text ESCAPE '\\'
            OR d."cpHandle" ILIKE ${p}::text ESCAPE '\\'
            OR d."note" ILIKE ${p}::text ESCAPE '\\'
            OR d."reference" ILIKE ${p}::text ESCAPE '\\'
          ))
        )`);
      }
    }
    if (cursor) {
      shown.push(
        Prisma.sql`(d."occurredAt", d."id") < ((${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id}::text)`,
      );
    }

    return this.prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
      WITH base AS (
        SELECT e."id",
               e."direction"::text AS "direction",
               e."category"::text AS "category",
               e."status"::text AS "status",
               e."amountKobo", e."feeKobo", e."totalKobo",
               e."providerFeeKobo", e."wawuFeeKobo",
               e."counterpartyKind"::text AS "cpKind",
               CASE WHEN e."counterpartyKind" IS NOT NULL THEN COALESCE(
                 NULLIF(btrim(e."counterpartyName"), ''),
                 NULLIF(btrim(cw."accountName"), ''),
                 CASE WHEN p."handle" IS NOT NULL THEN '@' || p."handle" END,
                 ${FALLBACK_NAME}
               ) END AS "cpName",
               p."handle" AS "cpHandle",
               e."counterpartyWawuUserId" AS "cpWawuUserId",
               e."counterpartyAccountNumber" AS "cpAccount",
               e."counterpartyBankName" AS "cpBankName",
               p."avatarUrl" AS "cpAvatarUrl",
               e."linkKind", e."linkTargetId",
               NULLIF(btrim(e."linkTitle"), '') AS "linkTitle",
               e."note",
               COALESCE(e."customerReference", e."fintavaReference", e."sessionId",
                        e."fintavaTransactionId", e."tagapayTransRef", e."id") AS "reference",
               e."transferId", e."paymentId", e."occurredAt",
               ${LOCAL_DAY} AS "day",
               ${LABEL} AS "label",
               CASE WHEN ${GROUPABLE} THEN e."linkTargetId" || '|' || ${LOCAL_DAY} END AS "gk"
          FROM "FintavaLedgerEntry" e
          LEFT JOIN "UserProfile" p
            ON e."counterpartyKind" = 'wawu_user'
           AND p."wawuUserId" = e."counterpartyWawuUserId"
          LEFT JOIN "FintavaWallet" cw
            ON e."counterpartyKind" = 'wawu_user'
           AND cw."wawuUserId" = e."counterpartyWawuUserId"
         WHERE ${Prisma.join(where, ' AND ')}
      ),
      sized AS (
        SELECT b.*,
               COUNT(*) OVER w AS "gn",
               ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY b."occurredAt" DESC, b."id" DESC) AS "grn",
               MIN(b."occurredAt") OVER w AS "gFirst",
               SUM(b."amountKobo") OVER w AS "gAmount",
               SUM(b."feeKobo") OVER w AS "gFee",
               SUM(b."totalKobo") OVER w AS "gTotal"
          FROM base b
        WINDOW w AS (PARTITION BY ${partition})
      ),
      collapsed AS (
        SELECT s.*, (s."gk" IS NOT NULL AND s."gn" >= 2 AND ${scope.kind === 'history'}::boolean) AS "isGroup"
          FROM sized s
         WHERE s."grn" = 1
      ),
      described AS (
        SELECT c.*,
               CASE WHEN c."isGroup"
                 THEN concat_ws(${DESCRIPTION_SEPARATOR}::text, c."label", c."linkTitle",
                                c."gn"::text || ${GROUP_COUNT_SUFFIX}::text)
                 ELSE concat_ws(${DESCRIPTION_SEPARATOR}::text, c."label", c."linkTitle",
                                CASE WHEN c."cpKind" = 'bank_account' THEN NULLIF(btrim(c."cpBankName"), '') END)
               END AS "description"
          FROM collapsed c
      )
      SELECT d."id", d."direction", d."category", d."status",
             (CASE WHEN d."isGroup" THEN d."gAmount" ELSE d."amountKobo" END)::text AS "amountKobo",
             (CASE WHEN d."isGroup" THEN d."gFee" ELSE d."feeKobo" END)::text AS "feeKobo",
             (CASE WHEN d."isGroup" THEN d."gTotal" ELSE d."totalKobo" END)::text AS "totalKobo",
             d."providerFeeKobo"::text AS "providerFeeKobo",
             d."wawuFeeKobo"::text AS "wawuFeeKobo",
             d."cpKind", d."cpName", d."cpWawuUserId", d."cpAccount", d."cpBankName", d."cpAvatarUrl",
             d."linkKind", d."linkTargetId", d."linkTitle", d."note", d."reference",
             d."transferId", d."paymentId", d."occurredAt", d."day",
             d."isGroup", d."gn"::text AS "groupCount", d."gFirst" AS "groupFirstAt",
             d."description"
        FROM described d
       ${shown.length ? Prisma.sql`WHERE ${Prisma.join(shown, ' AND ')}` : Prisma.empty}
       ORDER BY d."occurredAt" DESC, d."id" DESC
       LIMIT ${take}
    `);
  }

  /** One SQL row as the contract's TransactionView. */
  private view(r: HistoryRow): TransactionView {
    const amountKobo = koboFromText(r.amountKobo);
    const totalKobo = koboFromText(r.totalKobo);
    const fee = feeOf({
      direction: r.direction,
      amountKobo,
      feeKobo: koboFromText(r.feeKobo),
      totalKobo,
      providerFeeKobo:
        r.isGroup || r.providerFeeKobo === null
          ? null
          : koboFromText(r.providerFeeKobo),
      wawuFeeKobo:
        r.isGroup || r.wawuFeeKobo === null
          ? null
          : koboFromText(r.wawuFeeKobo),
    });
    const isKind = (k: string | null): k is PaymentKind =>
      k !== null && (PAYMENT_KINDS as readonly string[]).includes(k);
    const link =
      isKind(r.linkKind) && r.linkTargetId && r.linkTitle
        ? { kind: r.linkKind, targetId: r.linkTargetId, title: r.linkTitle }
        : null;
    const counterparty: TransactionCounterpartyView | null =
      r.isGroup || r.cpKind === null || r.cpName === null
        ? null
        : {
            kind: r.cpKind,
            name: r.cpName,
            avatarUrl: r.cpKind === 'wawu_user' ? r.cpAvatarUrl : null,
            wawuUserId: r.cpKind === 'wawu_user' ? r.cpWawuUserId : null,
            bankName:
              r.cpKind === 'bank_account' && r.cpBankName?.trim()
                ? r.cpBankName.trim()
                : null,
            accountNumberLast4:
              r.cpKind === 'bank_account' ? last4(r.cpAccount) : null,
          };
    return {
      id: r.id,
      direction: r.direction,
      category: r.category,
      status: r.status,
      amountKobo,
      fee,
      totalKobo,
      description: r.description,
      counterparty,
      link,
      note: r.isGroup ? null : r.note,
      reference: r.reference,
      transferId: r.isGroup ? null : r.transferId,
      paymentId: r.isGroup ? null : r.paymentId,
      group: r.isGroup
        ? {
            key: encodeGroupKey({ targetId: r.linkTargetId!, day: r.day }),
            count: Number(r.groupCount),
            firstAt: r.groupFirstAt.toISOString(),
            lastAt: r.occurredAt.toISOString(),
          }
        : null,
      createdAt: r.occurredAt.toISOString(),
    };
  }
}
