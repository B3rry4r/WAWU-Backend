import type { NuvionDocumentType } from '../areas/documents';

/**
 * What a document upload really is, read from its first bytes (task NUV-03).
 * The type the client names (the part's content type, a file name) is never
 * trusted and never kept: Nuvion accepts PDF, JPG, JPEG and PNG
 * (api-reference__entities.md), and the type sent to it as `meta.file_type`
 * is the one found here.
 *
 * Only the framing is checked, not the picture: an ID photo can be far
 * larger than a selfie, and Nuvion reads and judges the content (its
 * `error_kyc_document_quality_insufficient` and the like come back as a
 * refusal). What this stops is a file that is plainly something else (HTML,
 * a ZIP, text) and a PDF cut short, before anything is sent.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from('%PDF-', 'latin1');
/** Readers look for the end marker in the last 1024 bytes; four times that is allowed. */
const PDF_EOF_TAIL = 4096;

export function sniffDocument(bytes: Buffer): NuvionDocumentType | null {
  if (bytes.length >= PNG.length && bytes.subarray(0, PNG.length).equals(PNG)) {
    return 'image/png';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (bytes.length >= PDF.length && bytes.subarray(0, PDF.length).equals(PDF)) {
    const tail = bytes.subarray(Math.max(0, bytes.length - PDF_EOF_TAIL));
    return tail.includes('%%EOF', 0, 'latin1') ? 'application/pdf' : null;
  }
  return null;
}
