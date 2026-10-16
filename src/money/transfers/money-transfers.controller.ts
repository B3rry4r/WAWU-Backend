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
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { WawuTransferDto } from '../dto/money-request.dto';
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
import type { TransferView } from '../money-view.type';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../payments/idempotency';
import { TransferRecipientGuard } from './transfer-recipient';
import {
  TRANSFER_ROUTE,
  WalletTransferService,
} from './wallet-transfer.service';

/**
 * Sending money to another WAWU user (task WALLET-07; finding one is
 * WALLET-08, src/money/recipients/). Declared by MONEY-04, served here
 * (docs/contract/CONVENTIONS.md sections 0 and 19). Sending to a bank
 * account (WALLET-09) is still declared in money-transfer.controller.ts.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyTransfersController {
  constructor(private readonly transfers: WalletTransferService) {}

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
