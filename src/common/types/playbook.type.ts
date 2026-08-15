import type { PlaybookModel } from '../../../generated/prisma/models';

/**
 * `chapters` / `readingSections` are stored as Prisma `Json` (registry:
 * "object[]", no relational query value — see prisma/schema.prisma). These
 * wire types document their expected shape.
 */
export interface PlaybookChapter {
  title: string;
  order: number;
}

export interface PlaybookReadingSection {
  heading: string;
  body: string;
}

export type PlaybookResponse = Omit<PlaybookModel, 'chapters' | 'readingSections'> & {
  chapters: PlaybookChapter[];
  readingSections: PlaybookReadingSection[];
};
