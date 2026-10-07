import { BadRequestException, Injectable } from '@nestjs/common';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CreateBeneficiaryDto } from '../dto/money-request.dto';
import { MoneyError } from '../money-error';
import { loadMoneyParties } from '../money-party';
import type {
  BankAccountView,
  BeneficiaryView,
  MoneyPartyView,
} from '../money-view.type';
import { BankAccountCheckService } from './bank-account-check.service';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';

/**
 * PROVISIONAL(BENEFICIARIES-MAX, owner=YOU, why=no ruling or design names how many beneficiaries a person may save; the contract wants a stated maximum on short lists)
 *
 * The most beneficiaries one person may keep. `GET /money/beneficiaries` is
 * an unpaged array (docs/contract/CONVENTIONS.md section 6: short lists
 * carry a stated maximum), so a save past it is refused with
 * `409 beneficiary_limit_reached` until one is removed.
 */
export const BENEFICIARIES_MAX = 50;

export const RECIPIENT_NOT_FOUND_MESSAGE = 'We could not find that person.';
export const RECIPIENT_NO_WALLET_MESSAGE =
  'They have not opened a wallet yet, so they cannot be saved.';
export const SELF_BENEFICIARY_MESSAGE =
  'You cannot save yourself as a beneficiary.';
export const BENEFICIARY_LIMIT_MESSAGE = `You can save up to ${BENEFICIARIES_MAX} beneficiaries. Remove one to add another.`;
export const BENEFICIARY_MIXED_MESSAGE =
  'Save a person or a bank account, not both.';

type BeneficiaryRow = {
  id: string;
  kind: string;
  recipientWawuId: string | null;
  bankCode: string | null;
  bankName: string | null;
  accountNumber: string | null;
  accountName: string | null;
  createdAt: Date;
};

const ROW_SELECT = {
  id: true,
  kind: true,
  recipientWawuId: true,
  bankCode: true,
  bankName: true,
  accountNumber: true,
  accountName: true,
  createdAt: true,
} as const;

/**
 * Saved beneficiaries (task WALLET-14): W8's saved list, W12's "Save as
 * beneficiary", W35's count. Each is the token holder's own; no route
 * names whose list it is.
 *
 * - A WAWU user is saved only when they have an open wallet (a send to
 *   anyone else is refused anyway), and never the caller themself.
 * - A bank account is saved only after Fintava's name check confirms it,
 *   with the bank's name for the holder, never one the app sent.
 * - Saving one already saved answers the one already there (the two unique
 *   keys make that hold under parallel saves too).
 * - Removing is by id among the caller's own rows only: somebody else's id,
 *   or one already gone, removes nothing and answers the same 200, so ids
 *   cannot be probed.
 * - The list shows a saved WAWU user only while they have a wallet (an
 *   account deleted since keeps no wallet, `account-data-map.ts`).
 */
@Injectable()
export class BeneficiaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly banks: BankAccountCheckService,
    private readonly wawuId: WawuIdClient,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  async list(owner: string): Promise<BeneficiaryView[]> {
    // SETTINGS-04: a saved person the owner blocked, or who blocked the
    // owner, is not offered. The row stays and returns on unblocking.
    const [rows, hidden] = await Promise.all([
      visibleBeneficiaries(this.prisma, owner),
      this.blockedAccounts.hiddenFrom(owner),
    ]);
    const hide = new Set(hidden);
    return this.toViews(
      rows.filter((r) => !r.recipientWawuId || !hide.has(r.recipientWawuId)),
    );
  }

  /**
   * Saves a WAWU user (`wawuUserId`) or a bank account (`bankCode` and
   * `accountNumber`), never both. A body that mixes the two, or misses the
   * fields of its kind, is a plain 400 like any malformed body (the DTO
   * refuses a missing field; this refuses a mix).
   */
  async add(
    owner: string,
    dto: CreateBeneficiaryDto,
  ): Promise<BeneficiaryView> {
    const mixed =
      dto.kind === 'wawu_user'
        ? dto.bankCode !== undefined || dto.accountNumber !== undefined
        : dto.wawuUserId !== undefined;
    if (mixed) throw new BadRequestException(BENEFICIARY_MIXED_MESSAGE);
    if (dto.kind === 'wawu_user') {
      return this.addWawuUser(owner, dto.wawuUserId!);
    }
    return this.addBankAccount(owner, dto.bankCode!, dto.accountNumber!);
  }

  async remove(owner: string, id: string): Promise<void> {
    await this.prisma.moneyBeneficiary.deleteMany({
      where: { id, ownerWawuId: owner },
    });
  }

  // -------------------------------------------------------------------------

  private async addWawuUser(
    owner: string,
    recipient: string,
  ): Promise<BeneficiaryView> {
    if (recipient === owner) {
      throw new MoneyError('self_transfer', SELF_BENEFICIARY_MESSAGE);
    }
    // SETTINGS-04: a hidden person answers as a person who is not found.
    if (await this.blockedAccounts.isBlockedEitherWay(owner, recipient)) {
      throw new MoneyError('recipient_not_found', RECIPIENT_NOT_FOUND_MESSAGE);
    }
    const [wallet, profile] = await Promise.all([
      this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId: recipient },
        select: { wawuUserId: true },
      }),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: recipient },
        select: { wawuUserId: true },
      }),
    ]);
    if (!wallet) {
      if (!profile) {
        throw new MoneyError(
          'recipient_not_found',
          RECIPIENT_NOT_FOUND_MESSAGE,
        );
      }
      throw new MoneyError(
        'recipient_has_no_wallet',
        RECIPIENT_NO_WALLET_MESSAGE,
      );
    }
    // Only now the row already saved, if any: a person whose wallet is gone
    // (a deleted account) is answered as for anyone else above, never with
    // a row the list does not show (round 3, verifier defect 3).
    const existing = await this.prisma.moneyBeneficiary.findUnique({
      where: {
        ownerWawuId_recipientWawuId: {
          ownerWawuId: owner,
          recipientWawuId: recipient,
        },
      },
      select: ROW_SELECT,
    });
    if (existing) return this.one(existing);

    return this.insert(owner, {
      kind: 'wawu_user',
      recipientWawuId: recipient,
    });
  }

  private async addBankAccount(
    owner: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BeneficiaryView> {
    const existing = await this.prisma.moneyBeneficiary.findUnique({
      where: {
        ownerWawuId_bankCode_accountNumber: {
          ownerWawuId: owner,
          bankCode,
          accountNumber,
        },
      },
      select: ROW_SELECT,
    });
    if (existing) return this.one(existing);
    // Refused before the bank is asked when the list is full.
    await this.assertRoom(owner);
    const account: BankAccountView = await this.banks.check(
      bankCode,
      accountNumber,
    );
    return this.insert(owner, { kind: 'bank_account', ...account });
  }

  /**
   * Inserts under a per-person transaction lock, so saves sent at the same
   * moment cannot pass the maximum together. A save that loses a race to
   * the same place (a unique key) answers the row that won.
   */
  private async insert(
    owner: string,
    data:
      | { kind: 'wawu_user'; recipientWawuId: string }
      | ({ kind: 'bank_account' } & BankAccountView),
  ): Promise<BeneficiaryView> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`beneficiaries:${owner}`}, 0))`;
        // The places the list shows, counted under the lock: a saved person
        // whose account is gone holds none (round 2, defect 2).
        const held = await countVisible(tx, owner);
        if (held >= BENEFICIARIES_MAX) {
          throw new MoneyError(
            'beneficiary_limit_reached',
            BENEFICIARY_LIMIT_MESSAGE,
          );
        }
        return tx.moneyBeneficiary.create({
          data: { ownerWawuId: owner, ...data },
          select: ROW_SELECT,
        });
      });
      return this.one(row);
    } catch (e) {
      if (isUniqueViolation(e)) {
        const row = await this.prisma.moneyBeneficiary.findFirst({
          where:
            data.kind === 'wawu_user'
              ? { ownerWawuId: owner, recipientWawuId: data.recipientWawuId }
              : {
                  ownerWawuId: owner,
                  bankCode: data.bankCode,
                  accountNumber: data.accountNumber,
                },
          select: ROW_SELECT,
        });
        if (row) return this.one(row);
      }
      throw e;
    }
  }

  private async assertRoom(owner: string): Promise<void> {
    const held = await countVisible(this.prisma, owner);
    if (held >= BENEFICIARIES_MAX) {
      throw new MoneyError(
        'beneficiary_limit_reached',
        BENEFICIARY_LIMIT_MESSAGE,
      );
    }
  }

  private async one(row: BeneficiaryRow): Promise<BeneficiaryView> {
    const [view] = await this.toViews([row]);
    return view;
  }

  /**
   * Rows as the app shows them: a WAWU user with their name, handle, avatar
   * and tick, read now (one WAWU ID call and one profile query for the
   * page), so a renamed person shows their new name.
   */
  private async toViews(rows: BeneficiaryRow[]): Promise<BeneficiaryView[]> {
    const parties = await this.parties([
      ...new Set(
        rows
          .map((r) => r.recipientWawuId)
          .filter((id): id is string => id !== null),
      ),
    ]);
    const out: BeneficiaryView[] = [];
    for (const row of rows) {
      if (row.kind === 'wawu_user') {
        const party = parties.get(row.recipientWawuId ?? '');
        if (!party) continue;
        out.push({
          id: row.id,
          kind: 'wawu_user',
          wawuUser: party,
          bankAccount: null,
          createdAt: row.createdAt.toISOString(),
        });
        continue;
      }
      out.push({
        id: row.id,
        kind: 'bank_account',
        wawuUser: null,
        bankAccount: {
          bankCode: row.bankCode ?? '',
          bankName: row.bankName ?? '',
          accountNumber: row.accountNumber ?? '',
          accountName: row.accountName ?? '',
        },
        createdAt: row.createdAt.toISOString(),
      });
    }
    return out;
  }

  /**
   * Name, handle, avatar and tick per person (`loadMoneyParties`, shared
   * with the recipient search, WALLET-08): the name from WAWU ID, degrading
   * to the handle, never dropping the row.
   */
  private parties(ids: string[]): Promise<Map<string, MoneyPartyView>> {
    return loadMoneyParties(this.prisma, this.wawuId, ids);
  }
}

/** What the visibility rule reads: the service's client, or one inside a transaction. */
type BeneficiaryReader = Pick<
  PrismaService,
  'moneyBeneficiary' | 'fintavaWallet'
>;

/**
 * The rows the list shows, newest first, at most BENEFICIARIES_MAX: every
 * bank account, and a WAWU user only while they have a wallet (a deleted
 * account keeps none). `WalletView.beneficiaryCount` (W35) and the cap
 * count these same rows, so the count, the cap and the list always agree,
 * and nobody holds a place they cannot see or remove (round 2, defect 2).
 * The rows hidden this way are few (one per saved person whose account was
 * deleted), so all of the person's rows are read and filtered here.
 */
export async function visibleBeneficiaries(
  prisma: BeneficiaryReader,
  owner: string,
): Promise<BeneficiaryRow[]> {
  const rows = await prisma.moneyBeneficiary.findMany({
    where: { ownerWawuId: owner },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: ROW_SELECT,
  });
  const people = rows
    .map((r) => r.recipientWawuId)
    .filter((id): id is string => id !== null);
  const held =
    people.length === 0
      ? new Set<string>()
      : new Set(
          (
            await prisma.fintavaWallet.findMany({
              where: { wawuUserId: { in: people } },
              select: { wawuUserId: true },
            })
          ).map((w) => w.wawuUserId),
        );
  return rows
    .filter((r) => r.kind !== 'wawu_user' || held.has(r.recipientWawuId ?? ''))
    .slice(0, BENEFICIARIES_MAX);
}

/** How many places the person holds: the rows the list shows. */
async function countVisible(
  prisma: BeneficiaryReader,
  owner: string,
): Promise<number> {
  return (await visibleBeneficiaries(prisma, owner)).length;
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}
