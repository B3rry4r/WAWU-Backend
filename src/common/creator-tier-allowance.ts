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
 * Pro Max — 15 uploads: 2 free, 13 paid.
 *
 * Pro Max's total moved from 12 to 15 on product-owner instruction (31 Aug
 * 2026). The FREE allowance stays at 2, matching Pro: the free slots exist so
 * a new creator can publish before paying, which is the same need whatever
 * tier they later buy. The extra three are paid slots, which is what the tier
 * actually sells.
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
  pro_max: { free: 2, paid: 13, total: 15 },
};

export function uploadAllowanceFor(tier: CreatorTier): UploadAllowance {
  return UPLOAD_ALLOWANCE_BY_TIER[tier];
}


/**
 * How much a creator may STORE, in bytes.
 *
 * A SECOND, INDEPENDENT LIMIT. Upload slots cap how many pieces exist; this
 * caps how much space they take. They are not interchangeable: fifteen slots
 * of 4K video is far more storage than fifteen PDFs, and a platform that only
 * counted files would be billed for the difference.
 *
 * 2GB is the floor for everybody, Pro Max included at 5GB (product owner, 31
 * Aug 2026). Pro deliberately gets the same 2GB as Basic — that is what was
 * asked for, and inventing a middle number to make the ladder look tidier
 * would be inventing a benefit nobody sells.
 */
export const STORAGE_ALLOWANCE_BY_TIER: Record<CreatorTier, number> = {
  basic: 2 * 1024 * 1024 * 1024,
  pro: 2 * 1024 * 1024 * 1024,
  pro_max: 5 * 1024 * 1024 * 1024,
};

/**
 * The floor for an account with no CreatorState row at all — somebody who has
 * never subscribed but can still upload a KYC document or an avatar. Without
 * this they would have either no quota (uploads impossible) or an unbounded
 * one (quota meaningless).
 */
export const DEFAULT_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

export function storageAllowanceFor(tier: CreatorTier | null | undefined): number {
  return tier ? STORAGE_ALLOWANCE_BY_TIER[tier] : DEFAULT_STORAGE_BYTES;
}
