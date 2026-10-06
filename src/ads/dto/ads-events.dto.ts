import { IsIn } from 'class-validator';

/** What a person did with the card: opened it, tapped its button, skipped it. */
export const AD_EVENT_TYPES = ['view', 'tap', 'skip'] as const;
export type AdEventTypeName = (typeof AD_EVENT_TYPES)[number];

/** POST /ads/:id/events. The one field is required; nothing else is accepted. */
export class RecordAdEventDto {
  @IsIn(AD_EVENT_TYPES)
  type: AdEventTypeName;
}
