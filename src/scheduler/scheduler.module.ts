import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

/**
 * Time-based work for the whole API. Registered once in AppModule alongside
 * ScheduleModule.forRoot(); see SchedulerService for what each sweep does and
 * why the subscription one stops short of taking a renewal payment.
 */
@Module({ providers: [SchedulerService] })
export class SchedulerModule {}
