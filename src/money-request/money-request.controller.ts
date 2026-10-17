import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { ChatMessage } from '../chat/chat-view.type';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { RequireFeesSet } from '../money/fees/fees-set.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../money/gate/wallet-gate';
import {
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../money/money-contract';
import type { TransferView } from '../money/money-view.type';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../money/payments/idempotency';
import { MoneyRequestPayGuard } from './money-request-pay.guard';
import { MoneyRequestService } from './money-request.service';
import { MONEY_REQUEST_PAY_ROUTE } from './money-request.constants';
import {
  CreateMoneyRequestDto,
  PayMoneyRequestDto,
} from './dto/money-request.dto';
import type { MoneyRequestView } from './money-request-view.type';

/**
 * Money requests in chat (task INBOX-15, DECISIONS R-13): ask the other
 * person in a chat for money (I16, I17), and pay (I18, I19) or decline their
 * request. New routes under `/chats/:chatId/money-requests`, deeper than
 * every route the chat controller serves. Nothing the web calls changes.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('chats/:chatId/money-requests')
export class MoneyRequestController {
  constructor(private readonly requests: MoneyRequestService) {}

  /**
   * Ask the other person in the chat for money. Writes the request into the
   * chat as a message of kind `money_request` and answers that message,
   * which carries the request. Nothing moves until they pay. The asker needs
   * an open wallet (to receive what they ask for): without one the answer is
   * `409` with `reason.code` `wallet_not_open` or `wallet_opening`. A block
   * in either direction is `403 chat_blocked`. `clientRequestId` makes a
   * resend after a lost answer return the first request.
   */
  @Post()
  @HttpCode(201)
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  create(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Body() dto: CreateMoneyRequestDto,
  ): Promise<ChatMessage> {
    return this.requests.create(user.sub, chatId, dto);
  }

  /**
   * One request as it stands now. A payment that was not confirmed when it
   * was made is settled from its send first, so this is the route the app
   * polls while a request shows `paying`.
   */
  @Get(':requestId')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<MoneyRequestView> {
    return this.requests.get(user.sub, chatId, requestId);
  }

  /**
   * Pay a request: a send to the person who asked, for the amount asked, with
   * the wallet send's fees on top (R-10: the provider's charge and WAWU's
   * fee, quoted by `GET /money/fees/quote?kind=wawu_transfer`; the requester
   * gets exactly the amount). Only the person who was asked can pay, and only
   * while the request is `pending` and no payment for it is on its way. Answers
   * 201 with the send, as `POST /money/transfers/wawu` does: completed (the
   * request is then `paid`), pending (not confirmed yet: the request shows
   * `paying`, and is never paid again), or failed (nothing moved; the request
   * is still `pending`). The same Idempotency-Key and body answer the first
   * result again (`Idempotent-Replayed: true`) without checking the PIN. A
   * request that is not the caller's, no longer pending, or already being paid
   * is answered before the PIN is looked at: `403 money_request_not_yours`,
   * `409 money_request_not_pending`, `409 money_request_being_paid`.
   */
  @Post(':requestId/pay')
  @HttpCode(201)
  @RequireIdempotentApproval(MONEY_REQUEST_PAY_ROUTE, MoneyRequestPayGuard)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'recipient_not_found',
    'recipient_has_no_wallet',
    'recipient_blocked',
    'self_transfer',
  )
  @RequireFeesSet()
  pay(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: PayMoneyRequestDto,
  ): Promise<TransferView> {
    return this.requests.pay(wallet, scope, chatId, requestId, dto);
  }

  /** The person who was asked says no. Final; the same answer again is not an error. */
  @Post(':requestId/decline')
  @HttpCode(200)
  decline(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<MoneyRequestView> {
    return this.requests.decline(user.sub, chatId, requestId);
  }

  /** The person who asked takes it back. Final; the same answer again is not an error. */
  @Post(':requestId/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<MoneyRequestView> {
    return this.requests.cancel(user.sub, chatId, requestId);
  }
}
