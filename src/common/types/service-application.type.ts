import type { ServiceApplicationModel } from '../../../generated/prisma/models';

export type ServiceApplication = ServiceApplicationModel;

/**
 * `timeline` is stored as Prisma `Json` (registry: "object[]", no
 * relational query value — see prisma/schema.prisma). This wire type
 * documents its expected shape without forcing a rigid Prisma structure.
 */
export interface ServiceApplicationTimelineEntry {
  label: string;
  occurredAt: string;
  note?: string;
}

export type ServiceApplicationResponse = Omit<ServiceApplication, 'timeline'> & {
  timeline: ServiceApplicationTimelineEntry[];
};
