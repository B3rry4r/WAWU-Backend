import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AdminOpsAction,
  AdminOpsResource,
  AdminRole,
} from '../../../generated/prisma/enums';

/**
 * The acting admin, in the only three fields an audit row needs.
 *
 * Declared structurally rather than as `AdminUserView` so nothing under
 * src/common/ depends on a type in src/admin/. `AdminUserView` satisfies it,
 * so controllers pass `@CurrentAdmin()` straight through with no adapter.
 */
export interface AdminActor {
  id: string;
  email: string;
  role: AdminRole;
}

/** One audited write, in the words of the handler that performed it. */
export interface AdminOpsAuditEntry {
  resource: AdminOpsResource;
  resourceId: string;
  /** Whose money or matter this touched. */
  subjectWawuId: string;
  action: AdminOpsAction;
  /** What changed — the quote amount, the refund reference, the new status. */
  detail?: Record<string, unknown>;
}

/**
 * Attribution for the operator surfaces that moved off AdminKeyGuard.
 *
 * Those six controllers sat behind a single shared static secret
 * (`WAWU_ADMIN_KEY`) with no identity attached, so pricing a legal matter,
 * cancelling fully-paid work and recording a refund were all anonymous. The
 * guards now say WHO may do a thing; this says WHO DID.
 *
 * ── WHY THE WRITE NEVER THROWS ────────────────────────────────────────────
 * The audit row is written AFTER the state transition it records, outside the
 * transaction, and a failure is logged rather than raised. That ordering is
 * deliberate: `recordRefund` is the bookkeeping entry for money a human has
 * already sent, and `retryEnrolment` has already called WellaHealth. Failing
 * the request because the audit insert failed would tell the operator the
 * action did not happen when it did — and they would do it again. A missing
 * audit row is a gap in a record; a repeated refund is a second payment.
 *
 * Only WRITES are audited. The queue reads (`GET /legal/ops/requests`,
 * `GET /bills/ops/stuck`, `GET /care/ops/subscriptions/stuck`) are not: they
 * disclose no identity document and no bank detail, so they are not the kind
 * of read AdminKycAudit exists for.
 */
@Injectable()
export class AdminOpsAuditService {
  private readonly logger = new Logger(AdminOpsAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(actor: AdminActor, entry: AdminOpsAuditEntry): Promise<void> {
    try {
      await this.prisma.adminOpsAudit.create({
        data: {
          resource: entry.resource,
          resourceId: entry.resourceId,
          subjectWawuId: entry.subjectWawuId,
          action: entry.action,
          detail: (entry.detail ?? null) as never,
          // Snapshots, not references: "who cancelled this" must stay
          // answerable after the admin is renamed, suspended or deleted.
          actedByAdminId: actor.id,
          actedByAdminEmail: actor.email,
          actedByAdminRole: actor.role,
        },
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `Failed to record ${entry.action} on ${entry.resource} ${entry.resourceId} by ${actor.email}: ${reason}`,
      );
    }
  }
}
