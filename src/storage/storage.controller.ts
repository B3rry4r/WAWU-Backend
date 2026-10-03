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
    );
  }

  /**
   * GET /uploads/usage — how much space this account has used of its
   * allowance.
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
}
