import { HttpException } from '@nestjs/common';
import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse } from '@nestjs/swagger';

/**
 * The refusals of the document and selfie routes (task NUV-03), in the
 * money contract's one error shape (docs/contract/CONVENTIONS.md section 3):
 * `{ statusCode, message, data: null, reason: { code, message, ... } }`, the
 * app switching on `reason.code`. The routes also answer four codes the
 * money contract already has (`wallet_not_open`, `not_found`,
 * `provider_unreachable`, `identity_under_review`), through MoneyError.
 *
 * The codes are this task's own and live here, not in the money contract's
 * shared lists, so no other task's edit of those lists meets them; each
 * route's contract entry (`DocumentErrors`) lists every code it can answer.
 *
 * `message` is a plain sentence the app may show as it is: no em-dash, no
 * provider name, nothing the caller sent.
 */
export const DOCUMENT_ERROR_STATUS = {
  /** A field is missing or unreadable: no `kind`, no file, an unknown part, a bad return address. */
  document_request_invalid: 400,
  /** The file is empty, over 10 MB, not a PDF, JPG or PNG, or the two sides differ in type. */
  document_file_invalid: 422,
  /** Nuvion read the file or the details and refused them; nothing was kept. */
  document_not_accepted: 422,
  /** The opening is not taking documents now (already sent, approved, stopped), or this wallet needs none. */
  documents_closed: 409,
  /** The last upload of this kind is still being confirmed; try again after `retryAfterSeconds`. */
  document_in_progress: 409,
  /** The person has sent too many files in a short time. */
  document_rate_limited: 429,
  /** The server is busy with other uploads. */
  document_busy: 503,
  /** The hosted selfie is not part of this opening (not in use, or Nuvion would not start one). */
  selfie_not_available: 409,
} as const;
export type DocumentErrorCode = keyof typeof DOCUMENT_ERROR_STATUS;

/** The codes of the money contract these routes also answer. */
export const SHARED_DOCUMENT_ERROR_CODES = [
  'wallet_not_open',
  'not_found',
  'provider_unreachable',
  'identity_under_review',
] as const;
export type SharedDocumentErrorCode =
  (typeof SHARED_DOCUMENT_ERROR_CODES)[number];

const SHARED_STATUS: Record<SharedDocumentErrorCode, number> = {
  wallet_not_open: 409,
  not_found: 404,
  provider_unreachable: 503,
  identity_under_review: 409,
};

export class DocumentError extends HttpException {
  readonly code: DocumentErrorCode;

  constructor(
    code: DocumentErrorCode,
    message: string,
    detail: { retryAfterSeconds?: number } = {},
  ) {
    super(
      { message, reason: { code, message, ...detail } },
      DOCUMENT_ERROR_STATUS[code],
    );
    this.code = code;
  }
}

/** The reason of a refused document or selfie request. */
export class DocumentErrorReason {
  @ApiProperty({
    enum: [
      ...Object.keys(DOCUMENT_ERROR_STATUS),
      ...SHARED_DOCUMENT_ERROR_CODES,
    ],
  })
  code!: DocumentErrorCode | SharedDocumentErrorCode;

  /** A sentence the app may show as it is. */
  message!: string;

  /** document_in_progress, document_rate_limited, document_busy, provider_unreachable: seconds to wait before trying again. */
  retryAfterSeconds?: number;
}

/** The body of every refused document or selfie request. */
export class DocumentErrorEnvelope {
  /** The HTTP status again. */
  statusCode!: number;

  /** Same as reason.message. */
  message!: string;

  /** Always null on an error. */
  @ApiProperty({ nullable: true, type: Object, example: null })
  data!: null;

  reason!: DocumentErrorReason;
}

/**
 * Documents the refusals a route can answer with: one response per HTTP
 * status, its description listing the `reason.code` values, its body the
 * one error envelope.
 */
export function DocumentErrors(
  ...codes: Array<DocumentErrorCode | SharedDocumentErrorCode>
): MethodDecorator {
  const byStatus = new Map<number, string[]>();
  for (const code of new Set(codes)) {
    const status =
      code in DOCUMENT_ERROR_STATUS
        ? DOCUMENT_ERROR_STATUS[code as DocumentErrorCode]
        : SHARED_STATUS[code as SharedDocumentErrorCode];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return applyDecorators(
    ApiExtraModels(DocumentErrorEnvelope),
    ...[...byStatus.entries()]
      .sort(([a], [b]) => a - b)
      .map(([status, list]) =>
        ApiResponse({
          status,
          description: `reason.code: ${list.join(', ')}`,
          type: DocumentErrorEnvelope,
        }),
      ),
  );
}
