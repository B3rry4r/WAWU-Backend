import { Global, Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { VerificationReminderService } from './verification-reminder.service';

/**
 * registry.json § Notification. PrismaModule is @Global() (see
 * common/prisma/prisma.module.ts) so PrismaService needs no explicit import
 * here.
 *
 * @Global() + `exports` was added when NotificationService gained `emit()` —
 * the single write path into the Notification table. Every module that can
 * observe a notifiable event (payments, DMs, follows, the cron sweeps) needs
 * the emitter, and making it global means wiring a new event costs exactly
 * one constructor parameter and one call, with no imports-array edit in the
 * module doing the emitting. It also means an admin-review endpoint on
 * another branch can inject it with no changes to this file at all.
 *
 * Modules that emit still list NotificationModule in their own `imports`
 * anyway: a @Global() provider is only visible once the module is somewhere
 * in the graph, and the per-resource contract specs each build a testing
 * module from just their own resource's module.
 */
@Global()
@Module({
  controllers: [NotificationController],
  providers: [NotificationService, VerificationReminderService],
  exports: [NotificationService, VerificationReminderService],
})
export class NotificationModule {}
