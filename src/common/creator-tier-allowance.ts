import type { CreatorTier } from '../../generated/prisma/enums';

/**
 * Upload allowances per creator tier.
 *
 * This is the single source of truth for how many pieces a creator may
 * publish and how that total splits between free and paid. It is deliberately
 * NOT a stored column (see the CreatorState doc comment in
 * prisma/schema.prisma): it derives from `tier`, so a tier change takes
 * effect immediately rather than needing a backfill.
 *
 * Basic   — 6 uploads: 1 free, 5 paid.
 * Pro     — 12 uploads: 2 free, 10 paid.
 * Pro Max — 12 uploads: 2 free, 10 paid, the same as Pro.
 *
 * Pro Max deliberately does NOT raise the upload count. What it adds is music
 * distribution, equipment access, health cover and support — not more slots.
 * Giving it a bigger number here purely because it costs more would be
 * inventing a benefit the plan does not sell.
 *
 * `total` is not independent: it is free + paid, and a creator who has used
 * all their free slots cannot spend the remainder on more free uploads.
 * Enforced in ContentPieceService.create().
 */
export interface UploadAllowance {
  free: number;
  paid: number;
  total: number;
}

export const UPLOAD_ALLOWANCE_BY_TIER: Record<CreatorTier, UploadAllowance> = {
  basic: { free: 1, paid: 5, total: 6 },
  pro: { free: 2, paid: 10, total: 12 },
  pro_max: { free: 2, paid: 10, total: 12 },
};

export function uploadAllowanceFor(tier: CreatorTier): UploadAllowance {
  return UPLOAD_ALLOWANCE_BY_TIER[tier];
}
