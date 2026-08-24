import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { matterLabel } from './legal-intake-questions';
import type { LegalBrief } from './legal-brief';

/** One row in the consultant's queue. */
export interface IntakeQueueItem {
  id: string;
  wawuUserId: string;
  clientName: string;
  matter: string;
  matterLabel: string;
  status: string;
  /** The generated one-paragraph summary, so the queue is scannable. */
  summary: string;
  documentCount: number;
  completedAt: Date | null;
  /** How long this person has been waiting for somebody to pick it up. */
  waitingHours: number;
  /** Straight off the client's own urgency answer, not inferred. */
  urgency: string | null;
}

export interface IntakeDetailView {
  id: string;
  wawuUserId: string;
  clientName: string;
  matter: string;
  matterLabel: string;
  status: string;
  documents: string[];
  brief: LegalBrief | null;
  completedAt: Date | null;
  legalRequestId: string | null;
}

/**
 * Reading intakes, for the people who work them.
 *
 * Deliberately read-only. Everything a consultant DOES with a matter —
 * pricing it, scheduling, delivering — already lives on the legal-requests
 * ops surface with its own audit trail and its own narrower money roles.
 * Duplicating any of that here would put two writers on one lifecycle.
 */
@Injectable()
export class LegalIntakeOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  async queue(status?: string): Promise<IntakeQueueItem[]> {
    const rows = await this.prisma.legalIntake.findMany({
      // `in_progress` is excluded on purpose: a half-finished intake is
      // somebody still typing, not work waiting for a consultant, and putting
      // it in the queue would have people chasing clients mid-sentence.
      //
      // `converted` is the default rather than `completed`: completing an
      // intake opens its request in the same transaction, so a `completed`
      // row that never converted means that creation failed. Worth being able
      // to filter for, but not the normal queue.
      where: { status: (status as 'converted') ?? 'converted' },
      orderBy: { completedAt: 'asc' },
      take: 100,
    });
    if (rows.length === 0) return [];

    const identities = await this.wawuId.lookupPublicIdentities(
      rows.map((r) => r.wawuUserId),
    );
    const now = Date.now();

    return rows.map((row) => {
      const brief = row.brief as LegalBrief | null;
      const identity = identities.get(row.wawuUserId);
      const name = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const urgency = (row.answers as Record<string, unknown> | null)?.[
        'urgency'
      ];

      return {
        id: row.id,
        wawuUserId: row.wawuUserId,
        clientName: name || row.wawuUserId,
        matter: row.matter,
        matterLabel: matterLabel(row.matter),
        status: row.status,
        summary: brief?.analysis.summary ?? '',
        documentCount: row.documents.length,
        completedAt: row.completedAt,
        waitingHours: row.completedAt
          ? Math.max(
              0,
              Math.round((now - row.completedAt.getTime()) / 3_600_000),
            )
          : 0,
        urgency: typeof urgency === 'string' ? urgency : null,
      };
    });
  }

  async detail(id: string): Promise<IntakeDetailView> {
    const row = await this.prisma.legalIntake.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Intake not found');

    const identities = await this.wawuId.lookupPublicIdentities([
      row.wawuUserId,
    ]);
    const identity = identities.get(row.wawuUserId);
    const name = [identity?.firstName, identity?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      id: row.id,
      wawuUserId: row.wawuUserId,
      clientName: name || row.wawuUserId,
      matter: row.matter,
      matterLabel: matterLabel(row.matter),
      status: row.status,
      documents: row.documents,
      // The brief already carries the client's answers as question-and-answer
      // pairs, so the consultant reads the analysis and the transcript that
      // produced it in one payload — and can always tell which is which.
      brief: (row.brief as LegalBrief | null) ?? null,
      completedAt: row.completedAt,
      legalRequestId: row.legalRequestId,
    };
  }
}
