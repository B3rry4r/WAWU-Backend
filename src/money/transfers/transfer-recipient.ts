import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { dropTransactionPin } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';

/**
 * Who a send to a WAWU user may go to (task WALLET-07, lead ruling 3), and
 * the one answer for each person it may not go to. Every refusal is its own
 * code and plain sentence, and is given BEFORE the PIN is looked at
 * (`TransferRecipientGuard`), so a person never types a PIN for a send that
 * could not have gone, and a refused send uses no PIN try.
 *
 * - yourself: `400 self_transfer`;
 * - nobody the Hub knows, or an account whose deletion is scheduled (the
 *   account is closed to money: a wallet that is about to be removed must
 *   not be filled): `404 recipient_not_found`, with its own sentence for a
 *   closed account;
 * - a block between the two people, in either direction: `403
 *   recipient_blocked`. The sentence never says who blocked whom;
 * - a person with no open wallet at the provider this server runs (R-6:
 *   nobody has a wallet until they open one; a wallet another provider holds
 *   cannot be sent to from here): `409 recipient_has_no_wallet`.
 *
 * Reads our own database only. It answers the account number the money
 * goes to, which no response ever carries.
 */

export const SELF_TRANSFER_MESSAGE = "You can't send money to yourself.";
export const RECIPIENT_NOT_FOUND_MESSAGE = 'We could not find that person.';
export const RECIPIENT_CLOSED_MESSAGE = 'This account is closed.';
export const RECIPIENT_BLOCKED_MESSAGE = "You can't send money to this person.";
export const RECIPIENT_NO_WALLET_MESSAGE =
  "This person hasn't opened a wallet yet, so they can't receive money.";

/** Where the money goes. */
export interface TransferRecipient {
  wawuUserId: string;
  accountNumber: string;
  /** The name on their wallet, the fallback name of a receipt. */
  accountName: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TransferRecipients {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocks: BlockedAccountService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  /** The recipient, or the refusal for a person the money may not go to. */
  async resolve(
    payer: string,
    recipientWawuUserId: string,
  ): Promise<TransferRecipient> {
    if (recipientWawuUserId === payer) {
      throw new MoneyError('self_transfer', SELF_TRANSFER_MESSAGE);
    }
    const [wallet, profile, closing] = await Promise.all([
      this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId: recipientWawuUserId },
        select: { accountNumber: true, accountName: true, provider: true },
      }),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: recipientWawuUserId },
        select: { wawuUserId: true },
      }),
      this.prisma.pushStoppedAccount.findUnique({
        where: { userWawuId: recipientWawuUserId },
        select: { userWawuId: true },
      }),
    ]);
    if (closing) {
      throw new MoneyError('recipient_not_found', RECIPIENT_CLOSED_MESSAGE);
    }
    if (!wallet && !profile) {
      throw new MoneyError('recipient_not_found', RECIPIENT_NOT_FOUND_MESSAGE);
    }
    if (await this.blocks.isBlockedEitherWay(payer, recipientWawuUserId)) {
      throw new MoneyError('recipient_blocked', RECIPIENT_BLOCKED_MESSAGE);
    }
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) {
      throw new MoneyError(
        'recipient_has_no_wallet',
        RECIPIENT_NO_WALLET_MESSAGE,
      );
    }
    return {
      wawuUserId: recipientWawuUserId,
      accountNumber: wallet.accountNumber,
      accountName: wallet.accountName,
    };
  }
}

/**
 * Runs `TransferRecipients.resolve` for the recipient the request names,
 * after the wallet gate and the Idempotency-Key (a repeat of a finished send
 * is answered first, whatever has happened to the recipient since) and
 * BEFORE the PIN guard (`RequireIdempotentApproval(route, ...guards)`).
 *
 * The body has not been validated yet (guards run before pipes), so a value
 * that is not a user id is left to the validation pipe, which refuses it as
 * it refuses every malformed field. A refusal here drops any PIN or
 * biometric header unread, as the wallet gate does.
 */
@Injectable()
export class TransferRecipientGuard implements CanActivate {
  constructor(private readonly recipients: TransferRecipients) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>();
    const payer = req.user?.sub;
    if (!payer) {
      throw new Error(
        'TransferRecipientGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    const body = req.body as { recipientWawuUserId?: unknown } | undefined;
    const id = body?.recipientWawuUserId;
    if (typeof id !== 'string' || !UUID.test(id)) return true;
    try {
      await this.recipients.resolve(payer, id);
      return true;
    } catch (e) {
      dropTransactionPin(req);
      throw e;
    }
  }
}
