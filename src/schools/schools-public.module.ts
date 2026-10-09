import { Module } from '@nestjs/common';
import { SchoolsPublicController } from './schools-public.controller';
import { SchoolsPublicService } from './schools-public.service';

/**
 * Mounted by SearchResponseModule (which also needs the service for the
 * `schools` search tab), so `src/app.module.ts` is untouched.
 */
@Module({
  controllers: [SchoolsPublicController],
  providers: [SchoolsPublicService],
  exports: [SchoolsPublicService],
})
export class SchoolsPublicModule {}
