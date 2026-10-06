import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { DataExportRequest } from '../common/types';
import {
  EXPORT_REQUESTS_PER_WINDOW,
  EXPORT_WINDOW_HOURS,
} from './data-export-config';

/**
 * Owns DataExportRequest, the "download my data" flow off the
 * settings-privacy screen (registry.json § DataExportRequest).
 *
 * SETTINGS-04 fulfils it: DataExportFulfilmentService emails a signed link
 * and DataExportDownloadController serves the file.
 *
 * ONE OPEN REQUEST PER ACCOUNT. Asking while a request is pending returns that
 * request (same shape), so a person tapping twice, or four requests arriving
 * at once, get one row and one email. The check and the insert run under a
 * per-account transaction lock, so parallel requests queue behind each other
 * instead of all seeing "nothing pending". No unique index is needed, so
 * there is no migration.
 *
 * RATE LIMIT. After that, a new request is refused with 429 once the account
 * has made EXPORT_REQUESTS_PER_WINDOW in the last EXPORT_WINDOW_HOURS.
 */
@Injectable()
export class DataExportRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userWawuId: string): Promise<DataExportRequest> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'data-export:' + userWawuId}))`;

        const waiting = await tx.dataExportRequest.findFirst({
          where: { userWawuId, status: 'pending' },
          orderBy: { requestedAt: 'desc' },
        });
        if (waiting) return waiting;

        const since = new Date(Date.now() - EXPORT_WINDOW_HOURS * 3_600_000);
        const recent = await tx.dataExportRequest.count({
          where: { userWawuId, requestedAt: { gte: since } },
        });
        if (recent >= EXPORT_REQUESTS_PER_WINDOW) {
          throw new HttpException(
            `You can ask for your data ${EXPORT_REQUESTS_PER_WINDOW} times a day. Try again tomorrow.`,
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        return tx.dataExportRequest.create({
          data: { userWawuId, status: 'pending' },
        });
      },
      { timeout: 10_000 },
    );
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
