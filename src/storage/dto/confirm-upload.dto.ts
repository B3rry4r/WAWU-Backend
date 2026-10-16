import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * POST /uploads/confirm: the app says it has finished sending one file to the
 * URL POST /uploads/presign gave it, whether the storage host took the file or
 * turned it away. The server asks the bucket what is really there; the app's
 * word decides nothing.
 */
export class ConfirmUploadDto {
  /**
   * The `key` or the `fileUrl` POST /uploads/presign returned for this file.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  key: string;
}
