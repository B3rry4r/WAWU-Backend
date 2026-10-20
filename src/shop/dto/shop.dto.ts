import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ProductCategory,
  ProductStatus,
} from '../../../generated/prisma/enums';

/*
 * WAWU Shop is retired (R-2, OPS-08). The browse, cart, checkout and product
 * upsert bodies went with the routes that read them; what is left serves a
 * past order.
 */

/* ------------------------------------------------------------------ *
 * Settling a charge opened before the shop closed
 * ------------------------------------------------------------------ */

export class VerifyShopOrderDto {
  @IsString()
  @MaxLength(120)
  transaction_id!: string;

  @IsString()
  @MaxLength(120)
  tx_ref!: string;
}

/* ------------------------------------------------------------------ *
 * Admin: reading the catalogue and moving orders along
 * ------------------------------------------------------------------ */

export class AdminListProductsDto {
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number;
}

/** Moving an order along by hand, which is the only way it moves. */
export class UpdateFulfilmentDto {
  @IsEnum(['awaiting_dispatch', 'dispatched', 'delivered'])
  fulfilment!: 'awaiting_dispatch' | 'dispatched' | 'delivered';

  /** "Sent via GIG, waybill 12345." Free text, because there is no API here. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  trackingNote?: string;
}
