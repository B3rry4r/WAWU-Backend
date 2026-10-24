import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AccountPurgeHooks } from '../../account-purge/purge-hooks';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HELD_STATES, WalletCardService } from './wallet-card.service';

/**
 * Before an account's rows are deleted, every card the person still holds is
 * blocked at Nuvion (round 1, H1a: WalletCard.wawuUserId is OWNED, so its rows
 * go with the account, and a card must not outlive the only WAWU record of
 * it). A block that cannot be made throws, which stops the purge before it
 * deletes anything; the sweep tries again, and blocking a blocked card is a
 * no-op, so this is safe to run again.
 */
@Injectable()
export class WalletCardPurge implements OnModuleInit {
  private readonly logger = new Logger(WalletCardPurge.name);

  constructor(
    private readonly hooks: AccountPurgeHooks,
    private readonly prisma: PrismaService,
    private readonly cards: WalletCardService,
  ) {}

  onModuleInit(): void {
    this.hooks.register((wawuUserId) => this.beforeErase(wawuUserId));
  }

  async beforeErase(wawuUserId: string): Promise<void> {
    const held = await this.prisma.walletCard.findMany({
      where: { wawuUserId, state: { in: HELD_STATES } },
      select: { id: true },
    });
    if (held.length === 0) return;
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { customerId: true, walletId: true, accountNumber: true },
    });
    if (!wallet) {
      this.logger.warn(
        `account ${wawuUserId}: ${held.length} held card row(s) and no wallet row; the rows go without a block`,
      );
      return;
    }
    for (const { id } of held) {
      await this.cards.control({ wawuUserId, ...wallet }, id, 'block');
    }
  }
}
