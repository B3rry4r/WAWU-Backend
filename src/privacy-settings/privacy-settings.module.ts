import { Module } from '@nestjs/common';
import { PrivacySettingsController } from './privacy-settings.controller';
import { PrivacySettingsService } from './privacy-settings.service';

@Module({
  controllers: [PrivacySettingsController],
  providers: [PrivacySettingsService],
})
export class PrivacySettingsModule {}
