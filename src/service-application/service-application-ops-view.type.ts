import type { ServiceApplicationKind } from '../../generated/prisma/enums';
import type { ServiceApplicationModel } from '../../generated/prisma/models';

/**
 * The wire shapes for the OPERATOR reads on ServiceApplication.
 *
 * These are declared views, and that is the whole point of the file.
 * `src/common/types/service-application.type.ts` is `export type
 * ServiceApplication = ServiceApplicationModel` — a bare Prisma re-export,
 * returned to the app by spread. Two consequences, both of which this file
 * exists to avoid:
 *
 *  1. Reusing it would mean a new column on ServiceApplication silently
 *     widening a live app response (protected-surface hazard H-1). The
 *     operator surface must be able to change without the shipped app
 *     changing, so it gets its own types.
 *  2. Nothing in a bare re-export tells a client what `timeline` holds. The
 *     column is Prisma `Json`; a dashboard reading it has to guess, and the
 *     way that guess fails is `undefined.map` in production. Here `timeline`
 *     is a declared array of a declared entry type, `documents` is a declared
 *     `string[]`, and both are produced by the mappers below — never spread
 *     out of a row.
 *
 * The two views are deliberately NOT the same shape. The queue row carries no
 * document URL, no intake answers and no timeline; the detail carries all
 * three. That split is what makes the audit decision honest — see
 * `application_documents_viewed` in prisma/schema.prisma.
 */

/**
 * One entry of the application timeline, as the operator sees it.
 *
 * `note` is `string | null`, never `undefined`: the stored entries omit the
 * key entirely when there is no note, and a client that has to distinguish
 * "absent" from "null" is a client that will get it wrong.
 */
export interface ServiceApplicationOpsTimelineEntryView {
  label: string;
  /** ISO-8601, exactly as written at intake / by the ops writes. */
  occurredAt: string;
  note: string | null;
}

/** One row of the operator queue. */
export interface ServiceApplicationOpsQueueItemView {
  id: string;
  /** The human-facing tracking code, e.g. "WA-CAC-40912". */
  reference: string;
  /** Who applied. Cross-boundary id — this backend holds no name for them. */
  applicantWawuId: string;
  kind: ServiceApplicationKind;
  title: string;
  /** Free-form by column definition, not an enum — see ProgressApplicationDto. */
  status: string;
  statusLabel: string;
  appliedDate: Date;
  /**
   * Whole days since intake. How a queue is triaged when it is oldest-first,
   * and the unit the product already quotes for CAC (an eight-day promise),
   * so hours would be noise here.
   */
  waitingDays: number;
  /**
   * Naira, whole units — ₦ only, never a dollar figure. `null` means nothing
   * has been paid on this application (NEPC and the partner services are
   * free; a CAC row is null until its charge verifies).
   */
  amountPaid: number | null;
  /** How many files the applicant uploaded. The URLs are detail-only. */
  documentCount: number;
  /** Date-only column; null until an operator or the payment leg sets it. */
  certificateExpectedBy: Date | null;
  /** The heading of the most recent timeline entry — "where has this got to". */
  latestUpdateLabel: string | null;
}

/** One application in full. */
export interface ServiceApplicationOpsDetailView extends ServiceApplicationOpsQueueItemView {
  /**
   * The applicant's own submitted answers.
   *
   * They live in the FIRST timeline entry's `note`, because the schema has no
   * column for them: intake writes what the applicant typed into that entry
   * (NEPC's product, category, target markets and yearly volume; a partner
   * request's note verbatim) and stores nothing else. It is surfaced as its
   * own field rather than left for the operator to dig out of `timeline`,
   * which is the position it occupies.
   *
   * KNOWN GAP, reported rather than papered over: the CAC intake note records
   * the COUNT of proposed names, the registration type and the nature of
   * business — not the names themselves. An operator working a CAC
   * registration therefore cannot see which names to file. Fixing that means
   * changing what `POST /services/cac/apply` writes into a timeline the app
   * already renders, which this change is not permitted to do.
   *
   * `null` only if a row somehow has an empty timeline.
   */
  submission: ServiceApplicationOpsTimelineEntryView | null;
  /**
   * Every file on the application: what the applicant uploaded (ID,
   * signature, passport photograph — see the column's own comment in
   * prisma/schema.prisma) and, once approved, the issued certificate that
   * `approve` appends. Stored object URLs, passed through unchanged — this
   * surface mints no new signed URL and therefore hands out no capability the
   * applicant's own read does not already have.
   */
  documents: string[];
  /** Oldest first, matching the order intake and the three writes append in. */
  timeline: ServiceApplicationOpsTimelineEntryView[];
  /** The reason an operator gave for refusing it. Null unless rejected. */
  rejection: string | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Reads the `Json` timeline column into declared entries, discarding anything
 * that is not one.
 *
 * Defensive on purpose: the column is `Json`, so a malformed row is a
 * possibility the type system cannot rule out, and the failure mode of
 * trusting it is a 500 on the queue screen — i.e. the operator is back to
 * seeing nothing, which is the bug this whole change exists to fix.
 */
export function readTimeline(
  value: unknown,
): ServiceApplicationOpsTimelineEntryView[] {
  if (!Array.isArray(value)) return [];
  const entries: ServiceApplicationOpsTimelineEntryView[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.label !== 'string') continue;
    entries.push({
      label: entry.label,
      occurredAt: typeof entry.occurredAt === 'string' ? entry.occurredAt : '',
      note: typeof entry.note === 'string' ? entry.note : null,
    });
  }
  return entries;
}

export function toServiceApplicationOpsQueueItemView(
  row: ServiceApplicationModel,
  now: number = Date.now(),
): ServiceApplicationOpsQueueItemView {
  const timeline = readTimeline(row.timeline);
  return {
    id: row.id,
    reference: row.reference,
    applicantWawuId: row.applicantWawuId,
    kind: row.kind,
    title: row.title,
    status: row.status,
    statusLabel: row.statusLabel,
    appliedDate: row.appliedDate,
    waitingDays: Math.max(
      0,
      Math.floor((now - row.appliedDate.getTime()) / MS_PER_DAY),
    ),
    amountPaid: row.amountPaid,
    documentCount: row.documents.length,
    certificateExpectedBy: row.certificateExpectedBy,
    latestUpdateLabel: timeline.at(-1)?.label ?? null,
  };
}

export function toServiceApplicationOpsDetailView(
  row: ServiceApplicationModel,
  now: number = Date.now(),
): ServiceApplicationOpsDetailView {
  const timeline = readTimeline(row.timeline);
  return {
    ...toServiceApplicationOpsQueueItemView(row, now),
    submission: timeline[0] ?? null,
    documents: [...row.documents],
    timeline,
    rejection: row.rejection,
  };
}
