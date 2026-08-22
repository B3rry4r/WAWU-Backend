import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Body for POST /communities/:id/messages per the frozen CommunityMessage
 * contract.
 *
 * BOTH fields are optional INDIVIDUALLY but not together: a message is text,
 * an image, or both, and never neither. That either/or cannot be expressed by
 * a per-field decorator, so it is enforced in CommunityMessageService.create
 * (which owns the 400 and its wording) and again by the
 * `CommunityMessage_text_or_image` CHECK constraint on the table.
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
    { require_tld: false, require_protocol: true, protocols: ['http', 'https'] },
    { message: 'imageUrl must be a full link' },
  )
  @MaxLength(500)
  imageUrl?: string;
}
