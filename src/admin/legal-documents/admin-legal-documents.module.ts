import { Module } from '@nestjs/common';
import { AboutModule } from '../../about/about.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminLegalDocumentsController } from './admin-legal-documents.controller';

@Module({
  imports: [AdminAuthModule, AboutModule],
  controllers: [AdminLegalDocumentsController],
})
export class AdminLegalDocumentsModule {}
