import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { EXPORT_SECTIONS } from './data-export-sections';

/**
 * What the file tells the reader it does not hold, in plain words. The
 * reasons behind each line are in EXPORT_EXCLUDED (data-export-sections.ts).
 */
export const NOT_IN_THIS_FILE: string[] = [
  'Your name, email address and phone number. Those are kept by the sign-in service, not here.',
  'Wallet transactions and statements. Your wallet balance is held by the bank, not by this file.',
  'Identity documents and checks, PINs, device keys and uploaded files.',
  'Replies other people wrote to you, and lists of people who follow you or looked at your profile.',
  'Legal and health records, which are shared with the people who handle them.',
];

export interface DataExportFile {
  exportedAt: string;
  requestId: string;
  accountId: string;
  notIncluded: string[];
  data: Record<string, unknown>;
}

/**
 * Builds one person's export at the moment their link is opened, from the
 * database, so nothing about them is stored in a second place. Every section
 * is read for the requester's id only (data-export-sections.ts).
 */
@Injectable()
export class DataExportBuilder {
  constructor(private readonly prisma: PrismaService) {}

  async build(userWawuId: string, requestId: string): Promise<DataExportFile> {
    const entries = await Promise.all(
      EXPORT_SECTIONS.map(
        async (s) => [s.key, await s.load(this.prisma, userWawuId)] as const,
      ),
    );
    return {
      exportedAt: new Date().toISOString(),
      requestId,
      accountId: userWawuId,
      notIncluded: NOT_IN_THIS_FILE,
      data: Object.fromEntries(entries),
    };
  }
}
