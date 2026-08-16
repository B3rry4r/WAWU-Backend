import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { PartnerService } from '../common/types';

@Injectable()
export class PartnerServiceService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /services — registry.json § PartnerService. Reference/seed data, admin-managed later. */
  async list(): Promise<PartnerService[]> {
    return this.prisma.partnerService.findMany({ orderBy: { name: 'asc' } });
  }

  /** GET /services/:id — registry.json § PartnerService. */
  async findOne(id: string): Promise<PartnerService> {
    const service = await this.prisma.partnerService.findUnique({
      where: { id },
    });
    if (!service) {
      throw new NotFoundException('Partner service not found');
    }
    return service;
  }

  /**
   * POST /services/:id/notify-me — registry.json § PartnerService.
   * Schema is frozen with no notify-subscription table for this reference
   * resource, so this is intentionally a stateless stub: it 404s on an
   * unknown service id (same existence check as findOne) and otherwise
   * always returns the contracted `{success:true}` shape. If/when a
   * persisted notify-list is needed, that's a schema change — HALT per
   * the build brief, not a table invented here.
   */
  async notifyMe(id: string): Promise<{ success: true }> {
    await this.findOne(id);
    return { success: true };
  }
}
