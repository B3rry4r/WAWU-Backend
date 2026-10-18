import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * The longest link a message may carry. `POST /uploads/presign` hands back a
 * signed read link of 540 to 560 characters (the key, a bucket host and eleven
 * query parameters), so the 500 this route first allowed refused every real
 * upload; 2048 holds the longest link a browser keeps. Only the limit moves:
 * every link that was accepted still is.
 */
const MAX_LINK_LENGTH = 2048;

/**
 * Body for POST /communities/:id/messages per the frozen CommunityMessage
 * contract.
 *
 * EVERY field is optional INDIVIDUALLY but not together: a message is text,
 * a photo, a video or a voice note, or text with one of them, and never
 * neither. A message carries at most ONE of the three attachments (INBOX-22,
 * R-62: what it costs is that one kind's price). That either/or cannot be
 * expressed by a per-field decorator, so it is enforced in
 * CommunityMessageService.create (which owns the 400 and its wording) and
 * again by the `CommunityMessage_text_or_image` and
 * `CommunityMessage_one_attachment` CHECK constraints on the table.
 */
export class CreateCommunityMessageDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @Matches(/\S/, {
    message: 'text must contain at least one non-space character',
  })
  text?: string;

  /**
   * A photo posted in the room, as the `fileUrl` handed back by
   * `POST /uploads/presign` for the `community/message` folder — images only,
   * see FOLDER_CONTENT_TYPES.
   */
  @IsOptional()
  @IsUrl(
    // `require_tld: false` mirrors CreateContentDto's asset URLs: the storage
    // endpoint in development is a hostname with no dot in it. On its own
    // that also accepts a bare word like "not-a-url" as a hostname, so the
    // scheme is required and restricted — an `imageUrl` is a thing a browser
    // will be pointed at, and `javascript:` is not one of the two answers.
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'imageUrl must be a full link' },
  )
  @MaxLength(MAX_LINK_LENGTH)
  imageUrl?: string;

  /**
   * INBOX-22 (R-62). A video posted in the room, as the `fileUrl` handed back
   * by `POST /uploads/presign` for the `community/message-video` folder and
   * confirmed with `POST /uploads/confirm`. The service checks that the file
   * is the sender's own, from that folder, and has landed. Costs the video
   * price from admin settings.
   */
  @IsOptional()
  @IsUrl(
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'videoUrl must be a full link' },
  )
  @MaxLength(MAX_LINK_LENGTH)
  videoUrl?: string;

  /**
   * INBOX-22 (R-62). A voice note posted in the room, as the `fileUrl` of a
   * `community/message-voice` upload, checked as `videoUrl` is. Costs the
   * voice note price from admin settings.
   */
  @IsOptional()
  @IsUrl(
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'voiceUrl must be a full link' },
  )
  @MaxLength(MAX_LINK_LENGTH)
  voiceUrl?: string;
}
