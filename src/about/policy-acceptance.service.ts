import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { PolicyAcceptanceView } from './about-view.type';
import { PoliciesService } from './policies.service';

/**
 * LEGAL-DOCS: the record of what a person agreed to at sign-up. One row per
 * person, published document and effective date (LegalAcceptance). The Hub
 * writes the documents it has published at the time of the call, so the record
 * names the version that was current when the app wrote it a moment after
 * sign-up. A repeat call adds nothing and keeps the first time; a document the
 * owner republished with a new date adds one more row for that document.
 */
@Injectable()
export class PolicyAcceptanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
  ) {}

  async accept(
    userWawuId: string,
    how: 'signup',
  ): Promise<PolicyAcceptanceView> {
    const published = (await this.policies.list()).items;
    if (published.length === 0) return { items: [] };
    await this.prisma.legalAcceptance.createMany({
      data: published.map((d) => ({
        userWawuId,
        slug: d.slug,
        effectiveDate: new Date(`${d.effectiveDate}T00:00:00.000Z`),
        how,
      })),
      skipDuplicates: true,
    });
    const rows = await this.prisma.legalAcceptance.findMany({
      where: {
        userWawuId,
        OR: published.map((d) => ({
          slug: d.slug,
          effectiveDate: new Date(`${d.effectiveDate}T00:00:00.000Z`),
        })),
      },
    });
    return {
      items: published.flatMap((d) => {
        const row = rows.find(
          (r) =>
            r.slug === d.slug &&
            r.effectiveDate.toISOString().slice(0, 10) === d.effectiveDate,
        );
        return row
          ? [
              {
                slug: d.slug,
                effectiveDate: d.effectiveDate,
                acceptedAt: row.acceptedAt.toISOString(),
              },
            ]
          : [];
      }),
    };
  }
}
