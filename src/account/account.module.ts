import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { WAWU_ID_ACCOUNT_GATEWAY } from './wawu-id-account.gateway';
import { WawuIdAccountClient } from './wawu-id-account.client';

@Module({
  controllers: [AccountController],
  providers: [AccountService, { provide: WAWU_ID_ACCOUNT_GATEWAY, useClass: WawuIdAccountClient }],
})
export class AccountModule {}
