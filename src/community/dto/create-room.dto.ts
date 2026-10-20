import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { CreateCommunityDto } from './create-community.dto';

/**
 * Body for POST /communities/rooms, the app's create: the web's body plus the
 * monthly price of a private room's pass (INBOX-24, R-63). POST /communities
 * keeps its own body, which the web calls.
 */
export class CreateRoomDto extends CreateCommunityDto {
  /**
   * What a member pays for 30 days, in kobo, set by the host (I32). Private
   * rooms only. The bounds are checked by the service (a figure of the
   * launch settings, COMMUNITY_PASS_MIN_KOBO and COMMUNITY_PASS_MAX_KOBO).
   * A private room must carry it (there is no host approval step, R-63):
   * left out, the answer is 400 "A private room needs a monthly price.".
   */
  @ApiPropertyOptional({ type: 'integer', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  passPriceKobo?: number;
}
