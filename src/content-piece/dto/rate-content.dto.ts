import { IsInt, Max, Min } from 'class-validator';

/**
 * Body for POST /content/:id/rate per registry.json ContentPiece contract.
 * `rating` is a 1-5 star value; the service converts to the stored
 * `ratingPct` (0-100) aggregate.
 */
export class RateContentDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;
}
