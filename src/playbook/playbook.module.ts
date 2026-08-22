import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { PlaybookController } from './playbook.controller';
import { PlaybookService } from './playbook.service';

/**
 * AdminAuthModule is imported for its two exported GUARDS only —
 * `PATCH /learn/playbook` moved off AdminKeyGuard onto AdminAuthGuard +
 * AdminRolesGuard (superadmin). No AdminOpsAuditModule here: Playbook already
 * carries an `updatedBy` column that has never had a writer, so attribution
 * needs no new table. Imported here rather than wired in app.module.ts so the
 * documented, load-bearing route-registration order in that file is untouched.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [PlaybookController],
  providers: [PlaybookService],
})
export class PlaybookModule {}
