-- ADS-07 (R-59): the Explore slider is a third place a sponsored card shows.
-- Additive: a new enum label; no row, column or constraint changes. Campaigns
-- already saved without artwork stay as they are (the column stays nullable);
-- serving skips them and the admin list shows them for fixing.
ALTER TYPE "AdPlacement" ADD VALUE IF NOT EXISTS 'explore_slider';
