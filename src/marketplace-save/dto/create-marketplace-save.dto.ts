import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { ShopKind } from '../../../generated/prisma/enums';

/**
 * POST /marketplace/saves body — registry.json MarketplaceSave contract.
 * `productId` is an external, opaque id (WAWUBasket/Beauty-owned per
 * supersede S-5) — this backend does no lookup against it, only stores it.
 */
export class CreateMarketplaceSaveDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsEnum(ShopKind, { message: 'shop must be one of: basket, beauty' })
  shop!: ShopKind;
}
