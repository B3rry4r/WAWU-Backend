import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { isPlainSections } from '../admin/legal-documents/policy-input';
import type {
  PolicyListView,
  PolicySectionView,
  PolicyView,
} from './about-view.type';

/**
 * The owner's nine legal documents, in the owner's order (26 Oct 2026, documents 1 to 9). The order is the order of
 * GET /policies. Terms and privacy are the two the web has always read.
 */
export const POLICY_SLUGS = [
  'privacy',
  'terms',
  'cookies',
  'creator-monetization',
  'verification-refund',
  'acceptable-use',
  'partner-dpa',
  'community-guidelines',
  'disclaimer',
] as const;
export type PolicySlug = (typeof POLICY_SLUGS)[number];

export function isPolicySlug(slug: string): slug is PolicySlug {
  return (POLICY_SLUGS as readonly string[]).includes(slug);
}

function sectionsOf(raw: unknown): PolicySectionView[] {
  if (!Array.isArray(raw)) return [];
  const out: PolicySectionView[] = [];
  for (const item of raw) {
    const s = item as { heading?: unknown; body?: unknown } | null;
    if (s && typeof s.heading === 'string' && typeof s.body === 'string') {
      out.push({ heading: s.heading, body: s.body });
    }
  }
  return out;
}

/** The owner's nine legal documents, read from LegalDocument. */
@Injectable()
export class PoliciesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(slug: string): Promise<PolicyView> {
    if (!isPolicySlug(slug)) throw new NotFoundException('No such policy.');
    const row = await this.prisma.legalDocument.findUnique({ where: { slug } });
    const sections = row ? sectionsOf(row.sections) : [];
    if (!row || sections.length === 0) {
      return {
        slug,
        available: false,
        title: null,
        effectiveDate: null,
        sections: [],
      };
    }
    return {
      slug,
      available: true,
      title: row.title,
      effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
      sections,
    };
  }

  /**
   * The published documents (a row with at least one usable section), in the owner's order. A row for a slug
   * outside the nine is not listed. Carries no text: the app opens a document by its slug.
   */
  async list(): Promise<PolicyListView> {
    const rows = await this.prisma.legalDocument.findMany({
      where: { slug: { in: [...POLICY_SLUGS] } },
    });
    const items = POLICY_SLUGS.flatMap((slug) => {
      const row = rows.find((r) => r.slug === slug);
      if (!row || sectionsOf(row.sections).length === 0) return [];
      return [
        {
          slug,
          title: row.title,
          effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
        },
      ];
    });
    return { items };
  }

  async put(
    slug: string,
    input: {
      title: string;
      effectiveDate: string;
      sections: PolicySectionView[];
    },
  ): Promise<PolicyView> {
    if (!isPolicySlug(slug)) throw new NotFoundException('No such policy.');
    const sections = input.sections.map((x) => ({
      heading: x.heading,
      body: x.body,
    }));
    if (!isPlainSections(input.sections)) {
      throw new BadRequestException(
        'A document needs sections, each with a heading and a body.',
      );
    }
    const effectiveDate = new Date(`${input.effectiveDate}T00:00:00.000Z`);
    await this.prisma.legalDocument.upsert({
      where: { slug },
      create: { slug, title: input.title, effectiveDate, sections },
      update: { title: input.title, effectiveDate, sections },
    });
    return this.get(slug);
  }
}
