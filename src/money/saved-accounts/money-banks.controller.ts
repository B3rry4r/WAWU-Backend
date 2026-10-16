import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { NameCheckDto } from '../dto/money-request.dto';
import { BuiltBy, MoneyErrors } from '../money-contract';
import type { AccountNameView, BankView } from '../money-view.type';
import { BankAccountCheckService } from './bank-account-check.service';

/**
 * The bank list and the name check (task WALLET-09; W8, A21). Declared by
 * MONEY-04, served here. Neither reads a wallet or moves money: a person who
 * has not opened one can still choose the bank for a payout account. Both
 * ride on the provider seam (`listBanks`, `checkAccountName`) through
 * `BankAccountCheckService`, the same check the saved places and the send use.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyBanksController {
  constructor(private readonly banks: BankAccountCheckService) {}

  /**
   * The provider's bank list, in one unpaged array. Key on `code`: some names
   * repeat. Kept in memory for an hour (BANK_LIST_TTL_MS), so a person
   * opening the picker does not wait on the provider.
   */
  @Get('banks')
  @Header('Cache-Control', 'private, no-cache')
  @BuiltBy('WALLET-09')
  @MoneyErrors('provider_unreachable')
  async list(): Promise<BankView[]> {
    const byCode = await this.banks.bankList();
    return [...byCode.values()].map((b) => ({ code: b.code, name: b.name }));
  }

  /**
   * Whose account this is, from the bank (W8, A21). W8's Continue unlocks only
   * after this answers. The name is the bank's, never one the app sent.
   */
  @Post('banks/name-check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-09')
  @MoneyErrors('name_check_failed', 'provider_unreachable')
  nameCheck(@Body() dto: NameCheckDto): Promise<AccountNameView> {
    return this.banks.check(dto.bankCode, dto.accountNumber);
  }
}
