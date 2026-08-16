import { Body, Controller, Delete, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type { AccountDeletionResponse } from '../common/types';
import { AccountService } from './account.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

/** registry.json Account resource -- roles: ["any"] (any authenticated WAWU user). */
@Controller('account')
@UseGuards(WawuAuthGuard)
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Delete()
  async deleteAccount(
    @CurrentUser() user: WawuJwtClaims,
    @Body() _body: DeleteAccountDto,
  ): Promise<AccountDeletionResponse> {
    return this.accountService.deleteAccount(user.sub);
  }
}
