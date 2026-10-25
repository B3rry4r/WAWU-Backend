import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CreditPack,
  StorePlatform,
  StoreProductKind,
  StorePurchaseStatus,
} from '../../generated/prisma/enums';

/** Ids a store sells products under: letters, digits, dot, dash, underscore. */
const STORE_ID = /^[A-Za-z0-9._-]+$/;

/** GET /store/products?platform= */
export class StoreProductsQueryDto {
  /** The store the app runs on: `android` (Google Play) or `ios` (App Store). */
  @ApiProperty({ enum: StorePlatform })
  @IsEnum(StorePlatform, { message: 'platform must be android or ios' })
  platform!: StorePlatform;
}

/** POST /store/purchases. */
export class StorePurchaseDto {
  /** The store the purchase was made in. */
  @ApiProperty({ enum: StorePlatform })
  @IsEnum(StorePlatform, { message: 'platform must be android or ios' })
  platform!: StorePlatform;

  /** The id the store sold it under (`storeProductId` from `GET /store/products`). */
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  @Matches(STORE_ID, { message: 'productId is not a store product id' })
  productId!: string;

  /** Google Play: the purchase token the billing library returned. Required on `android`. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 4096)
  purchaseToken?: string;

  /** App Store: the StoreKit transaction id. Required on `ios`. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Matches(/^[0-9]+$/, {
    message: 'transactionId is not an App Store transaction id',
  })
  transactionId?: string;

  /** The room a community pass is bought for. Required for a pass product, refused for any other. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  communityId?: string;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export class StoreProductGrantsDto {
  /** points: a pack of the live plan, by id. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'packId is not a pack id' })
  packId?: string;

  /** credits: starter, popular or pro. */
  @ApiPropertyOptional({ enum: CreditPack })
  @IsOptional()
  @IsEnum(CreditPack, { message: 'pack must be one of: starter, popular, pro' })
  pack?: CreditPack;

  /** tier: a tier of the live plan, by id. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'tierId is not a tier id' })
  tierId?: string;

  /** pass: the days one purchase gives the room. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  days?: number;

  /** extra_products: the products one purchase adds. Defaults to the plan's count when left out. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  extraProducts?: number;
}

/** POST /admin/store/products. */
export class CreateStoreProductDto {
  @ApiProperty({ enum: StorePlatform })
  @IsEnum(StorePlatform)
  platform!: StorePlatform;

  /** The id the store sells it under. Fixed once created. */
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  @Matches(STORE_ID, { message: 'storeProductId is not a store product id' })
  storeProductId!: string;

  /** Fixed once created. */
  @ApiProperty({ enum: StoreProductKind })
  @IsEnum(StoreProductKind)
  kind!: StoreProductKind;

  @ApiProperty()
  @IsString()
  @Length(1, 80)
  title!: string;

  @ApiProperty({ type: () => StoreProductGrantsDto })
  @ValidateNested()
  @Type(() => StoreProductGrantsDto)
  grants!: StoreProductGrantsDto;

  /** Kobo one purchase is worth before the store's share. Needed for credits and pass products. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  referenceKobo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/** PATCH /admin/store/products/:id. Only what is sent changes. */
export class UpdateStoreProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 80)
  title?: string;

  @ApiPropertyOptional({ type: () => StoreProductGrantsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => StoreProductGrantsDto)
  grants?: StoreProductGrantsDto;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  referenceKobo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/** PATCH /admin/store/platforms/:platform. Only what is sent changes. */
export class UpdateStorePlatformDto {
  /** Switch purchases from this store on or off. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** The store's cut in basis points (1500 = 15%), 0 to 10000. Send `-1` to go back to the config's. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(-1)
  @Max(10_000)
  storeFeeBps?: number;
}

/** GET /admin/store/purchases and /admin/store/refunds. */
export class AdminStorePurchaseQueryDto {
  @ApiPropertyOptional({ enum: StorePlatform })
  @IsOptional()
  @IsEnum(StorePlatform)
  platform?: StorePlatform;

  @ApiPropertyOptional({ enum: StoreProductKind })
  @IsOptional()
  @IsEnum(StoreProductKind)
  kind?: StoreProductKind;

  /** Purchases only (the refunds route always lists refunded and revoked). */
  @ApiPropertyOptional({ enum: StorePurchaseStatus })
  @IsOptional()
  @IsEnum(StorePurchaseStatus)
  status?: StorePurchaseStatus;

  /** One person's purchases. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  wawuUserId?: string;

  /** From the `nextCursor` of the page before. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 300)
  cursor?: string;

  /** 1 to 100, default 20. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
