import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import {
  isNuvionId,
  nairaDetailsProblem,
  NUVION_NAIRA,
  type NuvionAccountDetailsReading,
  type NuvionAccountsArea,
  nuvionWalletId,
  readNuvionAccount,
  readNuvionAccountDetails,
} from '../areas/accounts';
import type {
  NuvionDelivery,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

const HOUR = 3_600_000;

/**
 * How long a delivery waits for what it needs (the person's entity or
 * account recorded by NUV-02, the account number recorded, Nuvion able to
 * answer) before it is kept as `failed` for review. Not a fee or a limit.
 * PROVISIONAL(NUVION-ACCOUNTS-WAIT, owner=YOU, why=Nuvion does not say how far apart its account and inflow events can arrive; 72 hours is the ledger's own confirm window and NUV-08 reconciles anything later)
 */
export const NUVION_ACCOUNTS_WAIT_MS = 72 * HOUR;

/** Our own marker in NuvionEntity.accountDetailsStatus: the request is out, no answer kept yet. */
export const ACCOUNT_DETAILS_REQUESTED = 'requested';

/** A stop inside the recording transaction: nothing is written, kept for review. */
class AccountStop extends Error {
  constructor(readonly note: string) {
    super(note);
    this.name = 'AccountStop';
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

const done = (note: string): NuvionHandlerResult => ({ outcome: 'done', note });
const failed = (note: string): NuvionHandlerResult => ({
  outcome: 'failed',
  note,
});

/**
 * The person's naira account number (task NUV-04), from Nuvion's account
 * events:
 *
 * - `accounts.created` (the naira `checking` account NUV-02 opened after
 *   approval): the account is tied to the person's NuvionEntity if NUV-02
 *   has not tied it yet, and its account details are requested once
 *   (`POST /account-details`). Once: the details are looked for first
 *   (`GET /account-details?account_id=`), the request is claimed on the
 *   person's row (`accountDetailsStatus` = `requested`, a conditional
 *   update) so two deliveries never both send it, and a claim whose answer
 *   was lost is looked for again before it is ever sent again (after the
 *   money timeout plus the resend safety). Nuvion keeps one set of details
 *   per account for good, so an "already exists" answer is adopted.
 * - `account_details.created` and `.updated`: the details are read back
 *   from Nuvion (`GET /account-details/{id}`) before anything is stored.
 *   `pending`: its id is kept. `active`: the number, the issuing bank and
 *   the holder's name are stored once, and the person's wallet row is
 *   written (FintavaWallet, provider `nuvion`: the account number, the
 *   holder's name, the entity as the customer and `<entity>:<account>` as
 *   the wallet id), and their opening marked `open`. Only then does
 *   `GET /money/wallet` show the number.
 *
 * Every disagreement is a stop, kept as `failed` for review and never
 * fixed silently: details for another entity or account, a second set of
 * details, a second naira account, a number that changes once active, a
 * number another person's wallet holds.
 */
export class NuvionAccountRecorder {
  private readonly logger = new Logger('NuvionAccounts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly area: NuvionAccountsArea,
    private readonly settings: {
      operationalAccountId: string;
      moneyTimeoutMs: number;
      resendSafetyMs: number;
    },
  ) {}

  // -------------------------------------------------------------------------
  // accounts.created
  // -------------------------------------------------------------------------

  async onAccountCreated(d: NuvionDelivery): Promise<NuvionHandlerResult> {
    const account = readNuvionAccount(d.data);
    if (!account) return failed('the delivery carries no account');
    if (account.id === this.settings.operationalAccountId) {
      return done("WAWU's operational account: not a person's");
    }
    if (account.currency !== NUVION_NAIRA || account.type !== 'checking') {
      return done(
        `a ${account.currency ?? '?'} ${account.type ?? '?'} account: not the naira wallet`,
      );
    }
    const entityId = account.entityId ?? d.entityId;
    if (!isNuvionId(entityId) || !isNuvionId(account.id)) {
      return failed(
        'the account or its entity has no id in the form Nuvion uses',
      );
    }
    const tied = await this.tieAccount(
      d,
      entityId,
      account.id,
      account.nuvionBan,
    );
    if (tied.outcome !== 'done' || tied.note !== 'tied') return tied;
    return this.ensureDetails(d, entityId, account.id);
  }

  /**
   * The account on the person's NuvionEntity: kept if it is already this
   * one, written if none is, a stop if another naira account is.
   */
  private async tieAccount(
    d: NuvionDelivery,
    entityId: string,
    accountId: string,
    nuvionBan: string | null,
  ): Promise<NuvionHandlerResult> {
    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: { wawuUserId: true, accountId: true },
    });
    if (!entity) return this.waitOrFail(d, 'no person holds this entity yet');
    if (entity.accountId === accountId) return done('tied');
    if (entity.accountId !== null) {
      return failed(
        'a second naira account for this person; nothing requested (review)',
      );
    }
    try {
      await this.prisma.nuvionEntity.updateMany({
        where: { wawuUserId: entity.wawuUserId, accountId: null },
        data: {
          accountId,
          currency: NUVION_NAIRA,
          ...(nuvionBan ? { nuvionBan } : {}),
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return failed(
          'another person holds this account; nothing requested (review)',
        );
      }
      throw e;
    }
    const now = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: { accountId: true },
    });
    return now?.accountId === accountId
      ? done('tied')
      : failed(
          'a second naira account for this person; nothing requested (review)',
        );
  }

  /** Requests the account's details once, or adopts the ones Nuvion has. */
  async ensureDetails(
    d: NuvionDelivery,
    entityId: string,
    accountId: string,
  ): Promise<NuvionHandlerResult> {
    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: {
        wawuUserId: true,
        accountDetailsId: true,
        accountDetailsStatus: true,
      },
    });
    if (!entity) return this.waitOrFail(d, 'no person holds this entity yet');
    if (entity.accountDetailsId) {
      return done('the account details were already requested');
    }
    let found: NuvionAccountDetailsReading | null;
    try {
      found = await this.area.findAccountDetails(entityId, accountId);
    } catch (e) {
      if (e instanceof WalletProviderError) {
        return this.waitOrFail(
          d,
          `Nuvion could not list the account details (${e.kind})`,
        );
      }
      throw e;
    }
    if (found) return this.recordDetails(entityId, accountId, found);

    // The claim: one request at a time, and a lost one only after the
    // resend window has passed since it was claimed (updatedAt).
    const resendBefore = new Date(
      Date.now() - this.settings.moneyTimeoutMs - this.settings.resendSafetyMs,
    );
    const claimed = await this.prisma.nuvionEntity.updateMany({
      where: {
        wawuUserId: entity.wawuUserId,
        accountDetailsId: null,
        OR: [
          { accountDetailsStatus: null },
          {
            accountDetailsStatus: ACCOUNT_DETAILS_REQUESTED,
            updatedAt: { lt: resendBefore },
          },
        ],
      },
      data: { accountDetailsStatus: ACCOUNT_DETAILS_REQUESTED },
    });
    if (claimed.count !== 1) {
      return this.waitOrFail(
        d,
        'the account details request is out; looked for again later',
      );
    }
    let created: NuvionAccountDetailsReading;
    try {
      created = await this.area.createAccountDetails(entityId, accountId);
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      if (e.recordMayExist) {
        // A lost answer or "already exists": the claim stays, and the next
        // try looks the details up before anything is sent again.
        return this.waitOrFail(
          d,
          `the account details request may have been made (${e.kind}); looked for before any second request`,
        );
      }
      // Refused: nothing was made, so the claim is let go.
      await this.prisma.nuvionEntity.updateMany({
        where: {
          wawuUserId: entity.wawuUserId,
          accountDetailsId: null,
          accountDetailsStatus: ACCOUNT_DETAILS_REQUESTED,
        },
        data: { accountDetailsStatus: null },
      });
      return this.waitOrFail(
        d,
        `Nuvion refused the account details request (${e.kind})`,
      );
    }
    return this.recordDetails(entityId, accountId, created);
  }

  // -------------------------------------------------------------------------
  // account_details.created / .updated
  // -------------------------------------------------------------------------

  async onAccountDetails(d: NuvionDelivery): Promise<NuvionHandlerResult> {
    const delivered = readNuvionAccountDetails(d.data);
    if (!delivered) return failed('the delivery carries no account details');
    const entityId = delivered.entityId ?? d.entityId;
    if (!isNuvionId(entityId) || !isNuvionId(delivered.id)) {
      return failed(
        'the account details or their entity have no id in the form Nuvion uses',
      );
    }
    if (delivered.currency !== null && delivered.currency !== NUVION_NAIRA) {
      return done(
        `${delivered.currency} account details: not the naira wallet`,
      );
    }
    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: { wawuUserId: true, accountId: true },
    });
    if (!entity) return this.waitOrFail(d, 'no person holds this entity yet');

    // Never on the delivery's word alone: read back from Nuvion first.
    let fresh: NuvionAccountDetailsReading;
    try {
      fresh = await this.area.getAccountDetails(entityId, delivered.id);
    } catch (e) {
      if (e instanceof WalletProviderError) {
        return this.waitOrFail(
          d,
          `Nuvion could not read the account details back (${e.kind})`,
        );
      }
      throw e;
    }
    if (fresh.currency !== null && fresh.currency !== NUVION_NAIRA) {
      return done(`${fresh.currency} account details: not the naira wallet`);
    }
    let accountId = entity.accountId;
    if (accountId === null) {
      if (!isNuvionId(fresh.accountId)) {
        return failed('the account details name no account');
      }
      const tied = await this.tieAccount(d, entityId, fresh.accountId, null);
      if (tied.outcome !== 'done' || tied.note !== 'tied') return tied;
      accountId = fresh.accountId;
    }
    return this.recordDetails(entityId, accountId, fresh);
  }

  /**
   * Stores one set of details on the person's row; once `active`, writes
   * their wallet. Idempotent: the same details again change nothing.
   */
  async recordDetails(
    entityId: string,
    accountId: string,
    details: NuvionAccountDetailsReading,
  ): Promise<NuvionHandlerResult> {
    const problem = nairaDetailsProblem(details, { entityId, accountId });
    if (problem !== null && problem !== 'pending') {
      return failed(`${problem}; nothing stored (review)`);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            wawuUserId: string;
            accountDetailsId: string | null;
            accountDetailsStatus: string | null;
            accountNumber: string | null;
          }>
        >`
          SELECT "wawuUserId", "accountDetailsId", "accountDetailsStatus", "accountNumber"
            FROM "NuvionEntity"
           WHERE "entityId" = ${entityId} AND "accountId" = ${accountId}
           FOR UPDATE`;
        const entity = rows[0];
        if (!entity) {
          throw new AccountStop(
            'the account is not the naira account of this entity',
          );
        }
        if (entity.accountDetailsId && entity.accountDetailsId !== details.id) {
          throw new AccountStop(
            'a second set of account details for this account (review)',
          );
        }
        if (problem === 'pending') {
          if (entity.accountDetailsStatus === 'active') {
            return done('the account number is already active');
          }
          await tx.nuvionEntity.update({
            where: { wawuUserId: entity.wawuUserId },
            data: {
              accountDetailsId: details.id,
              accountDetailsStatus: 'pending',
            },
          });
          return done('account details pending; the number is on its way');
        }
        const number = details.accountNumber!;
        if (entity.accountNumber && entity.accountNumber !== number) {
          throw new AccountStop(
            'the account number differs from the one already active (review)',
          );
        }
        await tx.nuvionEntity.update({
          where: { wawuUserId: entity.wawuUserId },
          data: {
            accountDetailsId: details.id,
            accountDetailsStatus: 'active',
            accountNumber: number,
            issuerBankName: details.issuerName,
            issuerBankCode: details.issuerCode,
            currency: NUVION_NAIRA,
          },
        });
        const walletId = nuvionWalletId(entityId, accountId);
        const held = await tx.fintavaWallet.findUnique({
          where: { wawuUserId: entity.wawuUserId },
          select: { accountNumber: true, walletId: true, provider: true },
        });
        if (held) {
          if (
            held.provider === 'nuvion' &&
            held.accountNumber === number &&
            held.walletId === walletId
          ) {
            return done('the account number was already recorded');
          }
          throw new AccountStop(
            'the person already has another wallet; nothing written (review)',
          );
        }
        await tx.fintavaWallet.create({
          data: {
            wawuUserId: entity.wawuUserId,
            customerId: entityId,
            walletId,
            accountNumber: number,
            accountName: details.beneficiaryName,
            provider: 'nuvion',
          },
        });
        await tx.fintavaWalletOpening.updateMany({
          where: {
            wawuUserId: entity.wawuUserId,
            state: { in: ['opening', 'unknown'] },
            provider: 'nuvion',
          },
          data: { state: 'open', failure: null },
        });
        return done('the account number is active; the wallet is recorded');
      });
    } catch (e) {
      if (e instanceof AccountStop) {
        this.logger.error(`account details: ${e.note}`);
        return failed(e.note);
      }
      if (isUniqueViolation(e)) {
        // Another worker recorded the same wallet meanwhile (fine), or the
        // number or the account is another person's (a stop).
        const mine = await this.prisma.fintavaWallet.findFirst({
          where: {
            customerId: entityId,
            accountNumber: details.accountNumber ?? '',
            provider: 'nuvion',
          },
          select: { wawuUserId: true },
        });
        if (mine) return done('the account number was already recorded');
        this.logger.error(
          'account details: the account number or account is held by another wallet; nothing written (review)',
        );
        return failed(
          'the account number or account is held by another wallet; nothing written (review)',
        );
      }
      throw e;
    }
  }

  /** `wait`, or `failed` for review once the delivery has waited too long. */
  waitOrFail(d: NuvionDelivery | null, note: string): NuvionHandlerResult {
    if (d && Date.now() - d.receivedAt.getTime() > NUVION_ACCOUNTS_WAIT_MS) {
      return failed(`${note}; waited past the limit, kept for review`);
    }
    return { outcome: 'wait', note };
  }
}
