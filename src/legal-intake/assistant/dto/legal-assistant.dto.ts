import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ChatAttachmentDto } from '../../../chat/dto/chat.dto';
import { ASSISTANT_MESSAGE_MAX_CHARS } from '../legal-assistant-config';

/**
 * One message from the client: words they typed (`body`), a tap on one of the
 * thread's `quickReplies` (`quickReplyId`), or a file they uploaded for their
 * matter (`attachment`, R2-LEGAL3). Exactly one of the three; none or more
 * than one is `400 message_empty`.
 */
export class SendAssistantMessageDto {
  /** What the client typed. At most 2000 characters. */
  @IsOptional()
  @IsString()
  @MaxLength(ASSISTANT_MESSAGE_MAX_CHARS)
  body?: string;

  /** The `id` of one of the thread's live `quickReplies`. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9_:]+$/)
  quickReplyId?: string;

  /**
   * A photo, video or PDF uploaded through `POST /legal/assistant/{id}/attachments`
   * for this conversation's matter: the `key` that call answered with, and the
   * file's name for a PDF. Only once the matter exists, and not on its own
   * with words.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => ChatAttachmentDto)
  attachment?: ChatAttachmentDto;
}

/** "Start this request" (S26): the first name choice the person typed. */
export class StartFixedPriceDto {
  /** The business name the person wants first. 2 to 120 characters. */
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  firstNameChoice!: string;
}
