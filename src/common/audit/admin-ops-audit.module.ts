import { Module } from '@nestjs/common';
import { AdminOpsAuditService } from './admin-ops-audit.service';

/**
 * Shared by the four operator resource modules that write consequential,
 * previously-anonymous state — LegalModule, ServiceApplicationModule,
 * BillPaymentModule and HealthPlanModule.
 *
 * A module rather than a provider listed four times so there is one
 * AdminOpsAuditService instance and one place the audit contract lives.
 * PrismaService arrives from the global PrismaModule, same as every resource
 * module. Nothing app-facing imports this.
 */
@Module({
  providers: [AdminOpsAuditService],
  exports: [AdminOpsAuditService],
})
export class AdminOpsAuditModule {}
