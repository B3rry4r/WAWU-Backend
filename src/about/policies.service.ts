import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { isPlainSections } from '../admin/legal-documents/policy-input';
import type { PolicySectionView, PolicyView } from './about-view.type';

export const POLICY_SLUGS = ['terms', 'privacy'] as const;
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

/** The owner's Terms and Privacy policy, read from LegalDocument. */
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
