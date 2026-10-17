import type { Prisma } from '../../../generated/prisma/client';
import type { NotificationService } from '../../notification/notification.service';

/**
 * WALLET-40 (owner answer 31, 17 Oct 2026; BACKEND_GAPS G-823): the one
 * notice that tells a person their account number is ready.
 *
 * Provider-neutral. Both ways a wallet is recorded after an opening began
 * call it, from inside the transaction that writes the `FintavaWallet` row:
 *
 * - the legacy opening's sweep, when it finds the account of a lost answer
 *   (`WalletOpeningService.record`, announced only from the sweep);
 * - the Nuvion account recorder, when the account number goes `active`
 *   (`src/nuvion/handlers/accounts.ts`).
 *
 * Why in that transaction: `FintavaWallet.wawuUserId` is the primary key and
 * the row is created exactly once, so the notice is written exactly once per
 * wallet however often the provider repeats a webhook, in whatever order its
 * events arrive, and however many servers take them. The row and the notice
 * stand or fall together: a wallet without its notice cannot be committed, and
 * a notice without its wallet cannot exist. Nothing here makes a network call
 * (the phone push is sent later from the notification table, INBOX-03), so the
 * transaction holds no connection across one.
 *
 * Not called for a number that was ready in the request that opened the wallet
 * (the person is looking at it).
 *
 * The words are fixed in `composeNotification` and carry no account number.
 */
export async function tellWalletReady(
  notifications: Pick<NotificationService, 'emitOrThrow'>,
  tx: Prisma.TransactionClient,
  wawuUserId: string,
): Promise<void> {
  await notifications.emitOrThrow(
    { kind: 'wallet_ready', userWawuId: wawuUserId },
    tx,
  );
}

/** What a recorder calls inside its transaction once the wallet row is written. */
export type WalletReadyTeller = (
  tx: Prisma.TransactionClient,
  wawuUserId: string,
) => Promise<void>;
