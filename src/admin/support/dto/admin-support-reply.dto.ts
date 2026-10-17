import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CHAT_LIMITS } from '../../../chat/chat-limits';

/**
 * POST /admin/support/threads/:chatId/messages. A staff reply is text only:
 * the same length rule as a chat message, and no file. (A file in a chat has
 * to be an upload of the sender's own, and the support account uploads
 * nothing, so an attachment here could never have worked.)
 */
export class AdminSupportReplyDto {
  @IsString()
  @MaxLength(CHAT_LIMITS.textMaxLength)
  @Matches(/\S/, {
    message: 'text must contain at least one non-space character',
  })
  text: string;

  /**
   * The dashboard's own id for this reply. Sending the same one again returns
   * the reply already stored instead of posting it twice.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, {
    message: 'clientMessageId must be 8 to 64 letters, digits, - or _',
  })
  clientMessageId?: string;
}
