import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { DataExportRequest } from '../common/types';

/**
 * Owns DataExportRequest — the "download my data" flow off the
 * settings-privacy screen (registry.json § DataExportRequest). Each call
 * creates a fresh request row; there is no dedup/idempotency in the frozen
 * contract (no unique constraint on userWawuId in the schema, no notion of
 * "already pending" in the fields), so repeat requests simply queue
 * another one. Fulfilment (assembling the export, flipping pending ->
 * ready) is a background job outside this resource's frozen contract —
 * this service only ever writes `status: "pending"` on create.
 */
@Injectable()
export class DataExportRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userWawuId: string): Promise<DataExportRequest> {
    return this.prisma.dataExportRequest.create({
      data: {
        userWawuId,
        status: 'pending',
      },
    });
  }
}
