import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { accountNameMatches, readBvnNameKeys } from '../identity/bvn-name';
import { IdentityHasher } from '../identity/identity-config';
import type { PayoutAccountDto } from '../dto/money-request.dto';
import type { PayoutAccountView } from '../money-view.type';
import { MoneyError } from '../money-error';
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
 * The sentence for an account whose holder at the bank is not the person's
 * verified name (R-51, WALLET-37): the bank's name beside the name on the
 * person's wallet when the wallet holds one.
 */
export function notYourNameMessage(
  accountName: string,
  verifiedName: string | null,
): string {
  const rule = 'You can only be paid to an account in your own name.';
  return verifiedName === null
    ? `This account is in the name ${accountName}, which is not your name. ${rule}`
    : `This account is in the name ${accountName}, but your wallet is in the name ${verifiedName}. ${rule}`;
}

/**
 * The payout account (task WALLET-14, A21, W17's default destination): one
 * bank account per person, with Fintava's bank code and the name the bank
 * returned on the name check (never a name the app sent).
 *
 * `matchesBvnName` compares that name with the BVN name, kept by the BVN
 * check only as keyed hashes of its words (`WalletIdentity.bvnNameKeys`,
 * `identity/bvn-name.ts`). It is worked out on every read, never stored, so
 * it cannot go stale. `null` means there is no BVN name to compare with: no
 * passed check kept one, the check behind the wallet is not the one that
 * kept it, IDENTITY_HASH_KEY is not set or has changed since, or the keys
 * are of the first scheme (round 1, not bound to the person).
 *
 * Only an account in the person's own name is saved (WALLET-37, R-51, G-765):
 * a name the bank gives that is not the BVN name (`false`) is refused,
 * `409 account_not_in_your_name`, with the bank's name beside the name on the
 * wallet and nothing stored; a withdrawal to a saved account that is not in
 * the person's name any more is refused the same way before the PIN
 * (`PayoutOwnNameGuard`). With nothing to compare with (`null`) the account
 * is saved, as before: a refusal needs a name that is known to differ. A row
 * saved before this rule keeps reading `false` and cannot be withdrawn to.
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
    // R-51: only the person's own name is saved. Nothing is stored before
    // this, and nothing is held while the bank was asked above.
    const refusal = await this.notYourNameRefusal(wawuUserId, account);
    if (refusal) throw refusal;
    const stamp = this.banks.checkedStamp(account.bankCode);
    const held = await this.prisma.moneyPayoutAccount.findUnique({
      where: { wawuUserId },
      select: { bankCode: true, accountNumber: true },
    });
    // Nuvion's counterparty and payment detail name the account they were
    // made for: a different account never keeps them (NUV-06).
    const sameAccount =
      held !== null &&
      held.bankCode === account.bankCode &&
      held.accountNumber === account.accountNumber;
    const row = await this.prisma.moneyPayoutAccount.upsert({
      where: { wawuUserId },
      create: { wawuUserId, ...account, ...stamp },
      update: {
        ...account,
        ...stamp,
        ...(sameAccount
          ? {}
          : {
              nuvionCounterpartyId: null,
              nuvionPaymentDetailId: null,
              nuvionOperationalCounterpartyId: null,
              nuvionOperationalPaymentDetailId: null,
            }),
      },
      select: PAYOUT_SELECT,
    });
    return this.toView(wawuUserId, row);
  }

  /**
   * The refusal for an account whose holder is not the person's verified
   * name, or null when it is (or there is no verified name to compare with).
   * `account` is what the bank just said, not anything the app sent.
   */
  async notYourNameRefusal(
    wawuUserId: string,
    account: { accountName: string; bankName: string },
  ): Promise<MoneyError | null> {
    const matches = await this.matchesBvnName(wawuUserId, account.accountName);
    if (matches !== false) return null;
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { accountName: true },
    });
    const verifiedName = wallet?.accountName?.trim() || null;
    return new MoneyError(
      'account_not_in_your_name',
      notYourNameMessage(account.accountName, verifiedName),
      {
        accountName: account.accountName,
        bankName: account.bankName,
        ...(verifiedName === null ? {} : { verifiedName }),
      },
    );
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
    const hash = (value: string) => this.hasher.hash('name', value);
    const binding = { wawuUserId, verifiedAt: identity.bvnVerifiedAt };
    // Keys of another scheme, another check or another IDENTITY_HASH_KEY
    // read as null: they cannot be compared, which is not a mismatch.
    const keys = readBvnNameKeys(identity.bvnNameKeys, hash, binding);
    if (!keys) return null;
    return accountNameMatches(keys, accountName, hash, binding);
  }
}
