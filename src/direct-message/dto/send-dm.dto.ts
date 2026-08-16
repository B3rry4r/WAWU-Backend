import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /dm/:creatorWawuId/send per the task brief's frozen
 * contract. `text` is the only client-suppliable field — `amount` is always
 * looked up server-side from the target creator's CreatorState.dmPrice,
 * never accepted from the client (conventions.md § Identity & format canon),
 * mirroring src/purchase/dto/create-tip.dto.ts's precedent. Length cap
 * mirrors src/comment/dto/create-comment.dto.ts's precedent for a
 * free-text message body.
 */
export class SendDmDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;
}
