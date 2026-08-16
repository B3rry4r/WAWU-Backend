import { IsBoolean, IsInt, Max, Min } from 'class-validator';

/**
 * PATCH /creator/dm-settings body (.pipeline/registry.json CreatorState
 * endpoint). `dmPrice` is validated server-side 50-500 naira per the
 * registry note (docs/02_TECHNICAL_CONTEXT.md §2: "dmPrice | integer
 * (₦50–500) | creator-set").
 */
export class UpdateDmSettingsDto {
  @IsBoolean()
  dmEnabled!: boolean;

  @IsInt()
  @Min(50)
  @Max(500)
  dmPrice!: number;
}
