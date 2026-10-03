import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import { RECEIPT_TOKENS, type ReceiptTone } from '../../styles/tokens-receipt';
import type { ReceiptDocument } from './receipt-document';

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
const FONT_FILES = ['Regular', 'SemiBold', 'Bold'].map((w) =>
  join(ASSETS, 'fonts', `WMTReceiptSans-${w}.ttf`),
);
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

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const widths = new Map<string, number>();

/**
 * How wide `value` is drawn, in points: measured by the renderer itself in
 * the receipt's own fonts (the drawn ink's width), and remembered.
 */
export function textWidth(value: string, size: number, weight = 400): number {
  if (value.trim() === '') return 0;
  const key = `${size}|${weight}|${value}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200"><text x="0" y="100" font-family="${FAMILY}" font-size="${size}" font-weight="${weight}">${escapeXml(value)}</text></svg>`;
  const box = new Resvg(svg, {
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: FAMILY,
    },
  }).getBBox();
  const width = box ? box.width : 0;
  if (widths.size > 5_000) widths.clear();
  widths.set(key, width);
  return width;
}

/** The text cut to fit `width`, with an ellipsis when cut. */
export function fit(
  value: string,
  size: number,
  width: number,
  weight = 400,
): string {
  if (textWidth(value, size, weight) <= width) return value;
  let out = value;
  while (out.length > 1 && textWidth(`${out}…`, size, weight) > width)
    out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/**
 * The text on lines no wider than `width`: broken between words, and a
 * word too long for one line (a reference) broken between characters. At
 * most `max` lines; only text beyond them is cut, with an ellipsis.
 */
export function wrap(
  value: string,
  size: number,
  width: number,
  weight = 400,
  max = 3,
): string[] {
  const lines: string[] = [];
  let line = '';
  const push = (word: string) => {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size, weight) <= width) {
      line = next;
      return;
    }
    if (line) lines.push(line);
    line = '';
    let rest = word;
    while (textWidth(rest, size, weight) > width) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), size, weight) > width)
        cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  };
  for (const word of value.split(' ')) push(word);
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = fit(
    `${kept[max - 1]} ${lines.slice(max).join(' ')}`,
    size,
    width,
    weight,
  );
  return kept;
}

function text(
  x: number,
  y: number,
  value: string,
  o: {
    size: number;
    weight?: number;
    fill: string;
    anchor?: 'start' | 'middle' | 'end';
    spacing?: number;
  },
): string {
  return `<text x="${x}" y="${y}" font-family="${FAMILY}" font-size="${o.size}" font-weight="${o.weight ?? 400}" fill="${o.fill}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}>${escapeXml(value)}</text>`;
}

/** The receipt as SVG content at RECEIPT_WIDTH, with its height and where the footer's link sits. */
export function receiptCard(doc: ReceiptDocument): {
  svg: string;
  height: number;
  footer: { top: number; bottom: number };
} {
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
    const values = wrap(line.value, 13, inner - labelWidth, 600);
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

function render(
  svg: string,
  widthPx: number,
): { rgb: Buffer; png: Buffer; width: number; height: number } {
  const options: ResvgRenderOptions = {
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
  };
  const image = new Resvg(svg, options).render();
  const rgba = image.pixels;
  const rgb = Buffer.alloc((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return { rgb, png: image.asPng(), width: image.width, height: image.height };
}

/** W42: the receipt as a PNG, white, IMAGE_SCALE pixels per point. */
export function receiptPng(doc: ReceiptDocument): Buffer {
  const card = receiptCard(doc);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RECEIPT_WIDTH}" height="${card.height}" viewBox="0 0 ${RECEIPT_WIDTH} ${card.height}"><rect width="100%" height="100%" fill="${RECEIPT_TOKENS.paper}"/>${card.svg}</svg>`;
  return render(svg, RECEIPT_WIDTH * IMAGE_SCALE).png;
}

/** A string for a PDF literal: only printable ASCII, with \, ( and ) escaped. */
export function pdfString(s: string): string {
  return `(${s
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** W43: one A4 page with the receipt on it, as a PDF. */
export function receiptPdf(doc: ReceiptDocument, createdAt: Date): Buffer {
  const card = receiptCard(doc);
  const cardW = RECEIPT_WIDTH * PDF_CARD_SCALE;
  const left = (A4.width - cardW) / 2;
  const edge = `<rect x="${left - 0.5}" y="${PDF_TOP - 0.5}" width="${cardW + 1}" height="${card.height * PDF_CARD_SCALE + 1}" rx="6" fill="none" stroke="${RECEIPT_TOKENS.hairline}" stroke-width="1"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${A4.width}" height="${A4.height}" viewBox="0 0 ${A4.width} ${A4.height}"><rect width="100%" height="100%" fill="${RECEIPT_TOKENS.paper}"/>${edge}<g transform="translate(${left} ${PDF_TOP}) scale(${PDF_CARD_SCALE})">${card.svg}</g></svg>`;
  const page = render(svg, Math.round((A4.width * PDF_DPI) / 72));

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
  return pdfWithImage(page.rgb, page.width, page.height, link, createdAt);
}

const n2 = (n: number) => n.toFixed(2);

/** A one-page A4 PDF whose page is one RGB picture, with an optional link. */
export function pdfWithImage(
  rgb: Buffer,
  width: number,
  height: number,
  link: { x0: number; y0: number; x1: number; y1: number; uri: string } | null,
  createdAt: Date,
): Buffer {
  const image = deflateSync(rgb, { level: 9 });
  const content = Buffer.from(
    `q ${n2(A4.width)} 0 0 ${n2(A4.height)} 0 0 cm /Im1 Do Q\n`,
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
