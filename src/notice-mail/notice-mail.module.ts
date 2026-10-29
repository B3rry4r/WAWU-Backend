import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { NoticeFacts } from './notice-facts';
import { NoticeMailer } from './notice-mailer';

/** The mailer for money and account notices (EMAIL-02). Import it where a notice is raised. */
@Module({
  imports: [ConfigModule, PlanSettingsModule, WawuAuthModule],
  providers: [NoticeMailer, NoticeFacts],
  exports: [NoticeMailer, NoticeFacts],
})
export class NoticeMailModule {}
