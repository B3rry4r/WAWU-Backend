import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import { loadMoneyParties } from '../money-party';
import type { RecipientView } from '../money-view.type';
import {
  RECENT_RECIPIENTS_MAX,
  RECIPIENT_SEARCH_MAX,
} from './recipient-config';
import {
  likeLiteral,
  readRecipientQuery,
  type RecipientQuery,
} from './recipient-query';

/** A person the queries found: who, and the name on their wallet (the fallback name). */
type Found = { wawuUserId: string; accountName: string | null };

/**
 * Finding a person to send money to (task WALLET-08, W7): the search, and
 * the people the caller last sent money to. Behind the wallet gate, so the
 * caller always has an open wallet.
 *
 * Who can be found, on both routes:
 * - only a person with an OPEN wallet (a FintavaWallet row; R-6: nobody has
 *   a wallet until they open one). A person with none, or an account deleted
 *   since, is never answered, so the route does not say who is on WAWU
 *   without a wallet;
 * - never the caller;
 * - never a person blocked either way (`BlockedAccountService.hiddenFrom`,
 *   SETTINGS-04): the one list, read once per request. A blocked person is
 *   simply absent, exactly like a person who does not exist, so the answer
 *   cannot be used to learn who blocked whom.
 *
 * What a result carries is `RecipientView` and nothing else: id, name,
 * handle, avatar, tick. Never a phone number (not even masked), an account
 * number, an email, or a BVN or NIN: the queries select none of them, so
 * they cannot reach the answer. A person found by phone is shown the same
 * way as one found by name.
 */
@Injectable()
export class RecipientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  /**
   * `GET /money/recipients?q=`. By phone: the one person whose proved phone
   * (the one their wallet was opened with, E.164) is exactly that number.
   * By name or @handle: whose handle, or the name on whose wallet (or any
   * word of it), begins with the text, case ignored. At most
   * RECIPIENT_SEARCH_MAX, in name order, then id.
   *
   * Names live in WAWU ID, which has no search; the Hub holds the name on
   * the wallet (`FintavaWallet.accountName`, the name the person opened it
   * in) and the handle, so those are what a name search reads (BACKEND_GAPS
   * G-132). The name shown is still WAWU ID's, then the wallet's, then the
   * handle.
   */
  async search(caller: string, raw: string): Promise<RecipientView[]> {
    const query = readRecipientQuery(raw);
    const hidden = await this.blockedAccounts.hiddenFrom(caller);
    const found =
      query.kind === 'phone'
        ? await this.byPhone(caller, hidden, query.e164)
        : await this.byText(caller, hidden, query);
    return this.views(found);
  }

  /**
   * `GET /money/recipients/recent`. The distinct people the caller sent
   * money to, newest first, at most RECENT_RECIPIENTS_MAX: the caller's own
   * completed outgoing rows in the ledger (MONEY-10) that went to a WAWU
   * user as a transfer or a payment, one person once, at the time of their
   * latest. A pending, failed or reversed send is not a person sent to. A
   * person whose wallet is no longer open, or who is blocked either way, is
   * dropped. Reads our ledger only; never asks Fintava.
   */
  async recent(caller: string): Promise<RecipientView[]> {
    const hidden = await this.blockedAccounts.hiddenFrom(caller);
    const found = await this.prisma.$queryRaw<Found[]>(Prisma.sql`
      SELECT e."counterpartyWawuUserId" AS "wawuUserId", w."accountName"
        FROM "FintavaLedgerEntry" e
        JOIN "FintavaWallet" w ON w."wawuUserId" = e."counterpartyWawuUserId"
       WHERE e."walletKind" = 'user'
         AND e."wawuUserId" = ${caller}
         AND e."direction" = 'out'
         AND e."status" = 'completed'
         AND e."counterpartyKind" = 'wawu_user'
         AND e."category" IN ('transfer', 'purchase')
         AND e."counterpartyWawuUserId" <> ${caller}
         AND e."counterpartyWawuUserId" <> ALL(${hidden}::text[])
       GROUP BY e."counterpartyWawuUserId", w."accountName"
       ORDER BY MAX(e."occurredAt") DESC, e."counterpartyWawuUserId"
       LIMIT ${RECENT_RECIPIENTS_MAX}
    `);
    return this.views(found);
  }

  /** The wallet holder whose proved phone is exactly `e164`. */
  private byPhone(
    caller: string,
    hidden: string[],
    e164: string,
  ): Promise<Found[]> {
    // Both places the proved phone is kept: the opening (unique, indexed) and
    // the identity check. They hold the same number for anyone who opened.
    return this.prisma.$queryRaw<Found[]>(Prisma.sql`
      SELECT w."wawuUserId", w."accountName"
        FROM "FintavaWallet" w
       WHERE w."wawuUserId" <> ${caller}
         AND w."wawuUserId" <> ALL(${hidden}::text[])
         AND (
           w."wawuUserId" IN (
             SELECT o."wawuUserId" FROM "FintavaWalletOpening" o
              WHERE o."phone" = ${e164})
           OR w."wawuUserId" IN (
             SELECT i."wawuUserId" FROM "WalletIdentity" i
              WHERE i."verifiedPhone" = ${e164})
         )
       ORDER BY w."wawuUserId"
       LIMIT ${RECIPIENT_SEARCH_MAX}
    `);
  }

  /** Wallet holders whose handle, or wallet name, begins with the text. */
  private byText(
    caller: string,
    hidden: string[],
    query: Exclude<RecipientQuery, { kind: 'phone' }>,
  ): Promise<Found[]> {
    const literal = likeLiteral(query.prefix);
    const begins = `${literal}%`;
    // Any word of the name: after a space (a hyphen is part of a word).
    const wordBegins = `% ${literal}%`;
    const matches =
      query.kind === 'handle'
        ? Prisma.sql`p."handle" ILIKE ${begins} ESCAPE '\\'`
        : Prisma.sql`(
            p."handle" ILIKE ${begins} ESCAPE '\\'
            OR w."accountName" ILIKE ${begins} ESCAPE '\\'
            OR w."accountName" ILIKE ${wordBegins} ESCAPE '\\'
          )`;
    return this.prisma.$queryRaw<Found[]>(Prisma.sql`
      SELECT w."wawuUserId", w."accountName"
        FROM "FintavaWallet" w
        LEFT JOIN "UserProfile" p ON p."wawuUserId" = w."wawuUserId"
       WHERE w."wawuUserId" <> ${caller}
         AND w."wawuUserId" <> ALL(${hidden}::text[])
         AND ${matches}
       ORDER BY lower(COALESCE(NULLIF(btrim(w."accountName"), ''), p."handle")),
                w."wawuUserId"
       LIMIT ${RECIPIENT_SEARCH_MAX}
    `);
  }

  /**
   * The answer, in the order found: name, handle, avatar and tick read now
   * (`loadMoneyParties`, one WAWU ID call and one profile query for the
   * list). Someone nobody can name (no WAWU ID name, wallet name or handle)
   * is left out, as discovery leaves out a creator nobody can name.
   */
  private async views(found: Found[]): Promise<RecipientView[]> {
    if (found.length === 0) return [];
    const parties = await loadMoneyParties(
      this.prisma,
      this.wawuId,
      found.map((f) => f.wawuUserId),
      new Map(
        found.flatMap((f): [string, string][] =>
          f.accountName?.trim() ? [[f.wawuUserId, f.accountName]] : [],
        ),
      ),
    );
    const out: RecipientView[] = [];
    for (const f of found) {
      const p = parties.get(f.wawuUserId);
      if (!p || p.displayName === '') continue;
      out.push({
        wawuUserId: p.wawuUserId,
        displayName: p.displayName,
        handle: p.handle,
        avatarUrl: p.avatarUrl,
        tick: p.tick,
      });
    }
    return out;
  }
}
