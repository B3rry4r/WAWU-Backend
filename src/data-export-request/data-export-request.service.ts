import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { DataExportRequest } from '../common/types';

/**
 * Owns DataExportRequest, the "download my data" flow off the
 * settings-privacy screen (registry.json § DataExportRequest).
 *
 * SETTINGS-04 fulfils it: DataExportFulfilmentService emails a signed link
 * and DataExportDownloadController serves the file. Asking while a request is
 * still pending returns that request instead of queueing a second email: the
 * answer has the same shape either way, and a person tapping twice does not
 * get two emails.
 */
@Injectable()
export class DataExportRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userWawuId: string): Promise<DataExportRequest> {
    const waiting = await this.prisma.dataExportRequest.findFirst({
      where: { userWawuId, status: 'pending' },
      orderBy: { requestedAt: 'desc' },
    });
    if (waiting) return waiting;
    return this.prisma.dataExportRequest.create({
      data: {
        userWawuId,
        status: 'pending',
      },
    });
  }

  /** The caller's own requests, newest first. */
  async listMine(userWawuId: string): Promise<DataExportRequest[]> {
    return this.prisma.dataExportRequest.findMany({
      where: { userWawuId },
      orderBy: { requestedAt: 'desc' },
      take: 20,
    });
  }
}
