import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CHAT_FOLDER_CONTENT_TYPES, CHAT_LIMITS } from '../chat-limits';

/** POST /chats: open the chat with one person, or get the one that exists. */
export class OpenChatDto {
  /** The other person's WAWU ID (uuid). */
  @IsUUID()
  wawuId: string;
}

/** The cursor-paged query both chat lists take. */
export class ChatPageQueryDto {
  /** Opaque: send back the `nextCursor` of the previous page as given. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** 1 to 100, 20 when left out. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ChatAttachmentDto {
  /** The `key` POST /chats/:chatId/attachments returned, after the upload. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  key: string;

  /** The file's own name, shown on a PDF bubble. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;
}

/**
 * POST /chats/:chatId/messages. Text, an attachment, or both; never neither
 * (the service answers 400 for that, as no single field can say it).
 */
export class ChatSendMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(CHAT_LIMITS.textMaxLength)
  @Matches(/\S/, {
    message: 'text must contain at least one non-space character',
  })
  text?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChatAttachmentDto)
  attachment?: ChatAttachmentDto;

  /**
   * The app's own id for this message. Sending the same one again returns
   * the message already stored instead of posting it twice.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, {
    message: 'clientMessageId must be 8 to 64 letters, digits, - or _',
  })
  clientMessageId?: string;
}

/** POST /chats/:chatId/read. Leave `messageId` out to mark everything read. */
export class MarkChatReadDto {
  @IsOptional()
  @IsUUID()
  messageId?: string;
}

const CHAT_ATTACHMENT_TYPES: string[] = Object.values(
  CHAT_FOLDER_CONTENT_TYPES,
).flat();

/** POST /chats/:chatId/attachments: ask where to upload one photo, video or PDF. */
export class ChatUploadDto {
  /** image/png, image/jpeg, image/webp, video/mp4, video/quicktime or application/pdf. */
  @IsIn(CHAT_ATTACHMENT_TYPES)
  contentType: string;

  /** Exact size in bytes; the upload link is signed for this length. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  contentLength: number;
}
