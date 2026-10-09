import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdentityHasher } from '../../money/identity/identity-config';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { PersonWindowLimiter } from '../../money/person-window-limiter';
import {
  NUVION_DOCUMENT_KINDS,
  NUVION_DOCUMENT_MAX_BYTES,
  NUVION_DOCUMENT_TYPES,
  type NuvionDocumentKind,
} from '../areas/documents';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import { DocumentError } from './document-errors';
import { sniffDocument } from './document-file';
import {
  DOCUMENT_UPLOAD_WINDOWS,
  LIVENESS_START_WINDOWS,
  MSG,
  returnAddressAllowed,
} from './documents-config';
import { DocumentsFlow } from './documents-flow';
import type {
  IdentityDocumentsView,
  IdentityLivenessView,
} from './documents-view.type';
import type { UploadedPart } from './documents-upload.interceptor';

/** The text fields of an upload. */
const UPLOAD_FIELDS = new Set(['kind', 'side']);

/**
 * The document and selfie routes' rules (task NUV-03): what a request may
 * carry, who may send what, and the limits. The work is DocumentsFlow's.
 * Under a provider that reviews no documents (Fintava) the routes exist and
 * answer that nothing is needed.
 */
@Injectable()
export class NuvionDocumentsService {
  private readonly uploads = new PersonWindowLimiter(
    DOCUMENT_UPLOAD_WINDOWS,
    (s) =>
      new DocumentError('document_rate_limited', MSG.rateLimited, {
        retryAfterSeconds: s,
      }),
  );
  private readonly sessions = new PersonWindowLimiter(
    LIVENESS_START_WINDOWS,
    (s) =>
      new DocumentError('document_rate_limited', MSG.rateLimited, {
        retryAfterSeconds: s,
      }),
  );
  private flowOf: DocumentsFlow | null | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly hasher: IdentityHasher,
  ) {}

  /** The flow when the running provider is Nuvion; null otherwise. */
  private flow(): DocumentsFlow | null {
    if (this.flowOf === undefined) {
      this.flowOf =
        this.provider instanceof NuvionWalletProvider
          ? new DocumentsFlow(this.prisma, this.provider, this.hasher)
          : null;
    }
    return this.flowOf;
  }

  /** Nothing to upload: this wallet's provider reviews no documents. */
  private static nothingNeeded(): IdentityDocumentsView {
    return {
      required: false,
      open: false,
      documents: NUVION_DOCUMENT_KINDS.map((kind) => ({
        kind,
        state: 'missing' as const,
        sides: [],
        uploadedAt: null,
      })),
      selfie: 'not_used',
      submitted: false,
      submittedAt: null,
      waitingFor: [],
      maxBytes: NUVION_DOCUMENT_MAX_BYTES,
      acceptedTypes: [...NUVION_DOCUMENT_TYPES],
    };
  }

  view(wawuUserId: string): Promise<IdentityDocumentsView> {
    const flow = this.flow();
    return flow
      ? flow.view(wawuUserId)
      : Promise.resolve(NuvionDocumentsService.nothingNeeded());
  }

  /** One document: checked here, sent once by the flow, the documents view after. */
  async upload(
    wawuUserId: string,
    parts: { file?: UploadedPart[]; file_back?: UploadedPart[] } | undefined,
    fields: unknown,
  ): Promise<IdentityDocumentsView> {
    const flow = this.flow();
    if (flow === null) {
      throw new DocumentError('documents_closed', MSG.notNeeded);
    }
    const body = fields && typeof fields === 'object' ? fields : {};
    for (const key of Object.keys(body)) {
      if (!UPLOAD_FIELDS.has(key)) {
        throw new DocumentError('document_request_invalid', MSG.badPart);
      }
    }
    const { kind, side } = body as { kind?: unknown; side?: unknown };
    if (
      typeof kind !== 'string' ||
      !(NUVION_DOCUMENT_KINDS as readonly string[]).includes(kind)
    ) {
      throw new DocumentError('document_request_invalid', MSG.badKind);
    }
    // The two sides of an ID go in one request (`file`, `file_back`): Nuvion
    // takes them in one call and WAWU keeps no copy to hold a front. A
    // lone back would be taken for a front.
    if (side !== undefined && side !== 'front') {
      throw new DocumentError('document_request_invalid', MSG.sidesTogether);
    }
    const front = parts?.file?.[0]?.buffer;
    const back = parts?.file_back?.[0]?.buffer ?? null;
    if (front === undefined) {
      throw new DocumentError('document_request_invalid', MSG.noFile);
    }
    if (back !== null && kind !== 'identity') {
      throw new DocumentError('document_request_invalid', MSG.backOnlyId);
    }
    if (front.length === 0 || (back !== null && back.length === 0)) {
      throw new DocumentError('document_file_invalid', MSG.fileEmpty);
    }
    if (
      front.length > NUVION_DOCUMENT_MAX_BYTES ||
      (back !== null && back.length > NUVION_DOCUMENT_MAX_BYTES)
    ) {
      throw new DocumentError('document_file_invalid', MSG.fileTooBig);
    }
    const mimeType = sniffDocument(front);
    if (mimeType === null) {
      throw new DocumentError('document_file_invalid', MSG.fileType);
    }
    if (back !== null && sniffDocument(back) !== mimeType) {
      throw new DocumentError(
        'document_file_invalid',
        sniffDocument(back) === null ? MSG.fileType : MSG.sidesDiffer,
      );
    }
    this.uploads.take(wawuUserId);
    await flow.upload(wawuUserId, {
      kind: kind as NuvionDocumentKind,
      front,
      back,
      mimeType,
    });
    return flow.snapshot(wawuUserId);
  }

  livenessView(wawuUserId: string): Promise<IdentityLivenessView> {
    const flow = this.flow();
    return flow
      ? flow.livenessView(wawuUserId)
      : Promise.resolve({
          enabled: false,
          state: 'not_in_use',
          url: null,
          startedAt: null,
          canStart: false,
        });
  }

  async startLiveness(
    wawuUserId: string,
    redirectUrl: string | undefined,
  ): Promise<IdentityLivenessView> {
    const flow = this.flow();
    if (flow === null) {
      throw new DocumentError('selfie_not_available', MSG.selfieOff);
    }
    const returnTo = this.returnAddress(flow, redirectUrl);
    this.sessions.take(wawuUserId);
    return flow.startLiveness(wawuUserId, returnTo);
  }

  /**
   * The return address: none is fine (nothing is sent); an address must be
   * one the server lists, by origin and path prefix. An empty list allows
   * no address at all.
   */
  private returnAddress(
    flow: DocumentsFlow,
    value: string | undefined,
  ): string | null {
    if (value === undefined || value.trim() === '') return null;
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new DocumentError('document_request_invalid', MSG.badReturn);
    }
    if (!returnAddressAllowed(url, flow.livenessRedirectOrigins)) {
      throw new DocumentError('document_request_invalid', MSG.badReturn);
    }
    return url.toString();
  }
}
