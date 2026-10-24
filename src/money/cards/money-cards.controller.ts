import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { RequireFeesSet } from '../fees/fees-set.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import {
  BuiltBy,
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../money-contract';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../payments/idempotency';
import { RequireApproval } from '../pin/transaction-pin.guard';
import { CardCreatableGuard } from './card-creatable.guard';
import { CardTransactionsQueryDto, CreateCardDto } from './card-request.dto';
import type {
  CardDetailsView,
  CardListView,
  CardQuoteView,
  CardTransactionPage,
  CardView,
} from './card-view.type';
import { CARD_CREATE_ROUTE, WalletCardService } from './wallet-card.service';

/**
 * The WAWU card (task WALLET-31; R-84; boards W29, W31, W32): virtual and
 * single-use dollar cards Nuvion issues, funded from the person's own
 * account. There is no physical card (Nuvion has none) and no card PIN,
 * channel switches or spending limits (Nuvion serves none: gap rows).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money/cards')
export class MoneyCardsController {
  constructor(private readonly cards: WalletCardService) {}

  /**
   * What a card costs and whether the person may ask for one now (W29):
   * Nuvion's fee plus WAWU's (R-10), both from settings, the limits and how
   * many the person holds. `enabled: false` means the product is switched off.
   */
  @Get('quote')
  @BuiltBy('WALLET-31')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'fees_not_set')
  @RequireFeesSet()
  quote(@CurrentWallet() wallet: OpenWallet): Promise<CardQuoteView> {
    return this.cards.quote(wallet);
  }

  /** The person's cards, newest first (W29's list, W31). Failed requests are not listed. */
  @Get()
  @BuiltBy('WALLET-31')
  @RequireOpenWallet()
  @Header('Cache-Control', 'no-store')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  list(@CurrentWallet() wallet: OpenWallet): Promise<CardListView> {
    return this.cards.list(wallet);
  }

  /**
   * Gets a card (W29): Nuvion makes it and takes its fee from the person's
   * wallet. Answers 201 with the card: `active`, or `pending` when the issuer
   * has not confirmed it (it is looked for by its reference, never made
   * twice). The card number, expiry and CVV are not in the answer: they are
   * shown behind the PIN (`POST /money/cards/{id}/reveal`). The same
   * Idempotency-Key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN. Cards switched
   * off, a limit, and `fees_not_set` come before the PIN is looked at.
   */
  @Post()
  @HttpCode(201)
  @BuiltBy('WALLET-31')
  @RequireIdempotentApproval(CARD_CREATE_ROUTE, CardCreatableGuard)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'cards_unavailable',
    'card_limit_reached',
  )
  @RequireFeesSet()
  create(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: CreateCardDto,
  ): Promise<CardView> {
    return this.cards.create(wallet, dto, scope);
  }

  /** One card as it stands now (a card still being confirmed is looked for). */
  @Get(':id')
  @BuiltBy('WALLET-31')
  @RequireOpenWallet()
  @Header('Cache-Control', 'no-store')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found', 'cards_unavailable')
  get(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CardView> {
    return this.cards.get(wallet, id);
  }

  /**
   * The card's number, expiry and CVV (W31 "Details"), read from Nuvion now,
   * behind the PIN or a fingerprint approval every time. WAWU never stores
   * them and the answer is not cacheable. A POST so no cache or log keeps the
   * URL with an answer.
   */
  @Post(':id/reveal')
  @HttpCode(200)
  @BuiltBy('WALLET-31')
  @RequireApproval()
  @Header('Cache-Control', 'no-store')
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_required',
    'pin_not_set',
    'pin_incorrect',
    'pin_locked',
    'device_approval_refused',
    'not_found',
    'card_blocked',
    'cards_unavailable',
    'provider_unreachable',
  )
  reveal(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CardDetailsView> {
    return this.cards.reveal(wallet, id);
  }

  /** Freezes the card (W31 "Freeze"): no payment goes through until it is unfrozen. Needs no PIN, so a lost card is stopped at once. Safe to repeat. */
  @Post(':id/freeze')
  @HttpCode(200)
  @BuiltBy('WALLET-31')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'not_found',
    'card_blocked',
    'cards_unavailable',
    'provider_unreachable',
  )
  freeze(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CardView> {
    return this.cards.freeze(wallet, id);
  }

  /** Unfreezes the card (W32), behind the PIN or a fingerprint. A card support froze answers `card_blocked`. */
  @Post(':id/unfreeze')
  @HttpCode(200)
  @BuiltBy('WALLET-31')
  @RequireApproval()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_required',
    'pin_not_set',
    'pin_incorrect',
    'pin_locked',
    'device_approval_refused',
    'not_found',
    'card_blocked',
    'cards_unavailable',
    'provider_unreachable',
  )
  unfreeze(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CardView> {
    return this.cards.unfreeze(wallet, id);
  }

  /**
   * Blocks the card for good (W32 "Block card"; Nuvion deletes it): it cannot
   * be used or brought back. Needs no PIN. Safe to repeat.
   */
  @Delete(':id')
  @HttpCode(200)
  @BuiltBy('WALLET-31')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'not_found',
    'cards_unavailable',
    'provider_unreachable',
  )
  block(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CardView> {
    return this.cards.block(wallet, id);
  }

  /** Payments, reversals and refunds on the card, newest first, a cursor page. A blocked card has none to show. */
  @Get(':id/transactions')
  @BuiltBy('WALLET-31')
  @RequireOpenWallet()
  @Header('Cache-Control', 'no-store')
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'not_found',
    'cards_unavailable',
    'provider_unreachable',
  )
  transactions(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CardTransactionsQueryDto,
  ): Promise<CardTransactionPage> {
    return this.cards.transactions(wallet, id, query);
  }
}
