import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type {
  StorePlatform,
  StoreProduct,
} from '../../generated/prisma/client';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { PrismaService } from '../common/prisma/prisma.service';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { isUniqueViolation } from '../money/prisma-unique';
import {
  checkProduct,
  grantsConfigOf,
  isSubscriptionKind,
  resolveGrants,
} from './store-grants';
import { STORE_CONFIG, type StoreConfig } from './store-config';
import { StoreError } from './store-error';
import type {
  CreateStoreProductDto,
  UpdateStoreProductDto,
  UpdateStorePlatformDto,
} from './store.dto';
import type {
  AdminStorePlatformListView,
  AdminStorePlatformView,
  AdminStoreProductListView,
  AdminStoreProductView,
  StoreProductListView,
  StoreProductView,
  StoreUnavailableReason,
} from './store-view.type';

const PLATFORMS: readonly StorePlatform[] = ['android', 'ios'];

/** Whether a store takes purchases now, and at what cut. */
export interface StoreAvailability {
  platform: StorePlatform;
  configured: boolean;
  enabled: boolean;
  feeBps: number;
  feeOverridden: boolean;
  updatedAt: Date | null;
}

/**
 * The store product map and the per-store switch (task IAP-01, R-86). Products
 * are rows an admin edits: nothing is sold for a store product id that has no
 * active row. A store with no credentials, or switched off, sells nothing.
 */
@Injectable()
export class StoreCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORE_CONFIG) private readonly config: StoreConfig,
    @Inject(PLANS_CONFIG) private readonly plans: PlansConfig,
  ) {}

  /** True when the Hub holds everything it needs to ask this store. */
  isConfigured(platform: StorePlatform): boolean {
    return platform === 'android'
      ? this.config.google !== null
      : this.config.apple !== null;
  }

  async availability(platform: StorePlatform): Promise<StoreAvailability> {
    const row = await this.prisma.storePlatformSetting.findUnique({
      where: { platform },
    });
    return {
      platform,
      configured: this.isConfigured(platform),
      enabled: row?.enabled ?? true,
      feeBps: row?.storeFeeBps ?? this.config.feeBps[platform],
      feeOverridden: row?.storeFeeBps != null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Why a store cannot be bought from now; null when it can. */
  unavailableReason(a: StoreAvailability): StoreUnavailableReason | null {
    if (!a.configured) return 'store_not_configured';
    if (!a.enabled) return 'store_disabled';
    return null;
  }

  // -------------------------------------------------------------------------
  // The app
  // -------------------------------------------------------------------------

  /** `GET /store/products`. */
  async listForApp(platform: StorePlatform): Promise<StoreProductListView> {
    const reason = this.unavailableReason(await this.availability(platform));
    if (reason !== null)
      return { platform, available: false, reason, products: [] };
    const rows = await this.prisma.storeProduct.findMany({
      where: { platform, active: true },
      orderBy: [{ sortOrder: 'asc' }, { storeProductId: 'asc' }],
    });
    const products = rows.flatMap((r) => {
      const grants = resolveGrants(
        r.kind,
        grantsConfigOf(r.grants),
        this.plans,
      );
      // A product whose plan entry was removed gives nothing to show: it is not sold.
      if (
        grants.points === null &&
        grants.credits === null &&
        grants.tierId === null &&
        grants.days === null
      )
        return [];
      return [this.appView(r, grants)];
    });
    return { platform, available: true, reason: null, products };
  }

  private appView(
    r: StoreProduct,
    grants: StoreProductView['grants'],
  ): StoreProductView {
    return {
      id: r.id,
      platform: r.platform,
      storeProductId: r.storeProductId,
      kind: r.kind,
      title: r.title,
      subscription: isSubscriptionKind(r.kind),
      grants,
    };
  }

  /** The active product a purchase names, or `store_product_unknown`. */
  async activeProduct(
    platform: StorePlatform,
    storeProductId: string,
  ): Promise<StoreProduct> {
    const row = await this.prisma.storeProduct.findUnique({
      where: { platform_storeProductId: { platform, storeProductId } },
    });
    if (row === null || !row.active)
      throw new StoreError(
        'store_product_unknown',
        'That product is not for sale.',
      );
    return row;
  }

  /** A product by the store's id, active or not: a refund of a product since switched off still has to be read. */
  productBy(
    platform: StorePlatform,
    storeProductId: string,
  ): Promise<StoreProduct | null> {
    return this.prisma.storeProduct.findUnique({
      where: { platform_storeProductId: { platform, storeProductId } },
    });
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  async listProducts(): Promise<AdminStoreProductListView> {
    const rows = await this.prisma.storeProduct.findMany({
      orderBy: [
        { platform: 'asc' },
        { sortOrder: 'asc' },
        { storeProductId: 'asc' },
      ],
    });
    return { items: rows.map((r) => this.adminView(r)) };
  }

  async createProduct(
    admin: AdminUserView,
    dto: CreateStoreProductDto,
  ): Promise<AdminStoreProductView> {
    const checked = checkProduct(
      dto.kind,
      grantsConfigOf(dto.grants),
      dto.referenceKobo ?? null,
      this.plans,
    );
    try {
      const row = await this.prisma.storeProduct.create({
        data: {
          platform: dto.platform,
          storeProductId: dto.storeProductId,
          kind: dto.kind,
          title: dto.title,
          grants: checked.grants as unknown as Prisma.InputJsonValue,
          referenceKobo: checked.referenceKobo,
          active: dto.active ?? true,
          sortOrder: dto.sortOrder ?? 0,
          updatedBy: admin.id,
        },
      });
      return this.adminView(row);
    } catch (e) {
      if (isUniqueViolation(e))
        throw new StoreError(
          'store_product_invalid',
          'That store product id is already in the map.',
        );
      throw e;
    }
  }

  async updateProduct(
    admin: AdminUserView,
    id: string,
    dto: UpdateStoreProductDto,
  ): Promise<AdminStoreProductView> {
    const row = await this.prisma.storeProduct.findUnique({ where: { id } });
    if (row === null)
      throw new StoreError(
        'store_product_unknown',
        'That product is not in the map.',
      );
    const nextGrants =
      dto.grants === undefined
        ? grantsConfigOf(row.grants)
        : grantsConfigOf(dto.grants);
    const checked = checkProduct(
      row.kind,
      nextGrants,
      dto.referenceKobo ?? row.referenceKobo,
      this.plans,
    );
    const updated = await this.prisma.storeProduct.update({
      where: { id },
      data: {
        ...(dto.title === undefined ? {} : { title: dto.title }),
        grants: checked.grants as unknown as Prisma.InputJsonValue,
        referenceKobo: checked.referenceKobo,
        ...(dto.active === undefined ? {} : { active: dto.active }),
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
        updatedBy: admin.id,
      },
    });
    return this.adminView(updated);
  }

  private adminView(r: StoreProduct): AdminStoreProductView {
    const grants = grantsConfigOf(r.grants);
    return {
      id: r.id,
      platform: r.platform,
      storeProductId: r.storeProductId,
      kind: r.kind,
      title: r.title,
      grants,
      resolved: resolveGrants(r.kind, grants, this.plans),
      referenceKobo: r.referenceKobo,
      active: r.active,
      sortOrder: r.sortOrder,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async listPlatforms(): Promise<AdminStorePlatformListView> {
    const items: AdminStorePlatformView[] = [];
    for (const platform of PLATFORMS)
      items.push(this.platformView(await this.availability(platform)));
    return { items };
  }

  async updatePlatform(
    admin: AdminUserView,
    platform: StorePlatform,
    dto: UpdateStorePlatformDto,
  ): Promise<AdminStorePlatformView> {
    const fee =
      dto.storeFeeBps === undefined
        ? undefined
        : dto.storeFeeBps === -1
          ? null
          : dto.storeFeeBps;
    await this.prisma.storePlatformSetting.upsert({
      where: { platform },
      create: {
        platform,
        enabled: dto.enabled ?? true,
        storeFeeBps: fee ?? null,
        updatedBy: admin.id,
      },
      update: {
        ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
        ...(fee === undefined ? {} : { storeFeeBps: fee }),
        updatedBy: admin.id,
      },
    });
    return this.platformView(await this.availability(platform));
  }

  private platformView(a: StoreAvailability): AdminStorePlatformView {
    return {
      platform: a.platform,
      enabled: a.enabled,
      configured: a.configured,
      storeFeeBps: a.feeBps,
      storeFeeOverridden: a.feeOverridden,
      updatedAt: a.updatedAt?.toISOString() ?? null,
    };
  }
}
