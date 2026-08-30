import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ProductCategory,
  ProductStatus,
} from '../../../generated/prisma/enums';
import { MAX_QUANTITY_PER_LINE } from '../shop.constants';

/* ------------------------------------------------------------------ *
 * Browsing
 * ------------------------------------------------------------------ */

export class ListProductsDto {
  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  subcategory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  /** The brief's "shop by budget" — a ceiling, not a band. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  maxPriceNaira?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  wawuPick?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  perPage?: number;
}

/* ------------------------------------------------------------------ *
 * Cart
 * ------------------------------------------------------------------ */

export class AddToCartDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY_PER_LINE)
  quantity!: number;
}

export class SetCartQuantityDto {
  /** Zero is meaningful: it removes the line. */
  @IsInt()
  @Min(0)
  @Max(MAX_QUANTITY_PER_LINE)
  quantity!: number;
}

/* ------------------------------------------------------------------ *
 * Checkout
 * ------------------------------------------------------------------ */

/**
 * The delivery address.
 *
 * EVERY FIELD HERE EXCEPT THE NOTE IS REQUIRED, and that is the whole point.
 * The brief says logistics is handled physically and off-platform, which means
 * a person reads these lines and carries a box to them. An optional phone
 * number is a package that cannot be delivered and a customer who cannot be
 * reached — the looseness that would be harmless with a courier API is exactly
 * what breaks without one.
 *
 * No amount is accepted from the client. The total is recomputed server-side
 * from live product rows at checkout.
 */
export class CheckoutDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  deliveryName!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(30)
  deliveryPhone!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(300)
  deliveryAddress!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  deliveryCity!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  deliveryState!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  deliveryNote?: string;
}

export class VerifyShopOrderDto {
  @IsString()
  @MaxLength(120)
  transaction_id!: string;

  @IsString()
  @MaxLength(120)
  tx_ref!: string;
}

/* ------------------------------------------------------------------ *
 * Admin — product management from the dashboard
 * ------------------------------------------------------------------ */

export class UpsertProductDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  brand?: string;

  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  description!: string;

  @IsEnum(ProductCategory)
  category!: ProductCategory;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  subcategory!: string;

  /**
   * At least ₦1. A product priced at nothing is a mistake nobody notices until
   * it sells out, and it cannot be charged for through a payment provider.
   */
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  priceNaira!: number;

  /** The "was" price. The service refuses one that does not exceed the price. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  compareAtNaira?: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  stock!: number;

  /**
   * At least one image is required for a LIVE product — the brief's whole
   * design is "large imagery, minimal text", and a card with no picture is a
   * grey box in the middle of it. Enforced on publish rather than on save, so
   * a draft can be written before the photos arrive.
   */
  @IsArray()
  @ArrayMaxSize(8)
  @IsUrl({ require_tld: false }, { each: true })
  images!: string[];

  @IsOptional()
  @IsBoolean()
  wawuVerified?: boolean;

  @IsOptional()
  @IsBoolean()
  wawuPick?: boolean;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}

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
