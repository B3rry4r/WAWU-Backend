import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { TgifController } from './tgif.controller';
import { TgifService } from './tgif.service';
import { TgifContentService } from './content/tgif-content.service';
import { ShareImageService } from './share/share-image.service';

/** TGIF reactions, readers and shares (HOME-10), the text of each day and the shared card (HOME-09). */
@Module({
  imports: [WawuAuthModule, BlockedAccountModule],
  controllers: [TgifController],
  providers: [TgifService, TgifContentService, ShareImageService],
})
export class TgifModule {}
