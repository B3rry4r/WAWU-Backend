import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ASSISTANT_MESSAGE_MAX_CHARS } from '../legal-assistant-config';

/**
 * One message from the client: either words they typed (`body`) or a tap on
 * one of the thread's `quickReplies` (`quickReplyId`). Exactly one of the
 * two; both or neither is `400 message_empty`.
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
}
