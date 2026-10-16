import { IsIn } from 'class-validator';

export const AD_PLACEMENTS = ['tgif_card', 'today_slot'] as const;
export type AdPlacementName = (typeof AD_PLACEMENTS)[number];

/** GET /ads. The placement is required: there is no "any placement". */
export class ServeAdQueryDto {
  /** `tgif_card` (the TGIF reader) or `today_slot` (Today, TGIF off). */
  @IsIn(AD_PLACEMENTS)
  placement: AdPlacementName;
}
