import { Injectable, Logger } from '@nestjs/common';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { PaidWhen } from './notice-kinds';

/**
 * Small reads the notices share (EMAIL-02): when a creator's money reaches
 * their wallet, and how a person is named to someone else. Both are read
 * after the money event has committed, holding no transaction.
 */
@Injectable()
export class NoticeFacts {
  private readonly logger = new Logger(NoticeFacts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  /**
   * When a creator's earning is in their wallet (R-11, R-101). A creator with
   * no wallet keeps earning and the money waits for the day they open one. A
   * wallet sale lands in the wallet on its own (`now`); a store sale is paid
   * from WAWU's own wallet 3 working days after the sale.
   */
  async paidWhen(
    creatorWawuId: string,
    source: 'wallet' | 'store',
  ): Promise<PaidWhen> {
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { wawuUserId: true },
    });
    if (!wallet) return 'when_wallet_opens';
    return source === 'store' ? 'in_3_working_days' : 'now';
  }

  /** The figures of one wallet payment, from its own row: what the payer paid, the payee's share, the reference. */
  async payment(paymentId: string): Promise<{
    priceKobo: number;
    totalKobo: number;
    payeeShareKobo: number;
    reference: string;
  } | null> {
    const row = await this.prisma.walletPayment.findUnique({
      where: { id: paymentId },
      select: {
        priceKobo: true,
        totalKobo: true,
        payeeShareKobo: true,
        customerReference: true,
      },
    });
    if (!row) return null;
    return {
      priceKobo: Number(row.priceKobo),
      totalKobo: Number(row.totalKobo),
      payeeShareKobo: Number(row.payeeShareKobo),
      reference: row.customerReference,
    };
  }

  /**
   * "Ada O.": the first name and the first letter of the last, as the app's
   * own notices name a buyer. Null when WAWU ID does not answer or the person
   * has no name; the email then does not name them.
   */
  async nameOf(wawuId: string | null): Promise<string | null> {
    if (!wawuId) return null;
    try {
      const found = await this.wawuId.lookupPublicIdentities([wawuId]);
      const who = found.get(wawuId);
      const first = who?.firstName?.trim() ?? '';
      const last = who?.lastName?.trim() ?? '';
      if (first === '') return null;
      return last === '' ? first : `${first} ${last.charAt(0)}.`;
    } catch (e) {
      this.logger.warn(
        `notice facts: a name could not be read (${e instanceof Error ? e.name : 'error'})`,
      );
      return null;
    }
  }
}
