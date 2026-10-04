import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { DataExportMailer } from './data-export-mailer';
import { EXPORT_LINK_HOURS, signExportLink } from './data-export-link';

/**
 * PROVISIONAL(EXPORT-RETRY-HOURS, owner=DEV, why=no ruling names how long to keep retrying an export email; a request that cannot be emailed within a day is marked failed)
 */
const GIVE_UP_AFTER_HOURS = 24;
const BATCH = 20;

/**
 * Fulfils data-export requests (SETTINGS-04): a `pending` request becomes
 * `sent` once WAWU ID has been asked to email the link, or `failed` when that
 * has not worked for a day. The sweep runs every minute where
 * ScheduleModule.forRoot() is loaded (app.module.ts).
 *
 * Statuses: pending (asked for), sent (the email was handed to WAWU ID),
 * failed (gave up). `status` is a free string column, so no migration.
 */
@Injectable()
export class DataExportFulfilmentService {
  private readonly logger = new Logger(DataExportFulfilmentService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: DataExportMailer,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'data-export-fulfil' })
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await this.prisma.dataExportRequest.findMany({
        where: { status: 'pending' },
        orderBy: { requestedAt: 'asc' },
        take: BATCH,
      });
      let sent = 0;
      for (const row of rows) {
        if (await this.fulfil(row.id)) sent += 1;
      }
      return sent;
    } finally {
      this.running = false;
    }
  }

  /** True when the email was handed over. A failure leaves the row pending (or failed, after a day). */
  async fulfil(requestId: string, now: Date = new Date()): Promise<boolean> {
    const row = await this.prisma.dataExportRequest.findUnique({
      where: { id: requestId },
    });
    if (!row || row.status !== 'pending') return false;

    try {
      const expiresAt = new Date(now.getTime() + EXPORT_LINK_HOURS * 3_600_000);
      const token = signExportLink(
        row.id,
        expiresAt,
        this.config.get<string>('ADMIN_JWT_SECRET'),
      );
      const url = `${this.publicBase()}/api/hub/settings/privacy/export/download?token=${encodeURIComponent(token)}`;
      await this.mailer.sendLink(row.userWawuId, url, expiresAt);
    } catch (e) {
      const ageHours = (now.getTime() - row.requestedAt.getTime()) / 3_600_000;
      this.logger.warn(
        `Export ${row.id} not emailed yet: ${e instanceof Error ? e.message : String(e)}`,
      );
      if (ageHours >= GIVE_UP_AFTER_HOURS) {
        await this.prisma.dataExportRequest.updateMany({
          where: { id: row.id, status: 'pending' },
          data: { status: 'failed' },
        });
      }
      return false;
    }
    const { count } = await this.prisma.dataExportRequest.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'sent' },
    });
    return count > 0;
  }

  private publicBase(): string {
    const configured = this.config.get<string>('HUB_PUBLIC_URL');
    if (configured) return configured.replace(/\/+$/, '');
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'HUB_PUBLIC_URL is not set; the export link has no address.',
      );
    }
    return `http://localhost:${process.env.HUB_API_PORT ?? process.env.PORT ?? 3000}`;
  }
}
