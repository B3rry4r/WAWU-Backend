import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiConflictResponse } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type { AccountDeletionResponse } from '../common/types';
import { AccountService } from './account.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import {
  AccountDeletionBlockedBody,
  CancelDeletionResponseDto,
} from './dto/account-deletion.dto';

/** registry.json Account resource -- roles: ["any"] (any authenticated WAWU user). */
@Controller('account')
@UseGuards(WawuAuthGuard)
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  /**
   * Asks to delete the account (R-17: it waits 30 days). Refused with
   * `409 account_deletion_blocked` while the wallet holds money, a hold is
   * open or earnings are waiting (SETTINGS-06). `503 provider_unreachable`
   * when the wallet provider does not answer, so "empty" is never guessed.
   */
  @Delete()
  @ApiConflictResponse({
    description:
      'account_deletion_blocked: money to settle first (reason.blockers, reason.balanceKobo).',
    type: AccountDeletionBlockedBody,
  })
  async deleteAccount(
    @CurrentUser() user: WawuJwtClaims,
    @Body() _body: DeleteAccountDto,
  ): Promise<AccountDeletionResponse> {
    return this.accountService.deleteAccount(user.sub);
  }

  /**
   * Cancels a deletion that is waiting (SETTINGS-06): the wallet is
   * unfrozen, the content comes back and phone push resumes. WAWU ID calls
   * it with the person's new token when they sign in during the 30 days
   * (SETTINGS-08). Answers 200 `cancelled: false` when nothing was waiting,
   * and 200 `cancelled: false, deletionInProgress: true` with a `message`
   * once the purge has started (data may already be gone, so it is never
   * answered as restored).
   */
  @Post('cancel-deletion')
  @HttpCode(200)
  async cancelDeletion(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<CancelDeletionResponseDto> {
    return this.accountService.cancelDeletion(user.sub);
  }
}
