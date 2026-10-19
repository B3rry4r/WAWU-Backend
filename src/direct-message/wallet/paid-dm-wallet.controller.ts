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
import { AskPaidQuestionDto, PayPaidQuestionDto } from './paid-dm-wallet.dto';
import { PAID_DM_PAY_ROUTE } from './paid-dm-wallet-rules';
import { PaidDmWalletService } from './paid-dm-wallet.service';
import type {
  PaidQuestionQuoteView,
  PaidQuestionWalletView,
} from './paid-dm-wallet-view.type';

/**
 * Ask a creator a paid question from the wallet (task INBOX-17, I3 to I5).
 * The web's Flutterwave routes (`POST dm/:creatorWawuId/send` and `POST
 * dm/:messageId/send/verify`) are untouched; every path here is a literal
 * under `send/wallet` that they do not declare, and none can be taken for the
 * web's `GET dm/:messageId`. `send/wallet/pay` comes before the id routes.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('dm')
export class PaidDmWalletController {
  constructor(private readonly questions: PaidDmWalletService) {}

  /**
   * Drafts the question and answers I3: the question priced by the server
   * (the creator's own price and reply window) and the wallet payment's quote
   * (the price, the provider's charge on top, the total, the balance and any
   * shortfall). Nothing is reserved and nothing is debited. A creator who has
   * not switched paid messages on, one who is paused, a block between the two
   * and the fan's own account are `409 target_not_payable`; a question to this
   * creator still waiting is `409 question_already_waiting`. With an
   * `Idempotency-Key`, the same key and question answer the same draft.
   */
  @Post(':creatorWawuId/send/wallet')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet()
  @ApiOperation({ operationId: 'askPaidQuestionFromWallet' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. One value per tap on Send (a UUID); sent again unchanged on a retry, it answers the same draft. The same key with another question is 409 idempotency_key_reused, and a malformed key is 400 idempotency_key_required.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  })
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'question_already_waiting',
    'fees_not_set',
  )
  @RequireFeesSet()
  ask(
    @CurrentWallet() wallet: OpenWallet,
    @Param('creatorWawuId', ParseUUIDPipe) creatorWawuId: string,
    @Body() dto: AskPaidQuestionDto,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<PaidQuestionQuoteView> {
    return this.questions.ask(wallet, creatorWawuId, dto, key);
  }

  /**
   * Pays the question from the wallet, once: the price moves into WAWU's own
   * account and waits there until the creator answers (R-19), with the
   * provider's charge on top (R-10). Answers 201 with the question: `pending`
   * while the payment is not confirmed or the question is being sent (poll
   * `GET /dm/send/wallet/{id}`; never pay again), `asked` once it is with the
   * creator, `failed` when the provider refused it and nothing moved. The same
   * Idempotency-Key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN.
   */
  @Post('send/wallet/pay')
  @HttpCode(201)
  @RequireIdempotentApproval(PAID_DM_PAY_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'target_not_found',
    'target_not_payable',
    'payment_in_progress',
    'question_already_waiting',
  )
  @RequireFeesSet()
  pay(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: PayPaidQuestionDto,
  ): Promise<PaidQuestionWalletView> {
    return this.questions.pay(wallet, scope, dto);
  }

  /** The pay sheet again: I3 reopened, or a quote past its `expiresAt`. */
  @Get('send/wallet/:questionId/quote')
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'question_already_waiting',
    'payment_in_progress',
    'fees_not_set',
  )
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Param('questionId', ParseUUIDPipe) questionId: string,
  ): Promise<PaidQuestionQuoteView> {
    return this.questions.quote(wallet, questionId);
  }

  /**
   * One question as it stands now: what the app polls after `pending` (I4).
   * Only the asker reads it; another person's question and an id nobody holds
   * are the same `404 target_not_found`. It reads our own records only and
   * never asks the wallet provider.
   */
  @Get('send/wallet/:questionId')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('target_not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('questionId', ParseUUIDPipe) questionId: string,
  ): Promise<PaidQuestionWalletView> {
    return this.questions.read(user.sub, questionId);
  }
}
