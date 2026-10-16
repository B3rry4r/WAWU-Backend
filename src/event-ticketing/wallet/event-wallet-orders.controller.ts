import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { RequireFeesSet } from '../../money/fees/fees-set.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../../money/gate/wallet-gate';
import {
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../../money/money-contract';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../../money/payments/idempotency';
import {
  CreateEventWalletOrderDto,
  PayEventWalletOrderDto,
} from './event-wallet-order.dto';
import { EVENT_ORDER_PAY_ROUTE } from './event-wallet-order-rules';
import { EventWalletOrderService } from './event-wallet-order.service';
import type {
  EventWalletOrderQuoteView,
  EventWalletOrderView,
} from './event-wallet-order-view.type';

/**
 * Buy event tickets from the wallet (task EVENTS-07, E2 to E5 and E10). The
 * web's Flutterwave routes (`POST events/:id/orders` and `POST
 * events/orders/:orderId/verify`) are untouched; these sit under
 * `events/:id/orders/wallet` and `events/orders/wallet`, paths none of the
 * web's routes matches (every one is deeper than EventController's
 * `GET :id`). `events/orders/wallet/pay` comes before the id routes, so a
 * request to it is never taken for an id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('events')
export class EventWalletOrdersController {
  constructor(private readonly orders: EventWalletOrderService) {}

  /**
   * Makes an order from the tickets picked in E2 (one line per ticket type,
   * so a Regular and a VIP ticket are one payment) and answers E3: the order
   * priced by the server and the wallet payment's quote (the tickets, the
   * provider's charge, the total, the balance and any shortfall). Nothing is
   * reserved and nothing is debited. A basket that costs nothing (R-8) is
   * issued here: it answers `paid` with the tickets and `payment: null`, and
   * needs no wallet and no PIN. A basket that costs money needs an open
   * wallet: the answer is `409` with `reason.code` `wallet_not_open` or
   * `wallet_opening`, and the app leads to Open your wallet.
   *
   * With an `Idempotency-Key`, the same key and the same tickets answer the
   * same order, so a repeated tap never issues or quotes a second one; the
   * same key with other tickets is `409 idempotency_key_reused`, and a key
   * that is not 8 to 128 letters, digits, dashes or underscores is `400
   * idempotency_key_required`. A priced basket is quoted, so while the
   * running provider's fees are not set it answers `503 fees_not_set`; a free
   * one never asks for them.
   */
  @Post(':id/orders/wallet')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'createEventWalletOrder' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. One value per tap on Get tickets (a UUID); sent again unchanged on a retry, it answers the same order.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  })
  @MoneyErrors(
    'target_not_found',
    'target_not_payable',
    'wallet_not_open',
    'wallet_opening',
    'idempotency_key_reused',
    'idempotency_key_required',
    'fees_not_set',
  )
  create(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateEventWalletOrderDto,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<EventWalletOrderQuoteView> {
    return this.orders.create(user.sub, eventId, dto, key);
  }

  /**
   * Pays the order from the wallet, once: the tickets' price moves into
   * WAWU's own account and waits there until the event (R-19), with the
   * provider's charge on top (R-10). Answers 201 with the order. `processing`
   * while the payment is not confirmed or the tickets are being issued (E10:
   * poll `GET /events/orders/wallet/{id}`; never pay again), `paid` with the
   * tickets, or `failed` with the money on its way back. The same
   * Idempotency-Key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN.
   */
  @Post('orders/wallet/pay')
  @HttpCode(201)
  @RequireIdempotentApproval(EVENT_ORDER_PAY_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'target_not_found',
    'target_not_payable',
    'payment_in_progress',
  )
  @RequireFeesSet()
  pay(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: PayEventWalletOrderDto,
  ): Promise<EventWalletOrderView> {
    return this.orders.pay(wallet, scope, dto);
  }

  /** The order's quote again: E3 reopened, or a quote past its `expiresAt`. */
  @Get('orders/wallet/:orderId/quote')
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'payment_in_progress',
    'fees_not_set',
  )
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<EventWalletOrderQuoteView> {
    return this.orders.quote(wallet, orderId);
  }

  /**
   * One order as it stands now: what the app polls after `processing` (E10's
   * Refresh) and E5's tickets. Only the buyer reads it; another person's
   * order and an id nobody holds are the same `404 target_not_found`. It
   * reads our own records only and never asks the wallet provider.
   */
  @Get('orders/wallet/:orderId')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('target_not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<EventWalletOrderView> {
    return this.orders.read(user.sub, orderId);
  }
}
