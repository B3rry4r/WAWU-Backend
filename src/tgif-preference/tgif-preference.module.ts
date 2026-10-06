import { Module } from '@nestjs/common';
import { TgifPreferenceController } from './tgif-preference.controller';
import { TgifPreferenceService } from './tgif-preference.service';

@Module({
  controllers: [TgifPreferenceController],
  providers: [TgifPreferenceService],
})
export class TgifPreferenceModule {}
