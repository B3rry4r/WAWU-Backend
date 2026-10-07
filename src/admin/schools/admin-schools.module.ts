import { Module } from '@nestjs/common';
import { SchoolAdminService } from '../../schools/school-admin.service';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminSchoolsController } from './admin-schools.controller';

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminSchoolsController],
  providers: [SchoolAdminService],
})
export class AdminSchoolsModule {}
