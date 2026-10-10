import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { finalize, type Observable } from 'rxjs';
import { NUVION_DOCUMENT_MAX_BYTES } from '../areas/documents';
import { DocumentError } from './document-errors';
import { MSG } from './documents-config';
import { DocumentUploadSlots } from './documents-slots';

/** The two file parts a document upload takes. */
export const DOCUMENT_UPLOAD_FIELDS = [
  { name: 'file', maxCount: 1 },
  { name: 'file_back', maxCount: 1 },
] as const;

/** A file part as the route reads it: bytes in memory, nothing else is used. */
export interface UploadedPart {
  buffer: Buffer;
  size: number;
}

/**
 * Reads the multipart body of `POST /money/identity/documents` into memory
 * (task NUV-03): at most two files of Nuvion's 10 MB limit each, a few short
 * text fields, nothing written to disk. A place is taken first
 * (DocumentUploadSlots), and given back when the request ends.
 *
 * Nest's own file interceptor answers a file over the limit with a 413 and
 * a bare message; here every refusal in reading the body carries a
 * `reason.code` (422 `document_file_invalid` for a file over 10 MB, 400
 * `document_request_invalid` for anything else malformed), before the
 * route, and so before any call to Nuvion.
 */
@Injectable()
export class DocumentUploadInterceptor implements NestInterceptor {
  private readonly inner: NestInterceptor = new (FileFieldsInterceptor(
    [...DOCUMENT_UPLOAD_FIELDS],
    {
      limits: {
        // The reader stops a file when it REACHES this size, so a file of
        // exactly 10 MB (Nuvion's limit) needs one byte more; the route
        // refuses anything over 10 MB itself.
        fileSize: NUVION_DOCUMENT_MAX_BYTES + 1,
        files: 2,
        fields: 4,
        parts: 6,
        fieldSize: 256,
        fieldNameSize: 40,
        headerPairs: 40,
      },
    },
  ))();

  constructor(private readonly slots: DocumentUploadSlots) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const release = await this.slots.acquire();
    try {
      const stream = await this.inner.intercept(context, next);
      return stream.pipe(finalize(release));
    } catch (e) {
      release();
      throw this.refusal(e);
    }
  }

  private refusal(e: unknown): unknown {
    if (e instanceof DocumentError) return e;
    if (e instanceof PayloadTooLargeException) {
      return new DocumentError('document_file_invalid', MSG.fileTooBig);
    }
    if (e instanceof HttpException && e.getStatus() === 400) {
      return new DocumentError('document_request_invalid', MSG.badPart);
    }
    return e;
  }
}
