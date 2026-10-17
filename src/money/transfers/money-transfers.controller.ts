import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { BankTransferDto, WawuTransferDto } from '../dto/money-request.dto';
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
import type { TransferPresetsView, TransferView } from '../money-view.type';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../payments/idempotency';
import {
  BankSendTargetGuard,
  CurrentBankTarget,
  type ResolvedBankTarget,
} from './bank-send-target';
import { TransferRecipientGuard } from './transfer-recipient';
import {
  readTransferPresets,
  TRANSFER_NOTE_MAX_LENGTH,
} from './transfer-presets';
import {
  BANK_TRANSFER_ROUTE,
  TRANSFER_ROUTE,
  WalletTransferService,
} from './wallet-transfer.service';

/**
 * Sending money to another WAWU user (task WALLET-07; finding one is
 * WALLET-08, src/money/recipients/) and to a bank account (task WALLET-09),
 * and reading one send of either kind. Declared by MONEY-04, served here
 * (docs/contract/CONVENTIONS.md sections 0, 19 and 22).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyTransfersController {
  /** Read once when the app starts: a setting that is set and wrong stops it there. */
  private readonly quickAmountsKobo: number[];

  constructor(
    private readonly transfers: WalletTransferService,
    config: ConfigService,
  ) {
    this.quickAmountsKobo = readTransferPresets(config);
  }

  /**
   * Send to a WAWU user (W10 to W12): one wallet-to-wallet transfer from the
   * sender's wallet to the receiver's. The sender's balance falls by the
   * quoted total (the amount, the provider's charge and WAWU's fee on top,
   * R-10); the receiver's rises by exactly the amount. Answers 201 with the
   * send: completed, pending when the provider has not confirmed it yet (it
   * is never sent again blindly; poll `GET /money/transfers/{id}`), or failed
   * when the provider refused it and nothing moved. The same Idempotency-Key
   * and body answer the first result again (`Idempotent-Replayed: true`)
   * without checking the PIN. Who the money goes to (yourself, a closed
   * account, a block, no wallet) is answered before the PIN is looked at.
   * fees_not_set comes before the wallet gate, the key and the PIN;
   * limit_reached (WAWU's limit or the provider's) before anything is sent.
   */
  @Post('transfers/wawu')
  @HttpCode(201)
  @BuiltBy('WALLET-07')
  @RequireIdempotentApproval(TRANSFER_ROUTE, TransferRecipientGuard)
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
  sendToWawuUser(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: WawuTransferDto,
  ): Promise<TransferView> {
    return this.transfers.send(wallet, dto, scope);
  }

  /**
   * Send to a bank account (W8 to W14), or withdraw to the payout account
   * (W17 to W19, which is a bank send to it). Answers 201 with the send:
   * `pending` until the bank's answer arrives (a delivery, or the sweep that
   * asks the provider by our reference), `completed`, or `failed`; the app
   * reads it from `GET /money/transfers/{id}`. The account is name-checked
   * with the bank again BEFORE the PIN is looked at and the send goes to the
   * name the bank gives: the app never sends a name. A saved account whose
   * holder or bank is no longer the one kept is `409 account_name_changed`,
   * carrying both names as they stand now; nothing is sent until the person
   * confirms them by saving the account again. The same Idempotency-Key and
   * body answer the first result again (`Idempotent-Replayed: true`) without
   * checking the PIN. fees_not_set comes before the wallet gate, the key and
   * the PIN; limit_reached (WAWU's limit or the provider's, WALLET-23) before
   * anything is sent.
   */
  @Post('transfers/bank')
  @HttpCode(201)
  @BuiltBy('WALLET-09')
  @RequireIdempotentApproval(BANK_TRANSFER_ROUTE, BankSendTargetGuard)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'name_check_failed',
    'account_name_changed',
    'self_transfer',
  )
  @RequireFeesSet()
  sendToBank(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @CurrentBankTarget() target: ResolvedBankTarget,
    @Body() dto: BankTransferDto,
  ): Promise<TransferView> {
    return this.transfers.sendToBank(wallet, dto, scope, target);
  }

  /**
   * What W9 draws that is not the person's own: the quick amounts under the
   * keypad (settings, documented in transfer-presets.ts) and the note's
   * longest length. It reads settings only: no provider, no fee, no money
   * moves. It sits above the read of one send so the word presets is not
   * taken for an id.
   */
  @Get('transfers/presets')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-02')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  presets(): TransferPresetsView {
    return {
      quickAmounts: this.quickAmountsKobo.map((amountKobo) => ({ amountKobo })),
      noteMaxLength: TRANSFER_NOTE_MAX_LENGTH,
    };
  }

  /**
   * One send as it stands now (W12 receipt, W14 failed): what the app polls
   * after `pending`. Only the sender reads it: another person's send is the
   * same `404 not_found` as one nobody holds. It reads our record only,
   * never the provider, and moves nothing, so it is not behind the fee
   * settings, the key or the PIN.
   */
  @Get('transfers/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-07')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  transfer(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TransferView> {
    return this.transfers.read(wallet, id);
  }
}
