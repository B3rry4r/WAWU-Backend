import { Controller, Get, NotFoundException, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { DataExportBuilder } from './data-export-builder.service';
import { verifyExportLink } from './data-export-link';

const NOT_VALID = 'This link is not valid or has expired.';

/**
 * GET /settings/privacy/export/download?token=...: the link in the email.
 *
 * Deliberately no login guard: it is opened from a mail app, in a browser
 * that has no session. The signed, expiring token is the credential, and a
 * request row that was deleted with the account makes it worthless. Every
 * failure is the same 404, so the answer never says whether a token was
 * forged, expired or for a deleted account.
 */
@Controller('settings/privacy/export')
export class DataExportDownloadController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: DataExportBuilder,
    private readonly config: ConfigService,
  ) {}

  @Get('download')
  async download(
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const requestId = token
      ? verifyExportLink(token, this.config.get<string>('ADMIN_JWT_SECRET'))
      : null;
    if (!requestId) throw new NotFoundException(NOT_VALID);

    const row = await this.prisma.dataExportRequest.findUnique({
      where: { id: requestId },
    });
    if (!row || row.status !== 'sent') throw new NotFoundException(NOT_VALID);

    const file = await this.builder.build(row.userWawuId, row.id);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="who-made-this-my-data.json"',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(file, null, 2));
  }
}
