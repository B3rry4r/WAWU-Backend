import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { StorageService, type UploadAllowanceView } from './storage.service';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { ReleaseUploadDto } from './dto/release-upload.dto';
import { uploadFormatsView, type UploadFormatsView } from './upload-formats';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';

/**
 * POST /uploads/presign — hands the authenticated caller a short-lived PUT
 * URL to upload one file straight to object storage, plus the URL that file
 * will be readable at. That returned `fileUrl` is what the client then sends
 * as `previewAsset` / `fullAsset` / `idDocumentUrl` on the real create call.
 *
 * Any signed-in account may request one; the object key is namespaced by the
 * caller's own wawuId so accounts cannot collide or overwrite each other.
 */
@UseGuards(WawuAuthGuard)
@Controller('uploads')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  presign(@CurrentUser() user: WawuJwtClaims, @Body() dto: PresignUploadDto) {
    return this.storage.presignUpload(
      user.sub,
      dto.folder,
      dto.contentType,
      dto.extension,
      dto.contentLength,
      dto.format,
    );
  }

  /**
   * GET /uploads/formats: what each content format may upload (M20 to M22):
   * the file types and the most bytes for the full file, and the same for the
   * separate public preview, with how that preview is shown and, for a clip,
   * how long it is asked to be. Any signed-in account. The same table
   * `POST /uploads/presign` applies when it is given a `format`.
   */
  @Get('formats')
  formats(): UploadFormatsView {
    return uploadFormatsView();
  }

  /**
   * POST /uploads/confirm: the app has finished sending the file it got a URL
   * for, taken or turned away by the storage host. The server asks the bucket
   * and answers `confirmed` (the file is there and counts against the person's
   * storage), `pending` (it is not there yet and the URL could still be used,
   * so nothing changes and the sweep settles it) or `abandoned` (it is not
   * there and the URL is spent, so the space it held goes back at once instead
   * of when the sweep settles it). A file that lands after it was given up on
   * and no longer fits the person's storage is removed and answers 413. The
   * app's word decides nothing; only the person's own upload can be settled. A
   * bucket that cannot be asked answers 503 and changes nothing.
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@CurrentUser() user: WawuJwtClaims, @Body() dto: ConfirmUploadDto) {
    return this.storage.settleUpload(user.sub, dto.key);
  }

  /**
   * GET /uploads/usage — how much creator-content space (content/preview and
   * content/full) this account has used of its allowance. Identity documents,
   * avatars and the other folders are not counted.
   *
   * Its own endpoint rather than a field on creator state, because storage is
   * not a creator-only concern: an account that has never subscribed still
   * uploads a KYC document and an avatar, and still has a ceiling. Hanging
   * it off creator state would leave every non-creator unable to see a limit
   * that applies to them.
   */
  @Get('usage')
  usage(@CurrentUser() user: WawuJwtClaims) {
    return this.storage.usageFor(user.sub);
  }

  /**
   * GET /uploads/allowance: the upload count and the storage this account
   * may use, what it has used, and both of R-7's levels (free and with a
   * tick). Any signed-in account: an account with no CreatorState row has
   * used 0 uploads.
   */
  @Get('allowance')
  allowance(@CurrentUser() user: WawuJwtClaims): Promise<UploadAllowanceView> {
    return this.storage.allowanceFor(user.sub);
  }

  /**
   * POST /uploads/release: takes back an upload the caller reserved and no
   * listing has claimed yet (a file removed or replaced in an unfinished
   * draft). Deletes the object and frees its space in one step. Only the
   * caller's own upload in content/preview or content/full; another person's
   * key, an unknown key and a key in any other folder all get the same 404,
   * and a key a listing already uses gets a 409. Calling it again for a key
   * already released answers the same 200.
   */
  @Post('release')
  @HttpCode(HttpStatus.OK)
  release(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ReleaseUploadDto,
  ): Promise<{ released: true }> {
    return this.storage.releaseUpload(user.sub, dto.key);
  }
}
