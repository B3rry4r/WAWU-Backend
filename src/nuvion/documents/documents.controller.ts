import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { BuiltBy } from '../../money/money-contract';
import { NUVION_DOCUMENT_KINDS } from '../areas/documents';
import { DocumentErrors } from './document-errors';
import { StartLivenessDto } from './documents-request.dto';
import { DocumentUploadInterceptor } from './documents-upload.interceptor';
import type { UploadedPart } from './documents-upload.interceptor';
import { NuvionDocumentsService } from './documents.service';
import type {
  IdentityDocumentsView,
  IdentityLivenessView,
} from './documents-view.type';

/**
 * Open your wallet's documents and selfie step (task NUV-03, R-42, R-39):
 * the ID document and the proof of address Nuvion needs before it reviews
 * a person, and Nuvion's hosted selfie when it is in use.
 *
 * The caller is the token: no route takes a wawuUserId or a Nuvion id, so
 * nobody can read or change another person's documents. These routes are
 * part of opening, so they are not behind the wallet gate (they are where
 * it leads); a person with no opening started gets the same
 * `409 wallet_not_open` every wallet route gives. Every answer is
 * `no-store`.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money/identity')
export class NuvionDocumentsController {
  constructor(private readonly documents: NuvionDocumentsService) {}

  /**
   * Where the opening's documents stand: both kinds, whether uploads are
   * open, what is still needed before the opening is sent for review. When
   * the documents are in and the opening is due to be sent (or its sending
   * was lost), this sends it, once.
   */
  @Get('documents')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-03')
  @DocumentErrors('wallet_not_open', 'provider_unreachable')
  getDocuments(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<IdentityDocumentsView> {
    return this.documents.view(user.sub);
  }

  /**
   * Sends one document to Nuvion, once: multipart with `kind` (`identity`
   * or `proof_of_address`) and `file` (a PDF, JPG or PNG up to 10 MB). An
   * ID with a back side sends it as `file_back` in the same request, of
   * the same type. The same file sent twice is forwarded once; a different
   * file replaces the first while the opening is still taking documents.
   * When both documents are in (and the selfie has passed, when in use) the
   * opening is sent for review, once. WAWU keeps no copy of any file.
   * Answers the documents view.
   */
  @Post('documents')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(DocumentUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['kind', 'file'],
      properties: {
        kind: { type: 'string', enum: [...NUVION_DOCUMENT_KINDS] },
        file: { type: 'string', format: 'binary' },
        file_back: { type: 'string', format: 'binary' },
      },
    },
  })
  @BuiltBy('NUV-03')
  @DocumentErrors(
    'document_request_invalid',
    'document_file_invalid',
    'document_not_accepted',
    'documents_closed',
    'document_in_progress',
    'document_rate_limited',
    'document_busy',
    'wallet_not_open',
    'provider_unreachable',
    'identity_under_review',
  )
  uploadDocument(
    @CurrentUser() user: WawuJwtClaims,
    @UploadedFiles()
    files: { file?: UploadedPart[]; file_back?: UploadedPart[] } | undefined,
    @Body() fields: Record<string, unknown>,
  ): Promise<IdentityDocumentsView> {
    return this.documents.upload(user.sub, files, fields);
  }

  /**
   * The hosted selfie: whether it is in use, where it stands, and the
   * secure page to open or resume while it is pending. Reads the result
   * from Nuvion; a pass is saved on the opening, which is then sent for
   * review when everything else is in.
   */
  @Get('liveness')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-03')
  @DocumentErrors('wallet_not_open', 'provider_unreachable')
  getLiveness(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<IdentityLivenessView> {
    return this.documents.livenessView(user.sub);
  }

  /**
   * Starts the hosted selfie (or answers the one already running) and
   * returns the secure page to open. `redirectUrl` is where that page sends
   * the person back: the app's link or the website, https only. When
   * Nuvion will not start a selfie for this person, the opening goes on
   * without one and this answers `selfie_not_available`.
   */
  @Post('liveness')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-03')
  @DocumentErrors(
    'document_request_invalid',
    'documents_closed',
    'document_in_progress',
    'document_rate_limited',
    'selfie_not_available',
    'wallet_not_open',
    'provider_unreachable',
  )
  startLiveness(
    @CurrentUser() user: WawuJwtClaims,
    @Body() body: StartLivenessDto,
  ): Promise<IdentityLivenessView> {
    return this.documents.startLiveness(user.sub, body.redirectUrl);
  }
}
