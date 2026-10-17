import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { dropTransactionPin } from '../gate/wallet-gate';
import { PayoutAccountService } from '../saved-accounts/payout-account.service';
import { BANK_TARGET_KEY, type TargetRequest } from './bank-send-target';

/**
 * A withdrawal goes only to an account in the person's own verified name
 * (task WALLET-37; R-51, G-765). A withdrawal is a bank send to the person's
 * saved payout account (W17 to W19); a send to anyone else's account (W8) is
 * unchanged and never looked at here.
 *
 * It runs after `BankSendTargetGuard`, which has just asked the bank for the
 * holder's name now and left it on the request: when that account is the
 * person's payout account and its holder is not the name on their verified
 * identity (the BVN name kept by the check, else the wallet's own account
 * name; with neither, nothing vouches for the account), the send is `409
 * account_not_in_your_name`, answered before the PIN is looked at, so it
 * uses no PIN try and the Idempotency-Key is given back (the WALLET-09
 * pattern, G-762). A holder the bank now names differently from the one kept
 * is `account_name_changed` first, from `BankSendTargetGuard`, as it always
 * was; confirming it is saving the account again, which this rule then
 * decides.
 *
 * The payout account is found by the number and bank the request names, so
 * the same account saved as a beneficiary too is still a withdrawal. Reads
 * our own database only; the bank was asked once, by the guard before this.
 */
@Injectable()
export class PayoutOwnNameGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payout: PayoutAccountService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TargetRequest>();
    const owner = req.user?.sub;
    const resolved = req[BANK_TARGET_KEY];
    if (!owner || !resolved) {
      throw new Error(
        'PayoutOwnNameGuard ran before BankSendTargetGuard resolved the account.',
      );
    }
    try {
      const body = req.body as { bankCode: string; accountNumber: string };
      const isPayout = await this.prisma.moneyPayoutAccount.findFirst({
        where: {
          wawuUserId: owner,
          accountNumber: body.accountNumber,
          OR: [{ bankCode: body.bankCode }, { nuvionBankCode: body.bankCode }],
        },
        select: { wawuUserId: true },
      });
      if (!isPayout) return true;
      const refusal = await this.payout.notYourNameRefusal(
        owner,
        resolved.target,
      );
      if (refusal) throw refusal;
      return true;
    } catch (e) {
      dropTransactionPin(req);
      throw e;
    }
  }
}
