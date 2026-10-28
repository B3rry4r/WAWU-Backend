import type { FxAccount } from '../../../generated/prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { NotificationService } from '../../notification/notification.service';
import { tellWalletReady } from '../opening/wallet-ready-notice';

/**
 * A foreign account is told ready only within this many days of being opened (Nuvion makes details in 5 to 30 minutes). The sweep
 * stops looking after it, and the person's own read marks an older account seen without a notice, so a deploy never sends a late
 * "ready" for an account opened long ago (patch round 1).
 */
export const FOREIGN_DETAILS_NOTICE_DAYS = 3;

/**
 * WALK4-FIX M-2 (money walk 4): the one place a foreign account's "your {currency} account is ready" notice is written.
 *
 * The provider makes an account's details later (5 to 30 minutes), and the Hub learns they are active on three paths: Nuvion's
 * `account_details.updated` delivery (src/nuvion/handlers/fx.handler.ts), the person's own read of their accounts
 * (FxAccountsService.view), and the 15 minute sweep (src/nuvion/handlers/reconcile.handler.ts). Each calls this once it has read
 * the details back from the provider and seen them `active`; it never trusts a delivery or a caller's word.
 *
 * Exactly once per account, whichever paths meet and however often they repeat: `detailsReadyAt` is claimed with a conditional
 * update in the same transaction that writes the notice. A second caller waits on the row's lock, then finds the claim taken and
 * writes nothing; a failure after the claim rolls the claim back with the notice, so the next path tries again. Nothing here
 * calls the provider, so the transaction holds no connection across a network call.
 *
 * Not called for details that were already active in the response that opened the account (the person is looking at them).
 * Answers true when this call wrote the notice.
 */
export async function tellForeignDetailsReady(
  prisma: PrismaService,
  notifications: Pick<NotificationService, 'emitOrThrow'>,
  account: Pick<FxAccount, 'id' | 'wawuUserId' | 'currency'>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.fxAccount.updateMany({
      where: { id: account.id, detailsReadyAt: null },
      data: { detailsReadyAt: new Date() },
    });
    if (claimed.count !== 1) return false;
    await tellWalletReady(
      notifications,
      tx,
      account.wawuUserId,
      account.currency,
    );
    return true;
  });
}
