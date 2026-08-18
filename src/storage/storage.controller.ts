import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { StorageService } from './storage.service';
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
    return this.storage.presignUpload(user.sub, dto.folder, dto.contentType, dto.extension, dto.contentLength);
  }
}
