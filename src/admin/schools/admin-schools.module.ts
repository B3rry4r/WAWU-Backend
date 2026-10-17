import { Module } from '@nestjs/common';
import { SchoolAdminService } from '../../schools/school-admin.service';
import { SchoolSettlementModule } from '../../schools/settlement/school-settlement.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminSchoolsController } from './admin-schools.controller';

@Module({
  imports: [AdminAuthModule, SchoolSettlementModule],
  controllers: [AdminSchoolsController],
  providers: [SchoolAdminService],
})
export class AdminSchoolsModule {}
