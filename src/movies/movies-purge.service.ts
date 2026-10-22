import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountPurgeHooks } from '../account-purge/purge-hooks';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * When a WAWU account is purged (SETTINGS-06) the person's partner-link row is
 * marked (FLIX-01, R-75): `accountDeletedAt` stops any further link for them
 * (the watch route also refuses from the moment the deletion is asked for) and
 * is the note that their account on the partner's side is closed by hand
 * (G-FLIX-2: the partner's API has no call that closes an account). The row
 * keeps only the permanent WAWU id the partner knows them by, the times and
 * the count. Safe to run again.
 */
@Injectable()
export class MoviesPurgeService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hooks: AccountPurgeHooks,
  ) {}

  onModuleInit(): void {
    this.hooks.register((wawuUserId) => this.beforeErase(wawuUserId));
  }

  async beforeErase(wawuUserId: string): Promise<void> {
    await this.prisma.moviePartnerLink.updateMany({
      where: { wawuUserId, accountDeletedAt: null },
      data: { accountDeletedAt: new Date() },
    });
  }
}
