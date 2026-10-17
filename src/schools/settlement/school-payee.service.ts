import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { SetPayeeDto } from './school-settlement.dto';
import { SETTLEMENT_MESSAGES } from './school-settlement-rules';
import type { SchoolPayeeView } from './school-settlement-view.type';

/**
 * The bank account a school is paid at (task SCHOOLS-11, "payee details and
 * verification"). A school is not a WAWU user, so its share of a course fee is
 * a bank transfer (R-12, R-31). An account is saved only after the bank
 * confirmed it: the name check goes through the wallet provider seam and the
 * holder's name the bank gives is what is kept. Nothing is saved on a miss, so
 * a payout can never go to an account nobody checked. Changing the account is
 * the same call.
 */
@Injectable()
export class SchoolPayeeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  async get(schoolId: string): Promise<SchoolPayeeView> {
    const row = await this.prisma.schoolPayee.findUnique({
      where: { schoolId },
    });
    if (!row) throw new NotFoundException('This school has no payee yet.');
    return this.view(row);
  }

  async set(
    schoolId: string,
    dto: SetPayeeDto,
    adminId: string | null,
  ): Promise<SchoolPayeeView> {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true },
    });
    if (!school) throw new NotFoundException(SETTLEMENT_MESSAGES.noSuchSchool);

    let bank: { code: string; name: string } | undefined;
    let answer: Awaited<ReturnType<WalletProvider['checkAccountName']>>;
    try {
      bank = (await this.provider.listBanks()).find(
        (b) => b.code === dto.bankCode,
      );
      if (!bank) {
        throw new UnprocessableEntityException(SETTLEMENT_MESSAGES.bankUnknown);
      }
      answer = await this.provider.checkAccountName({
        accountNumber: dto.accountNumber,
        bankCode: dto.bankCode,
      });
    } catch (e) {
      if (e instanceof WalletProviderError) {
        throw new ServiceUnavailableException(
          SETTLEMENT_MESSAGES.bankUnreachable,
        );
      }
      throw e;
    }
    if (!answer.matched || !answer.accountName) {
      throw new UnprocessableEntityException(
        SETTLEMENT_MESSAGES.payeeNotConfirmed,
      );
    }

    const now = new Date();
    const data = {
      bankCode: dto.bankCode,
      bankName: bank.name,
      accountNumber: dto.accountNumber,
      accountName: answer.accountName,
      verifiedAt: now,
      setBy: adminId,
    };
    const existing = await this.prisma.schoolPayee.findUnique({
      where: { schoolId },
    });
    const same =
      existing !== null &&
      existing.bankCode === dto.bankCode &&
      existing.accountNumber === dto.accountNumber;
    try {
      const row = await this.prisma.schoolPayee.upsert({
        where: { schoolId },
        create: { schoolId, ...data },
        // A different account gets none of the old account's payee ids.
        update: same
          ? data
          : { ...data, counterpartyId: null, paymentDetailId: null },
      });
      return this.view(row);
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'P2003') {
        throw new ConflictException(SETTLEMENT_MESSAGES.noSuchSchool);
      }
      throw e;
    }
  }

  private view(row: {
    schoolId: string;
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    verifiedAt: Date;
  }): SchoolPayeeView {
    return {
      schoolId: row.schoolId,
      bankCode: row.bankCode,
      bankName: row.bankName,
      accountNumberLast4: row.accountNumber.slice(-4),
      accountName: row.accountName,
      verifiedAt: row.verifiedAt.toISOString(),
    };
  }
}
