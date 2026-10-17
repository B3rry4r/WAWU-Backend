import {
  type CanActivate,
  ConflictException,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../common/prisma/prisma.service';
import { dropTransactionPin } from '../money/gate/wallet-gate';
import { TransferRecipients } from '../money/transfers/transfer-recipient';
import {
  REQUEST_BEING_PAID_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
  REQUEST_NOT_YOURS_PAY_MESSAGE,
  requestNotPendingMessage,
} from './money-request.constants';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Answers every refusal that does not need the PIN BEFORE the PIN is looked
 * at (INBOX-15), after the wallet gate and the Idempotency-Key (so a repeat
 * of a finished payment is answered first, whatever has happened to the
 * request since): the request is not found, it is not the caller's to pay,
 * it is not pending any more, a payment for it is already on its way, or the
 * requester cannot be sent to (a block, a closed account, no wallet). A
 * refusal here uses no PIN try and gives the key back (IdempotencyFilter).
 * The body has not been validated yet (guards run before pipes), so a path
 * that holds no ids is left to the validation pipe.
 */
@Injectable()
export class MoneyRequestPayGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: TransferRecipients,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user?: WawuJwtClaims; params: Record<string, string> }
      >();
    const payer = req.user?.sub;
    if (!payer) {
      throw new Error(
        'MoneyRequestPayGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    const { chatId, requestId } = req.params;
    if (!UUID.test(chatId ?? '') || !UUID.test(requestId ?? '')) return true;
    try {
      const row = await this.prisma.moneyRequest.findFirst({
        where: {
          id: requestId,
          conversationId: chatId,
          OR: [{ payerWawuId: payer }, { requesterWawuId: payer }],
        },
        select: {
          requesterWawuId: true,
          payerWawuId: true,
          status: true,
          transferId: true,
        },
      });
      if (!row) throw new NotFoundException(REQUEST_NOT_FOUND_MESSAGE);
      if (row.payerWawuId !== payer) {
        throw new ForbiddenException({
          message: REQUEST_NOT_YOURS_PAY_MESSAGE,
          reason: { code: 'money_request_not_yours' },
        });
      }
      if (row.status !== 'pending') {
        throw new ConflictException({
          message: requestNotPendingMessage(row.status),
          reason: {
            code: 'money_request_not_pending',
            status: row.status,
          },
        });
      }
      if (row.transferId !== null) {
        throw new ConflictException({
          message: REQUEST_BEING_PAID_MESSAGE,
          reason: { code: 'money_request_being_paid' },
        });
      }
      await this.recipients.resolve(payer, row.requesterWawuId);
      return true;
    } catch (e) {
      dropTransactionPin(req);
      throw e;
    }
  }
}
