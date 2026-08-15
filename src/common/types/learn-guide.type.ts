import type { LearnGuideModel } from '../../../generated/prisma/models';

/**
 * `sections` is stored as Prisma `Json` (nullable) (registry: "object[]",
 * nullable — see prisma/schema.prisma).
 */
export interface LearnGuideSection {
  heading: string;
  body: string;
}

export type LearnGuideResponse = Omit<LearnGuideModel, 'sections'> & {
  sections: LearnGuideSection[] | null;
};
