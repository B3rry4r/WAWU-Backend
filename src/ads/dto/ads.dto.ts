import { IsIn } from 'class-validator';

export const AD_PLACEMENTS = [
  'tgif_card',
  'today_slot',
  'explore_slider',
] as const;
export type AdPlacementName = (typeof AD_PLACEMENTS)[number];

/** GET /ads. The placement is required: there is no "any placement". */
export class ServeAdQueryDto {
  /**
   * `tgif_card` (the TGIF reader), `today_slot` (Today, TGIF off) or
   * `explore_slider` (the Explore slider, ADS-07: a list of cards, not one).
   */
  @IsIn(AD_PLACEMENTS)
  placement: AdPlacementName;
}
