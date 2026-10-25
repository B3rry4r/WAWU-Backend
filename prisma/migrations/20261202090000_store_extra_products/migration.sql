-- IAP-03 (R-65, R-86, G-IAP-02-1): the upload pack, "Add 5 more products", is sold in the stores as a fifth
-- store product kind, `extra_products`. Additive only: one value added to the "StoreProductKind" enum. No table,
-- column, index or row is touched, and nothing the web or the dashboard calls reads the enum. The products a
-- purchase adds are written to the existing "MakerExtraProducts" row (keyed `store:<purchase id>`) and to
-- "MakerTier"."extraProducts", as the wallet path writes them.
-- The new value is not used in this file, so it may run in the migration's transaction.
ALTER TYPE "StoreProductKind" ADD VALUE IF NOT EXISTS 'extra_products';
