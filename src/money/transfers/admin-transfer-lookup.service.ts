import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BANK_SEND_REFERENCE_PREFIX } from '../../wallet-provider/wallet-provider.interface';
import type {
  AdminTransferLookupResult,
  AdminTransferLookupView,
} from './admin-transfer-lookup.view';
import {
  parseReferenceQuery,
  SEND_REFERENCE_PREFIX,
  shortReferenceOf,
} from './transfer-reference';

/** How many sends one lookup answers: a short reference that two sends share shows both, never a long list. */
export const LOOKUP_LIMIT = 10;

/**
 * Support finds a send by the reference a person quotes (R2-MONEY D-03). Reads our own `WalletTransfer` rows by their stored reference
 * (a unique, indexed column): the whole reference matches exactly, a short one matches the sends whose stored reference begins with its
 * eight hex digits. Changes nothing and asks the provider nothing.
 */
@Injectable()
export class AdminTransferLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(reference: string): Promise<AdminTransferLookupResult> {
    const query = parseReferenceQuery(reference);
    if (!query) return { items: [] };
    const where =
      query.kind === 'short'
        ? {
            OR: [
              {
                customerReference: {
                  startsWith: `${SEND_REFERENCE_PREFIX}${query.hex}`,
                },
              },
              {
                customerReference: {
                  startsWith: `${BANK_SEND_REFERENCE_PREFIX}${query.hex}`,
                },
              },
            ],
          }
        : { customerReference: query.reference };
    const rows = await this.prisma.walletTransfer.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LOOKUP_LIMIT,
      select: {
        id: true,
        kind: true,
        status: true,
        customerReference: true,
        amountKobo: true,
        providerFeeKobo: true,
        wawuFeeKobo: true,
        totalKobo: true,
        payerWawuUserId: true,
        recipientWawuUserId: true,
        payerName: true,
        recipientName: true,
        bankName: true,
        createdAt: true,
        completedAt: true,
      },
    });
    const items: AdminTransferLookupView[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      reference: r.customerReference,
      shortReference: shortReferenceOf(r.customerReference),
      amountKobo: Number(r.amountKobo),
      providerFeeKobo: Number(r.providerFeeKobo),
      wawuFeeKobo: Number(r.wawuFeeKobo),
      totalKobo: Number(r.totalKobo),
      payerWawuUserId: r.payerWawuUserId,
      recipientWawuUserId: r.recipientWawuUserId,
      payerName: r.payerName,
      recipientName: r.recipientName,
      bankName: r.bankName,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    }));
    return { items };
  }
}
