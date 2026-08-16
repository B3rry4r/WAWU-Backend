import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

/**
 * registry.json § Notification. PrismaModule is @Global() (see
 * common/prisma/prisma.module.ts) so PrismaService needs no explicit import
 * here. Register in AppModule per the SEAM comment there — the dispatcher
 * applies that centrally, this module does not self-register.
 */
@Module({
  controllers: [NotificationController],
  providers: [NotificationService],
})
export class NotificationModule {}
