import { BadRequestException, Injectable } from '@nestjs/common';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { deriveVerificationState } from '../../common/verification/verification-state';
import type { CreateBeneficiaryDto } from '../dto/money-request.dto';
import { MoneyError } from '../money-error';
import type {
  BankAccountView,
  BeneficiaryView,
  MoneyPartyView,
} from '../money-view.type';
import { BankAccountCheckService } from './bank-account-check.service';
import { requireOpenWallet } from './open-wallet-gate';

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
  ) {}

  async list(owner: string): Promise<BeneficiaryView[]> {
    await requireOpenWallet(this.prisma, owner);
    return this.toViews(await visibleBeneficiaries(this.prisma, owner));
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
    await requireOpenWallet(this.prisma, owner);
    if (dto.kind === 'wawu_user') {
      return this.addWawuUser(owner, dto.wawuUserId!);
    }
    return this.addBankAccount(owner, dto.bankCode!, dto.accountNumber!);
  }

  async remove(owner: string, id: string): Promise<void> {
    await requireOpenWallet(this.prisma, owner);
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
        const held = await tx.moneyBeneficiary.count({
          where: { ownerWawuId: owner },
        });
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
    const held = await this.prisma.moneyBeneficiary.count({
      where: { ownerWawuId: owner },
    });
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
   * Name, handle, avatar and tick per person, the way chats read people
   * (ChatService.people): the name from WAWU ID, the rest from the profile.
   * WAWU ID being unreachable degrades the name to the handle, never drops
   * the row. MoneyPartyView carries one tick; a person holding both shows
   * the purple creator one. Default (agent), owner may override.
   */
  private async parties(ids: string[]): Promise<Map<string, MoneyPartyView>> {
    const out = new Map<string, MoneyPartyView>();
    if (ids.length === 0) return out;
    const [identities, profiles] = await Promise.all([
      this.wawuId.lookupPublicIdentities(ids),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: ids } },
        select: {
          wawuUserId: true,
          handle: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
    ]);
    const profileBy = new Map(profiles.map((p) => [p.wawuUserId, p]));
    for (const id of ids) {
      const identity = identities.get(id);
      const profile = profileBy.get(id);
      const name = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const ticks = deriveVerificationState(profile ?? null);
      out.set(id, {
        wawuUserId: id,
        displayName: name || profile?.handle || '',
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        tick: ticks.creator.verified
          ? 'creator'
          : ticks.professional.verified
            ? 'professional'
            : null,
      });
    }
    return out;
  }
}

/**
 * The rows the list shows, newest first: every bank account, and a WAWU
 * user only while they have a wallet. `WalletView.beneficiaryCount` (W35)
 * counts these same rows, so the count and the list always agree.
 */
export async function visibleBeneficiaries(
  prisma: PrismaService,
  owner: string,
): Promise<BeneficiaryRow[]> {
  const rows = await prisma.moneyBeneficiary.findMany({
    where: { ownerWawuId: owner },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: BENEFICIARIES_MAX,
    select: ROW_SELECT,
  });
  const people = rows
    .map((r) => r.recipientWawuId)
    .filter((id): id is string => id !== null);
  if (people.length === 0) return rows;
  const wallets = await prisma.fintavaWallet.findMany({
    where: { wawuUserId: { in: people } },
    select: { wawuUserId: true },
  });
  const held = new Set(wallets.map((w) => w.wawuUserId));
  return rows.filter(
    (r) => r.kind !== 'wawu_user' || held.has(r.recipientWawuId ?? ''),
  );
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}
