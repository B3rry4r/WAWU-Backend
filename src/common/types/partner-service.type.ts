import type { PartnerServiceModel } from '../../../generated/prisma/models';

/**
 * Prisma model IS the wire shape for PartnerService — thin re-export.
 *
 * Which means the four columns added for the Marketplace "Featured Services"
 * rail (`imageUrl`, `category`, `priceFromNaira`, `featured`) reach the wire
 * through this alias rather than through a mapper. That is intended here and
 * is safe for exactly these four: every one of them is editorial data meant
 * to be read by anybody browsing the catalogue, and this table holds nothing
 * private. It is NOT a licence to keep adding columns — protected-surface
 * hazard H-1 is precisely that a re-export widens a shipped response by
 * itself, and anything on this table that a shopper should not see needs a
 * declared view and a mapper first.
 */
export type PartnerService = PartnerServiceModel;
