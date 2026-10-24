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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../money/gate/wallet-gate';
import {
  BuiltBy,
  DEBIT_GATE_ERRORS,
  IdempotencyKeyHeader,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../money/money-contract';
import { MoneyError } from '../money/money-error';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../money/payments/idempotency';
import { CapitalConfirmGuard, CapitalWithdrawGuard } from './capital-guards';
import {
  CapitalOrdersQueryDto,
  CapitalProductsQueryDto,
  CapitalReserveDto,
  CapitalTransactionsQueryDto,
} from './capital.dto';
import {
  CapitalService,
  CONFIRM_ROUTE,
  WITHDRAW_ROUTE,
} from './capital.service';
import type {
  CapitalOrderPageView,
  CapitalOrderView,
  CapitalPortfolioView,
  CapitalProductDetailView,
  CapitalProductPageView,
  CapitalTransactionPageView,
  CapitalWithdrawalPreviewView,
} from './capital-view.type';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

/** Whether the Wallet tab shows its Capital row. */
export interface CapitalAvailabilityView {
  /** Capital is on and served: new orders can be made. */
  available: boolean;
  /** The person holds an order that is not over: they keep the way in to read it and take it out, even when `available` is false. */
  holding: boolean;
}

/**
 * Capital (task NUV-12, R-84): the provider's fixed-return and share-offering
 * products, from the wallet. Browse, reserve for a few minutes, confirm with
 * the PIN, then the portfolio, the order history, the holding's own
 * transactions and a withdrawal. Naira only. Every figure is the provider's;
 * a rate or a payout is shown as the provider states it, never promised.
 * Nothing here is a balance (the wallet's balance is its own route).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('capital')
export class CapitalController {
  constructor(private readonly capital: CapitalService) {}

  /**
   * Whether Capital is on (the admin's plan setting) and the running wallet
   * provider serves it: `available`, when new orders can be made. `holding`
   * says the person holds an order that is not over: switching Capital off
   * closes new orders only, so the Wallet tab keeps its row for a person who
   * holds something, and the portfolio, the orders, their movements and a
   * withdrawal keep answering. Needs no wallet and moves no money.
   */
  @Get('availability')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-12')
  async availability(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<CapitalAvailabilityView> {
    return {
      available: this.capital.available(),
      holding: await this.capital.holdsAny(user.sub),
    };
  }

  /** The products the provider offers this person in naira, with their terms. */
  @Get('products')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-12')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'capital_unavailable',
    'provider_unreachable',
  )
  products(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: CapitalProductsQueryDto,
  ): Promise<CapitalProductPageView> {
    return this.capital.products(wallet, query);
  }

  /** One product with its documents (every one is agreed to when ordering) and WAWU's limits and fee. */
  @Get('products/:productId')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-12')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'capital_unavailable',
    'target_not_found',
    'provider_unreachable',
  )
  product(
    @CurrentWallet() wallet: OpenWallet,
    @Param('productId') productId: string,
  ): Promise<CapitalProductDetailView> {
    return this.capital.product(wallet, productId);
  }

  /** What the person has invested, and the return so far, as the provider totals it. */
  @Get('portfolio')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-12')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'capital_unavailable',
    'provider_unreachable',
  )
  portfolio(
    @CurrentWallet() wallet: OpenWallet,
  ): Promise<CapitalPortfolioView> {
    return this.capital.portfolio(wallet);
  }

  /** The person's orders, newest first; `show=holding` or `show=ended` narrows them. */
  @Get('orders')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-12')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'capital_unavailable')
  orders(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: CapitalOrdersQueryDto,
  ): Promise<CapitalOrderPageView> {
    return this.capital.orders(wallet, query);
  }

  /**
   * Reserves a product for the person for a few minutes at the provider's
   * quote. NO money moves and no PIN is asked. The `Idempotency-Key` makes a
   * double tap reserve once: the same key and body answer the same order;
   * another body is `409 idempotency_key_reused`. The body must say the
   * person opened and agreed to the product's documents. Answers 201.
   */
  @Post('orders')
  @HttpCode(201)
  @BuiltBy('NUV-12')
  @RequireOpenWallet()
  @IdempotencyKeyHeader()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'capital_unavailable',
    'idempotency_key_required',
    'idempotency_key_reused',
    'idempotency_in_progress',
    'target_not_found',
    'target_not_payable',
    'amount_out_of_range',
    'insufficient_funds',
    'limit_reached',
    'provider_unreachable',
  )
  reserve(
    @CurrentWallet() wallet: OpenWallet,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CapitalReserveDto,
  ): Promise<CapitalOrderView> {
    if (typeof key !== 'string' || !KEY_FORMAT.test(key)) {
      throw new MoneyError(
        'idempotency_key_required',
        'This needs an Idempotency-Key: 8 to 128 letters, digits, - or _.',
      );
    }
    return this.capital.reserve(wallet, dto, key);
  }

  /**
   * Confirms a reservation: the one step that takes the money. Before the
   * PIN, and with no PIN try used: an order that is not the caller's, one that
   * ran out (`409 reservation_expired`), one an admin holds (`409
   * capital_unavailable`), the daily limit and a short balance (`402
   * insufficient_funds`). The same Idempotency-Key answers the first result
   * again without asking the PIN. Answers 201 with the order: `invested`, or
   * `confirming` when the provider has not finished (read it again; it is
   * never charged twice).
   */
  @Post('orders/:id/confirm')
  @HttpCode(201)
  @BuiltBy('NUV-12')
  @RequireIdempotentApproval(CONFIRM_ROUTE, CapitalConfirmGuard)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'capital_unavailable',
    'reservation_expired',
    'not_found',
  )
  confirm(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CapitalOrderView> {
    return this.capital.confirm(wallet, id, scope);
  }

  /** One order as it stands, the holding read from the provider now. */
  @Get('orders/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-12')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'capital_unavailable', 'not_found')
  order(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CapitalOrderView> {
    return this.capital.order(wallet, id);
  }

  /** The holding's own movements: the purchase, each day's interest, the payout. */
  @Get('orders/:id/transactions')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-12')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'capital_unavailable', 'not_found')
  transactions(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CapitalTransactionsQueryDto,
  ): Promise<CapitalTransactionPageView> {
    return this.capital.transactions(wallet, id, query);
  }

  /**
   * What leaving now would pay, as the provider works it out (read only, no
   * side effects): the interest so far, the penalty on an early exit, the
   * deductions and the net payout. `409 withdrawal_not_available` when the
   * provider has nothing to preview.
   */
  @Get('orders/:id/withdrawal')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-12')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'capital_unavailable',
    'withdrawal_not_available',
    'not_found',
  )
  preview(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CapitalWithdrawalPreviewView> {
    return this.capital.preview(wallet, id);
  }

  /**
   * Starts the payout of a fixed-return holding: the early exit (the penalty
   * on interest the preview showed) or, once matured, the full payout; the
   * provider picks from its own state. Asks the PIN. Before it, with no try
   * used: a holding that cannot be withdrawn (`409 withdrawal_not_available`)
   * or that an admin holds (`409 capital_unavailable`). Answers 201 with the
   * order, `paying_out` until the provider settles it.
   */
  @Post('orders/:id/withdrawal')
  @HttpCode(201)
  @BuiltBy('NUV-12')
  @RequireIdempotentApproval(WITHDRAW_ROUTE, CapitalWithdrawGuard)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'capital_unavailable',
    'withdrawal_not_available',
    'not_found',
  )
  withdraw(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CapitalOrderView> {
    return this.capital.withdraw(wallet, id, scope);
  }
}
