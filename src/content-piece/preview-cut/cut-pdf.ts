import { PDFDocument } from 'pdf-lib';
import { CutRefusal, type CutResult, type CutSource } from './cut-types';

/**
 * R-118 (PREVIEW-AUTO round 1): the Hub makes a PDF piece's preview from its full file. The preview is the first 3 pages; a file
 * under 6 pages gets its first page. Plain JavaScript (`pdf-lib`, no native tool): the whole file is read once, the wanted pages
 * and only the fonts and pictures they use are copied into a new document, and that document is the preview. A one-page PDF has
 * nothing to keep back, so it is refused in words rather than "previewed" as itself.
 */
export const PREVIEW_PAGES = 3;
/** A file with fewer pages than this gets its first page only. */
export const SHORT_PDF_PAGES = 6;

/** How many pages the preview of a `total` page PDF holds. */
export const previewPagesFor = (total: number): number =>
  total < SHORT_PDF_PAGES ? 1 : PREVIEW_PAGES;

const MAGIC = Buffer.from('%PDF-');

export async function cutPdf(source: CutSource): Promise<CutResult> {
  if (source.length <= 0) throw new CutRefusal('unsupported');
  const whole = await source.read(0, source.length);
  // A few bytes of junk may sit before the header; the spec allows 1024.
  if (!whole.subarray(0, 1024).includes(MAGIC))
    throw new CutRefusal('unsupported');
  let from: PDFDocument;
  try {
    from = await PDFDocument.load(whole, { updateMetadata: false });
  } catch (err) {
    // pdf-lib's own error for a file with a password. It is compiled for old engines, so `instanceof` cannot tell it: its name and words do.
    if (
      err instanceof Error &&
      (err.constructor.name === 'EncryptedPDFError' ||
        /\bis encrypted\b/.test(err.message))
    )
      throw new CutRefusal('locked');
    throw new CutRefusal('unsupported');
  }
  const total = from.getPageCount();
  if (total < 1) throw new CutRefusal('unsupported');
  if (total === 1) throw new CutRefusal('single_page');
  const wanted = previewPagesFor(total);
  let body: Buffer;
  try {
    const to = await PDFDocument.create();
    const pages = await to.copyPages(
      from,
      Array.from({ length: wanted }, (_, i) => i),
    );
    for (const page of pages) to.addPage(page);
    body = Buffer.from(await to.save());
  } catch {
    throw new CutRefusal('unsupported');
  }
  return {
    body,
    contentType: 'application/pdf',
    seconds: 0,
    sourceSeconds: 0,
    pages: wanted,
    sourcePages: total,
  };
}
