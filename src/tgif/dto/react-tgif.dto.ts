import { IsIn, ValidateIf } from 'class-validator';
import {
  TGIF_CARDS,
  TGIF_REACTION_KINDS,
  type TgifCard,
  type TgifReactionKind,
} from '../tgif.constants';

/** Body of POST /tgif/:date/react. */
export class ReactTgifDto {
  /** Which card: verse, reality, remember, prayer or takeaway. */
  @IsIn(TGIF_CARDS)
  card: TgifCard;

  /** What the person says to it. Defaults to "amen", the only reaction. */
  // Absent is fine; an explicit null is not (IsOptional would let it through).
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(TGIF_REACTION_KINDS)
  kind?: TgifReactionKind;
}
