import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { TgifController } from './tgif.controller';
import { TgifService } from './tgif.service';

/** TGIF reactions, readers and shares (HOME-10). */
@Module({
  imports: [WawuAuthModule, BlockedAccountModule],
  controllers: [TgifController],
  providers: [TgifService],
})
export class TgifModule {}
