import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AdminOpsAuditService } from '../common/audit/admin-ops-audit.service';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import {
  isSuspended,
  SUSPENDED_MESSAGE,
  SUSPENDED_SUPPORT_EMAIL,
  type SuspensionReason,
} from '../common/suspension/user-suspension';
import { UGC_REASON_LABELS } from '../ugc-report/ugc-report.kinds';
import type { LiftSuspensionDto, SuspendUserDto } from './dto/suspend-user.dto';

/** One suspension, as a moderator reads it. */
export interface SuspensionEntryView {
  id: string;
  reason: SuspensionReason;
  reasonLabel: string;
  note: string | null;
  reportId: string | null;
  suspendedAt: Date;
  suspendedBy: { email: string; role: string };
  liftedAt: Date | null;
  liftNote: string | null;
  liftedBy: { email: string; role: string } | null;
}

/** `GET /admin/users/:id/suspension`, and what suspend and lift answer. */
export interface AdminSuspensionView {
  wawuId: string;
  handle: string | null;
  suspended: boolean;
  /** The suspension in force, or null. */
  current: SuspensionEntryView | null;
  /** Every suspension of this person, newest first (the one in force included). */
  history: SuspensionEntryView[];
}

/** `GET /me/suspension`: what the signed-in person is told. Never the moderator, the note or the reason. */
export interface MySuspensionView {
  suspended: boolean;
  since: Date | null;
  /** The sentence the app shows. Empty when not suspended. */
  message: string;
  supportEmail: string;
}

const entry = (
  r: Awaited<ReturnType<PrismaService['userSuspension']['findFirstOrThrow']>>,
): SuspensionEntryView => ({
  id: r.id,
  reason: r.reason as SuspensionReason,
  reasonLabel: UGC_REASON_LABELS[r.reason as SuspensionReason] ?? r.reason,
  note: r.note,
  reportId: r.reportId,
  suspendedAt: r.suspendedAt,
  suspendedBy: { email: r.suspendedByAdminEmail, role: r.suspendedByAdminRole },
  liftedAt: r.liftedAt,
  liftNote: r.liftNote,
  liftedBy:
    r.liftedAt && r.liftedByAdminEmail && r.liftedByAdminRole
      ? { email: r.liftedByAdminEmail, role: r.liftedByAdminRole }
      : null,
});

const clean = (text: string | undefined): string | null =>
  text?.trim() ? text.trim() : null;

/**
 * USER-SUSPEND (R-121). A moderator suspends a person and lifts it. What a suspension DOES lives in
 * `src/common/suspension` and `BlockedAccountService`; this is the act, its record and its audit rows.
 *
 * Both acts are safe to repeat: suspending a person already suspended, or lifting one who is not, changes nothing, writes
 * no second audit row and answers the state as it is (two moderators on one report is normal).
 */
@Injectable()
export class UserSuspensionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminOpsAuditService,
  ) {}

  async suspend(
    wawuId: string,
    dto: Pick<SuspendUserDto, 'reason' | 'note' | 'reportId'>,
    admin: AdminUserView,
  ): Promise<AdminSuspensionView> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: wawuId },
      select: { wawuUserId: true },
    });
    if (!profile) throw new NotFoundException('Person not found.');

    const inForce = await this.prisma.userSuspension.findFirst({
      where: { wawuUserId: wawuId, liftedAt: null },
      select: { id: true },
    });
    if (!inForce) {
      const note = clean(dto.note);
      let created: { id: string } | null = null;
      try {
        created = await this.prisma.userSuspension.create({
          data: {
            wawuUserId: wawuId,
            reason: dto.reason,
            note,
            reportId: dto.reportId ?? null,
            suspendedByAdminId: admin.id,
            suspendedByAdminEmail: admin.email,
            suspendedByAdminRole: admin.role,
          },
          select: { id: true },
        });
      } catch (e) {
        // The partial unique index: another moderator suspended them between the read and the write. Same outcome.
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }
      if (created) {
        await this.audit.record(admin, {
          resource: 'user_suspension',
          resourceId: created.id,
          subjectWawuId: wawuId,
          action: 'user_suspended',
          detail: { reason: dto.reason, note, reportId: dto.reportId ?? null },
        });
      }
    }
    return this.view(wawuId);
  }

  async lift(
    wawuId: string,
    dto: LiftSuspensionDto,
    admin: AdminUserView,
  ): Promise<AdminSuspensionView> {
    const note = clean(dto.note);
    const row = await this.prisma.userSuspension.findFirst({
      where: { wawuUserId: wawuId, liftedAt: null },
      select: { id: true },
    });
    if (row) {
      const done = await this.prisma.userSuspension.updateMany({
        where: { id: row.id, liftedAt: null },
        data: {
          liftedAt: new Date(),
          liftNote: note,
          liftedByAdminId: admin.id,
          liftedByAdminEmail: admin.email,
          liftedByAdminRole: admin.role,
        },
      });
      if (done.count === 1) {
        await this.audit.record(admin, {
          resource: 'user_suspension',
          resourceId: row.id,
          subjectWawuId: wawuId,
          action: 'user_suspension_lifted',
          detail: { note },
        });
      }
    }
    return this.view(wawuId);
  }

  async view(wawuId: string): Promise<AdminSuspensionView> {
    const [profile, rows] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: wawuId },
        select: { handle: true },
      }),
      this.prisma.userSuspension.findMany({
        where: { wawuUserId: wawuId },
        orderBy: { suspendedAt: 'desc' },
      }),
    ]);
    if (!profile && rows.length === 0) {
      throw new NotFoundException('Person not found.');
    }
    const history = rows.map(entry);
    const current = history.find((h) => h.liftedAt === null) ?? null;
    return {
      wawuId,
      handle: profile?.handle ?? null,
      suspended: current !== null,
      current,
      history,
    };
  }

  isSuspended(wawuId: string): Promise<boolean> {
    return isSuspended(this.prisma, wawuId);
  }

  /** What the signed-in person is told about themselves. */
  async mine(wawuId: string): Promise<MySuspensionView> {
    const row = await this.prisma.userSuspension.findFirst({
      where: { wawuUserId: wawuId, liftedAt: null },
      select: { suspendedAt: true },
    });
    return {
      suspended: row !== null,
      since: row?.suspendedAt ?? null,
      message: row ? SUSPENDED_MESSAGE : '',
      supportEmail: SUSPENDED_SUPPORT_EMAIL,
    };
  }
}
