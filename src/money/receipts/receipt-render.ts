import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflate } from 'node:zlib';
import { renderAsync, type ResvgRenderOptions } from '@resvg/resvg-js';
import { RECEIPT_TOKENS, type ReceiptTone } from '../../styles/tokens-receipt';
import { REFERENCE_LABEL, type ReceiptDocument } from './receipt-document';
import { FontMetrics } from './receipt-font-metrics';

const deflateAsync = promisify(deflate);

/**
 * Drawing a receipt (task WALLET-18, W42 and W43). One layout, drawn as SVG
 * and rasterised by @resvg/resvg-js (a prebuilt binary for Linux x64 glibc,
 * the droplet's Ubuntu 24.04, with no system libraries or fonts needed):
 *
 * - **Image** (W42): the white receipt, 3 pixels per point, as PNG.
 * - **PDF** (W43): one A4 page with the receipt on it, the page drawn at
 *   200 dots an inch and wrapped in a PDF written here (no PDF library: a
 *   page, one image and, when the public host is set, a link over the
 *   "Check it at" line). Text in the PDF is part of the picture, so it is
 *   not selectable.
 *
 * Round 2: a draw is bounded. Every printed string is cleaned of what XML
 * cannot carry and cut to MAX_PRINTED characters first; lines are measured
 * from the fonts' own width tables (receipt-font-metrics.ts), never by the
 * renderer; and the picture is drawn and compressed on libuv's thread pool
 * (`renderAsync`, `zlib.deflate`), so the server keeps answering while it
 * draws.
 *
 * The fonts are Alan Sans with a naira sign added (`assets/receipt/fonts`,
 * scripts/receipt/build-receipt-fonts.py); system fonts are never loaded, so
 * the server draws the same receipt wherever it runs. The mark is the brand
 * pack's submark (R-37, `assets/receipt/submark.svg`), the ink artwork for a
 * light surface.
 */

const FAMILY = 'WMT Receipt Sans';

/** The receipt's width in points, as the canvas draws it (W41 to W43). */
export const RECEIPT_WIDTH = 360;
const PAD_X = 20;
const PAD_TOP = 22;
const PAD_BOTTOM = 22;
const ROW_HEIGHT = 35;
const FOOTER_LINE = 15;
/** A value's second and third lines. */
const VALUE_LINE = 17;

/** Pixels per point in the PNG. */
export const IMAGE_SCALE = 3;

/** A4 in points, and the scale the receipt is set at on it. */
export const A4 = { width: 595.28, height: 841.89 } as const;
const PDF_CARD_SCALE = 1.25;
const PDF_TOP = 72;
const PDF_DPI = 200;

/** The repo's root: the folder above this file that holds package.json (src/ in tests, dist/src/ when built). */
function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir)
      throw new Error(
        'Receipt assets: package.json not found above ' + __dirname,
      );
    dir = up;
  }
  return dir;
}

const ASSETS = join(repoRoot(), 'assets', 'receipt');
const WEIGHTS = { 400: 'Regular', 600: 'SemiBold', 700: 'Bold' } as const;
type Weight = keyof typeof WEIGHTS;
const FONT_FILES = Object.values(WEIGHTS).map((w) =>
  join(ASSETS, 'fonts', `WMTReceiptSans-${w}.ttf`),
);
const METRICS = Object.fromEntries(
  Object.entries(WEIGHTS).map(([weight, name]) => [
    weight,
    new FontMetrics(
      readFileSync(join(ASSETS, 'fonts', `WMTReceiptSans-${name}.ttf`)),
    ),
  ]),
) as unknown as Record<Weight, FontMetrics>;

/** No printed string is longer than this: the ledger keeps names up to 500 characters. */
export const MAX_PRINTED = 160;
const MARK = `data:image/svg+xml;base64,${readFileSync(join(ASSETS, 'submark.svg')).toString('base64')}`;
/** The submark's own proportions (1170.16 x 1276.39). */
const MARK_W = 24;
const MARK_H = (MARK_W * 1276.39) / 1170.16;

const TONE: Record<ReceiptTone, string> = {
  positive: RECEIPT_TOKENS.positive,
  warning: RECEIPT_TOKENS.warning,
  danger: RECEIPT_TOKENS.danger,
  ink: RECEIPT_TOKENS.ink,
};

/**
 * Everything XML 1.0 cannot carry is dropped (C0 controls, lone surrogates,
 * U+FFFE and U+FFFF), and the other control characters too; a tab or a line
 * break becomes a space, as a receipt line is one line. Then NFC, and at
 * most 2 combining marks (`\p{M}`) on any one character.
 */
export function printable(s: string): string {
  return (
    s
      .replace(/[\t\n\r]/g, ' ')
      .replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
        '',
      )
      .normalize('NFC')
      // At most MAX_MARKS combining marks on one character: a stack of
      // hundreds would draw up over the rest of the receipt (D4).
      .replace(/(\p{M}{2})\p{M}+/gu, '$1')
  );
}

/** Text for SVG or HTML: printable, with &, <, >, " and ' escaped. */
export function escapeXml(s: string): string {
  return printable(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A string as it is printed: printable, and at most MAX_PRINTED characters. */
export function clip(s: string, max = MAX_PRINTED): string {
  const chars = [...printable(s)];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : chars.join('');
}

/** The longest reference the ledger keeps (ledger.service.ts MAX_REFERENCE): drawn whole. */
export const MAX_REFERENCE = 200;

/** How wide `value` is drawn, in points, from the font's width table. */
export function textWidth(
  value: string,
  size: number,
  weight: Weight = 400,
): number {
  return METRICS[weight].width(value, size);
}

/** The text cut to fit `width`, with an ellipsis when cut. One pass over it. */
export function fit(
  value: string,
  size: number,
  width: number,
  weight: Weight = 400,
): string {
  if (textWidth(value, size, weight) <= width) return value;
  const room = width - textWidth('…', size, weight);
  let out = '';
  for (const ch of value) {
    if (textWidth(out + ch, size, weight) > room) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/**
 * The text on lines no wider than `width`: broken between words, and a
 * word too long for one line (a reference) broken between characters. At
 * most `max` lines; only text beyond them is cut, with an ellipsis. Each
 * character is measured once.
 */
export function wrap(
  value: string,
  size: number,
  width: number,
  weight: Weight = 400,
  max = 3,
): string[] {
  const lines: string[] = [];
  let line = '';
  let used = 0;
  const space = textWidth(' ', size, weight);
  for (const word of value.split(' ')) {
    const w = textWidth(word, size, weight);
    if (line && used + space + w <= width) {
      line += ` ${word}`;
      used += space + w;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    used = 0;
    for (const ch of word) {
      const cw = textWidth(ch, size, weight);
      if (line && used + cw > width) {
        lines.push(line);
        line = '';
        used = 0;
      }
      line += ch;
      used += cw;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = fit(`${kept[max - 1]} ${lines[max]}`, size, width, weight);
  return kept;
}

let clipSeq = 0;

/**
 * One line of text, clipped to its own box: the receipt's content width,
 * and the line's height (from 1.15 em above the baseline to 0.4 em below).
 * Whatever a font or a mark does, a line never draws over another line or
 * past the content edge.
 */
function text(
  x: number,
  y: number,
  value: string,
  o: {
    size: number;
    weight?: Weight;
    fill: string;
    anchor?: 'start' | 'middle' | 'end';
    spacing?: number;
  },
): string {
  clipSeq = (clipSeq + 1) % 1_000_000;
  const id = `l${clipSeq}`;
  const top = y - o.size * 1.15;
  const box = `<clipPath id="${id}"><rect x="${PAD_X}" y="${top.toFixed(2)}" width="${RECEIPT_WIDTH - 2 * PAD_X}" height="${(o.size * 1.55).toFixed(2)}"/></clipPath>`;
  return `${box}<text clip-path="url(#${id})" x="${x}" y="${y}" font-family="${FAMILY}" font-size="${o.size}" font-weight="${o.weight ?? 400}" fill="${o.fill}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}>${escapeXml(value)}</text>`;
}

/** The receipt as SVG content at RECEIPT_WIDTH, with its height and where the footer's link sits. */
export function receiptCard(raw: ReceiptDocument): {
  svg: string;
  height: number;
  footer: { top: number; bottom: number };
} {
  // Every string printable and of bounded length before anything is measured.
  const doc: ReceiptDocument = {
    ...raw,
    title: clip(raw.title),
    dateText: clip(raw.dateText),
    headline: clip(raw.headline),
    amountText: clip(raw.amountText),
    statusText: clip(raw.statusText),
    lines: raw.lines.map((l) => ({
      label: clip(l.label),
      value: clip(
        l.value,
        l.label === REFERENCE_LABEL ? MAX_REFERENCE : MAX_PRINTED,
      ),
    })),
    footer: clip(raw.footer),
  };
  const W = RECEIPT_WIDTH;
  const inner = W - 2 * PAD_X;
  const parts: string[] = [];

  // Header: the mark, TRANSACTION RECEIPT, the date (W41).
  const headTop = PAD_TOP;
  parts.push(
    `<image x="${PAD_X}" y="${headTop}" width="${MARK_W}" height="${MARK_H.toFixed(2)}" href="${MARK}"/>`,
  );
  const headBase = headTop + MARK_H / 2 + 4.5;
  parts.push(
    text(PAD_X + MARK_W + 8, headBase, doc.title, {
      size: 13,
      weight: 700,
      fill: RECEIPT_TOKENS.accent,
      spacing: 0.78,
    }),
    text(W - PAD_X, headBase, doc.dateText, {
      size: 11.5,
      fill: RECEIPT_TOKENS.muted,
      anchor: 'end',
    }),
  );

  // The headline, the amount and the status, centred.
  let y = headTop + MARK_H + 14 + 6;
  const mid = W / 2;
  y += 13;
  parts.push(
    text(mid, y, fit(doc.headline, 13, inner), {
      size: 13,
      fill: RECEIPT_TOKENS.muted,
      anchor: 'middle',
    }),
  );
  y += 4 + 34;
  parts.push(
    text(mid, y, doc.amountText, {
      size: 34,
      weight: 700,
      fill: TONE[doc.amountTone],
      anchor: 'middle',
      spacing: -1,
    }),
  );
  y += 6 + 14;
  parts.push(
    text(mid, y, doc.statusText, {
      size: 12,
      weight: 700,
      fill: TONE[doc.statusTone],
      anchor: 'middle',
    }),
  );
  y += 6 + 14;

  // The rows: label left, value right (on as many as 3 lines), a hairline under each.
  for (const line of doc.lines) {
    const labelWidth = textWidth(line.label, 13) + 16;
    // The reference is drawn on as many lines as it takes; anything else on 3 at most.
    const values = wrap(
      line.value,
      13,
      inner - labelWidth,
      600,
      line.label === REFERENCE_LABEL ? MAX_REFERENCE : 3,
    );
    const height = ROW_HEIGHT + (values.length - 1) * VALUE_LINE;
    parts.push(
      text(PAD_X, y + 22, line.label, { size: 13, fill: RECEIPT_TOKENS.muted }),
    );
    values.forEach((v, i) =>
      parts.push(
        text(W - PAD_X, y + 22 + i * VALUE_LINE, v, {
          size: 13,
          weight: 600,
          fill: RECEIPT_TOKENS.ink,
          anchor: 'end',
        }),
      ),
    );
    parts.push(
      `<rect x="${PAD_X}" y="${y + height - 1}" width="${inner}" height="1" fill="${RECEIPT_TOKENS.hairline}"/>`,
    );
    y += height;
  }

  // The footer: where to check it, and the licence line when the owner set one.
  y += 14;
  const footerTop = y;
  for (const l of wrap(doc.footer, 11, inner)) {
    y += FOOTER_LINE;
    parts.push(
      text(mid, y - 4, l, {
        size: 11,
        fill: RECEIPT_TOKENS.faint,
        anchor: 'middle',
      }),
    );
  }
  const height = Math.ceil(y + PAD_BOTTOM);
  return { svg: parts.join(''), height, footer: { top: footerTop, bottom: y } };
}

const RENDER_OPTIONS = (widthPx: number): ResvgRenderOptions => ({
  background: RECEIPT_TOKENS.paper,
  fitTo: { mode: 'width', value: widthPx },
  font: {
    fontFiles: FONT_FILES,
    loadSystemFonts: false,
    defaultFontFamily: FAMILY,
  },
  imageRendering: 0,
  shapeRendering: 2,
  textRendering: 1,
});

/** W42: the receipt as a PNG, white, IMAGE_SCALE pixels per point. */
export async function receiptPng(doc: ReceiptDocument): Promise<Buffer> {
  const card = receiptCard(doc);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RECEIPT_WIDTH}" height="${card.height}" viewBox="0 0 ${RECEIPT_WIDTH} ${card.height}"><rect width="100%" height="100%" fill="${RECEIPT_TOKENS.paper}"/>${card.svg}</svg>`;
  const image = await renderAsync(
    svg,
    RENDER_OPTIONS(RECEIPT_WIDTH * IMAGE_SCALE),
  );
  return pngOf(image.pixels, image.width, image.height);
}

/** Rows of a picture handed over this many at a time, so no slice holds the event loop more than a few ms. */
const ROWS_PER_SLICE = 128;
const nextTick = () => new Promise<void>((r) => setImmediate(r));

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(Buffer.from(type, 'latin1'))) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * RGBA pixels as a PNG, compressed on the thread pool. resvg's own
 * `asPng()` encodes on the calling thread (about 60 ms for a receipt), so
 * the PNG is put together here instead: each row with filter byte 0, then
 * one zlib stream.
 */
export async function pngOf(
  rgba: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    if (y > 0 && y % ROWS_PER_SLICE === 0) await nextTick();
    const at = y * (stride + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', await deflateAsync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A string for a PDF literal: only printable ASCII, with \, ( and ) escaped. */
export function pdfString(s: string): string {
  return `(${s
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** W43: one A4 page with the receipt on it, as a PDF. */
export async function receiptPdf(
  doc: ReceiptDocument,
  createdAt: Date,
): Promise<Buffer> {
  const card = receiptCard(doc);
  const cardW = RECEIPT_WIDTH * PDF_CARD_SCALE;
  const cardH = card.height * PDF_CARD_SCALE;
  const left = (A4.width - cardW) / 2;
  // Only the receipt is a picture; the page around it is the PDF's own
  // white, and its edge a drawn line. Half the pixels of drawing the page.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RECEIPT_WIDTH}" height="${card.height}" viewBox="0 0 ${RECEIPT_WIDTH} ${card.height}"><rect width="100%" height="100%" fill="${RECEIPT_TOKENS.paper}"/>${card.svg}</svg>`;
  const page = await renderAsync(
    svg,
    RENDER_OPTIONS(Math.round((cardW * PDF_DPI) / 72)),
  );
  // RGBA to RGB: the page is opaque white, so the alpha byte carries nothing.
  // Converted a slice of rows at a time, so the server keeps answering.
  const rgba = page.pixels;
  const rgb = Buffer.allocUnsafe((rgba.length / 4) * 3);
  const slice = page.width * 4 * ROWS_PER_SLICE;
  for (let from = 0; from < rgba.length; from += slice) {
    if (from > 0) await nextTick();
    const to = Math.min(from + slice, rgba.length);
    for (let i = from, j = (from / 4) * 3; i < to; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
  }

  // The link over the footer, in PDF space (origin bottom left).
  const link = doc.url
    ? {
        x0: left,
        x1: left + cardW,
        y0: A4.height - (PDF_TOP + card.footer.bottom * PDF_CARD_SCALE),
        y1: A4.height - (PDF_TOP + card.footer.top * PDF_CARD_SCALE),
        uri: doc.url,
      }
    : null;
  const image = await deflateAsync(rgb, { level: 6 });
  return pdfWithImage(
    image,
    page.width,
    page.height,
    { x: left, y: A4.height - PDF_TOP - cardH, w: cardW, h: cardH },
    link,
    createdAt,
  );
}

const n2 = (n: number) => n.toFixed(2);

/** A one-page A4 PDF with one deflated RGB picture placed `at`, with an optional link. */
export function pdfWithImage(
  image: Buffer,
  width: number,
  height: number,
  at: { x: number; y: number; w: number; h: number },
  link: { x0: number; y0: number; x1: number; y1: number; uri: string } | null,
  createdAt: Date,
): Buffer {
  // The picture where it goes, and a hairline round it (W43's page edge).
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(RECEIPT_TOKENS.hairline.slice(i, i + 2), 16) / 255,
  );
  const content = Buffer.from(
    `q ${n2(at.w)} 0 0 ${n2(at.h)} ${n2(at.x)} ${n2(at.y)} cm /Im1 Do Q\n` +
      `q ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG 1 w ${n2(at.x - 0.5)} ${n2(at.y - 0.5)} ${n2(at.w + 1)} ${n2(at.h + 1)} re S Q\n`,
    'latin1',
  );
  const stamp = createdAt.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const objects: Buffer[] = [];
  const obj = (body: Buffer | string) =>
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);

  obj('<< /Type /Catalog /Pages 2 0 R >>');
  obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(A4.width)} ${n2(A4.height)}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R${link ? ' /Annots [7 0 R]' : ''} >>`,
  );
  obj(
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
        'latin1',
      ),
      image,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  );
  obj(
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'),
      content,
      Buffer.from('endstream', 'latin1'),
    ]),
  );
  obj(
    `<< /Title ${pdfString('Receipt')} /Producer ${pdfString('Who Made This')} /CreationDate ${pdfString(`D:${stamp}Z`)} >>`,
  );
  if (link) {
    obj(
      `<< /Type /Annot /Subtype /Link /Rect [${n2(link.x0)} ${n2(link.y0)} ${n2(link.x1)} ${n2(link.y1)}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(link.uri)} >> >>`,
    );
  }

  const chunks: Buffer[] = [
    Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
  ];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const piece = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(piece);
    offset += piece.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
