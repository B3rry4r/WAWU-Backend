import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateMarketplaceSaveDto } from './dto/create-marketplace-save.dto';
import type { MarketplaceSave } from '../common/types';

@Injectable()
export class MarketplaceSaveService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent save: re-saving the same (userWawuId, productId, shop) is a
   * no-op that returns the existing row rather than erroring — "save" is a
   * toggle-on action from the client's perspective, not a strict create.
   */
  async save(userWawuId: string, dto: CreateMarketplaceSaveDto): Promise<MarketplaceSave> {
    return this.prisma.marketplaceSave.upsert({
      where: {
        userWawuId_productId_shop: {
          userWawuId,
          productId: dto.productId,
          shop: dto.shop,
        },
      },
      update: {},
      create: {
        userWawuId,
        productId: dto.productId,
        shop: dto.shop,
      },
    });
  }

  /**
   * Un-saves productId for this user (all shops, since the route contract
   * only carries :productId — a given opaque productId is expected to
   * belong to exactly one shop in practice). Throws 404 if nothing to
   * remove, so the client learns its local "saved" state was stale.
   */
  async unsave(userWawuId: string, productId: string): Promise<void> {
    const { count } = await this.prisma.marketplaceSave.deleteMany({
      where: { userWawuId, productId },
    });
    if (count === 0) {
      throw new NotFoundException('No saved marketplace item found for that productId');
    }
  }
}
