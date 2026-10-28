import type { FxAccount } from '../../../generated/prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { tellForeignDetailsReady } from '../../money/fx/fx-details-ready';
import type { NotificationService } from '../../notification/notification.service';
import type { ProviderFxChain } from '../../wallet-provider/wallet-provider-fx';
import type { NuvionWalletProvider } from '../nuvion-wallet-provider';

/** What one look at a foreign account's details came to. */
export type ForeignDetailsLook =
  /** Active, and this look wrote the person's one "ready" notice. */
  | 'told'
  /** Nothing to do: already told, or active and another path told first. */
  | 'noted'
  /** The provider's record still says pending (or holds none). */
  | 'pending'
  /** The provider could not be asked just now; tried again by the next path. */
  | 'unread';

/**
 * WALK4-FIX M-2. Reads a foreign account's details back from the provider (never on a delivery's word) and, when they are
 * `active`, writes the one "Your {currency} account is ready" notice through `tellForeignDetailsReady`. Used by the
 * `account_details.*` delivery (fx.handler.ts) and by the sweep (reconcile.handler.ts); the person's own read has the same
 * rule in FxAccountsService. Reads only: it never asks the provider to make details.
 */
export async function lookAtForeignDetails(
  prisma: PrismaService,
  notifications: Pick<NotificationService, 'emitOrThrow'>,
  fx: NonNullable<NuvionWalletProvider['fx']>,
  account: FxAccount,
): Promise<ForeignDetailsLook> {
  if (account.detailsReadyAt) return 'noted';
  let active: boolean;
  try {
    const wallet = await prisma.fintavaWallet.findUnique({
      where: { wawuUserId: account.wawuUserId },
      select: { walletId: true },
    });
    const read = await fx.readDetails(
      {
        customerId: account.providerCustomerId,
        walletId: wallet?.walletId ?? '',
      },
      {
        accountId: account.providerAccountId ?? '',
        currency: account.currency,
        chain: (account.chain || null) as ProviderFxChain | null,
      },
      false,
    );
    active = read.details?.status === 'active';
  } catch {
    return 'unread';
  }
  if (!active) return 'pending';
  return (await tellForeignDetailsReady(prisma, notifications, account))
    ? 'told'
    : 'noted';
}
