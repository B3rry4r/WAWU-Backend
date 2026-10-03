import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { accountNameMatches, readBvnNameKeys } from '../identity/bvn-name';
import { IdentityHasher } from '../identity/identity-config';
import type { PayoutAccountDto } from '../dto/money-request.dto';
import type { PayoutAccountView } from '../money-view.type';
import { BankAccountCheckService } from './bank-account-check.service';

type PayoutRow = {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  updatedAt: Date;
};

const PAYOUT_SELECT = {
  bankCode: true,
  bankName: true,
  accountNumber: true,
  accountName: true,
  updatedAt: true,
} as const;

/**
 * The payout account (task WALLET-14, A21, W17's default destination): one
 * bank account per person, with Fintava's bank code and the name the bank
 * returned on the name check (never a name the app sent).
 *
 * `matchesBvnName` compares that name with the BVN name, kept by the BVN
 * check only as keyed hashes of its words (`WalletIdentity.bvnNameKeys`,
 * `identity/bvn-name.ts`). It is worked out on every read, never stored, so
 * it cannot go stale. An account whose name is not the BVN name is saved
 * and flagged (`false`), not refused: A21 shows the person, and whatever
 * the withdrawal does with a flagged account is WALLET-05's and WALLET-09's
 * (mobile repo BACKEND_GAPS G-46). `null` means there is no BVN name to
 * compare with: no passed check kept one, the check behind the wallet is
 * not the one that kept it, or IDENTITY_HASH_KEY is not set.
 */
@Injectable()
export class PayoutAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly banks: BankAccountCheckService,
    private readonly hasher: IdentityHasher,
  ) {}

  async get(wawuUserId: string): Promise<PayoutAccountView | null> {
    const row = await this.prisma.moneyPayoutAccount.findUnique({
      where: { wawuUserId },
      select: PAYOUT_SELECT,
    });
    return row ? this.toView(wawuUserId, row) : null;
  }

  /** Name-checks the account with the bank, then saves it in place of any other. */
  async set(
    wawuUserId: string,
    dto: PayoutAccountDto,
  ): Promise<PayoutAccountView> {
    const account = await this.banks.check(dto.bankCode, dto.accountNumber);
    const row = await this.prisma.moneyPayoutAccount.upsert({
      where: { wawuUserId },
      create: { wawuUserId, ...account },
      update: account,
      select: PAYOUT_SELECT,
    });
    return this.toView(wawuUserId, row);
  }

  private async toView(
    wawuUserId: string,
    row: PayoutRow,
  ): Promise<PayoutAccountView> {
    return {
      bankCode: row.bankCode,
      bankName: row.bankName,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      matchesBvnName: await this.matchesBvnName(wawuUserId, row.accountName),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Whether the bank's name for the account is the BVN name, or null when
   * there is no BVN name to compare with. The keys must belong to the BVN
   * check the wallet was opened with (MONEY-12 records its keyed BVN hash):
   * a check passed later for another BVN never vouches for the account.
   */
  private async matchesBvnName(
    wawuUserId: string,
    accountName: string,
  ): Promise<boolean | null> {
    if (!this.hasher.configured) return null;
    const [identity, opening] = await Promise.all([
      this.prisma.walletIdentity.findUnique({
        where: { wawuUserId },
        select: { bvnHash: true, bvnVerifiedAt: true, bvnNameKeys: true },
      }),
      this.prisma.fintavaWalletOpening.findUnique({
        where: { wawuUserId },
        select: { bvnHash: true },
      }),
    ]);
    if (!identity?.bvnVerifiedAt || !identity.bvnHash) return null;
    if (opening && opening.bvnHash !== identity.bvnHash) return null;
    const keys = readBvnNameKeys(identity.bvnNameKeys);
    if (!keys) return null;
    return accountNameMatches(keys, accountName, (word) =>
      this.hasher.hash('name', word),
    );
  }
}
