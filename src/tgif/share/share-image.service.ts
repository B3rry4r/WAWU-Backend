import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { renderAsync } from '@resvg/resvg-js';
import { TGIF_TOKENS } from '../../styles/tokens-tgif';
import { FontWidths } from './font-widths';

/** What a person is told when every drawing slot stayed busy for the whole wait. */
export const SHARE_IMAGE_BUSY_MESSAGE =
  'The card is busy right now. Try again in a few seconds.';

/** The card's width in points, as H35 draws the preview, and the pixels drawn per point. */
export const CARD_WIDTH = 350;
export const IMAGE_SCALE = 3;
/** H35's preview card (design/_gen/home.js): 22 inside, 220 high, the date at the top, the verse between, the reference at the bottom. */
const PAD = 22;
const MIN_HEIGHT = 220;
const LABEL_SIZE = 11;
const LABEL_SPACING_EM = 0.12;
const VERSE_LEADING = 1.3;
const FOOTER_SIZE = 12;
/** Alan Sans: the line box is the font's ascent and descent, 0.99 and 0.31 of the size. */
const ASCENT = 0.99;
const LINE_BOX = 1.3;
/** The verse is set at the largest of these that fits in VERSE_MAX_LINES. */
const VERSE_SIZES = [19, 17, 15, 13.5];
const VERSE_MAX_LINES = 9;
/** The glow in the corner: a 220 circle, 60 past the right and top edges, clear at 70% of its far corner. */
const GLOW_CENTER = { x: CARD_WIDTH + 60 - 110, y: -60 + 110 };
const GLOW_RADIUS = 0.7 * 110 * Math.SQRT2;

/** Pictures kept, newest last: the card is the same for everyone on the same day of the year. */
const KEEP = 64;
/** Drawings at once in this process, and how long a request waits for a slot. */
const SLOTS = 2;
const WAIT_MS = 10_000;

const FAMILY = 'WMT Receipt Sans';
const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir)
      throw new Error('TGIF fonts: package.json not found above ' + __dirname);
    dir = up;
  }
  return dir;
}

const FONT_DIR = join(repoRoot(), 'assets', 'tgif', 'fonts');
const BOLD = join(FONT_DIR, 'WMTReceiptSans-Bold.ttf');
const SEMIBOLD = join(FONT_DIR, 'WMTReceiptSans-SemiBold.ttf');
let widths: { bold: FontWidths; semibold: FontWidths } | undefined;
/** Read on first use, so a server that never draws a card never reads the fonts. */
function fonts() {
  widths ??= {
    bold: new FontWidths(readFileSync(BOLD)),
    semibold: new FontWidths(readFileSync(SEMIBOLD)),
  };
  return widths;
}

/** Text for SVG: control characters dropped, and &, <, >, " and ' escaped. */
export function xml(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f￾￿]/g, ' ')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '')
      .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
      .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  );
}

/** The text on lines no wider than `width`: broken between words, a word too long for a line between characters. */
export function wrapLines(
  value: string,
  width: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    if (measure(word) <= width) {
      line = word;
      continue;
    }
    for (const ch of word) {
      if (line && measure(line + ch) > width) {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface ShareCardInput {
  /** `YYYY-MM-DD`: only the month and day are drawn. */
  date: string;
  verse: string;
  reference: string;
  /** Written bottom right, or left off when null. */
  link: string | null;
}

/** The card as SVG, with its height in points. Pure: no file, no renderer. */
export function shareCardSvg(input: ShareCardInput): {
  svg: string;
  height: number;
} {
  const { bold, semibold } = fonts();
  const month = MONTHS[Number(input.date.slice(5, 7)) - 1] ?? '';
  const label = `TGIF \u00b7 ${Number(input.date.slice(8, 10))} ${month}`;
  const quote = `\u201c${input.verse}\u201d`;
  const inner = CARD_WIDTH - 2 * PAD;

  let size = VERSE_SIZES[VERSE_SIZES.length - 1];
  let lines: string[] = [];
  for (const candidate of VERSE_SIZES) {
    const tried = wrapLines(quote, inner, (s) => bold.width(s, candidate));
    size = candidate;
    lines = tried;
    if (tried.length <= VERSE_MAX_LINES) break;
  }
  // Three blocks spaced evenly down the card, as the canvas's `space-between`.
  const labelBox = LABEL_SIZE * LINE_BOX;
  const lineBox = size * VERSE_LEADING;
  const verseBox = lines.length * lineBox;
  const footerBox = FOOTER_SIZE * LINE_BOX;
  const height = Math.max(
    MIN_HEIGHT,
    Math.ceil(2 * PAD + labelBox + verseBox + footerBox + 2 * 24),
  );
  const gap = (height - 2 * PAD - labelBox - verseBox - footerBox) / 2;
  const verseTop = PAD + labelBox + gap;
  const footerTop = verseTop + verseBox + gap;

  // The footer is one line: the link, if it fits beside the reference, else the reference alone.
  const reference = xml(input.reference);
  const link =
    input.link &&
    semibold.width(input.link, FOOTER_SIZE) +
      semibold.width(input.reference, FOOTER_SIZE) +
      16 <=
      inner
      ? input.link
      : null;

  const ink = `fill="${TGIF_TOKENS.ink}"`;
  const soft = `${ink} fill-opacity="${TGIF_TOKENS.inkSoft}"`;
  const verse = lines
    .map((l, i) => {
      // The text sits in the middle of its line box, as CSS places it.
      const y =
        verseTop +
        i * lineBox +
        (lineBox - size * LINE_BOX) / 2 +
        size * ASCENT;
      return `<text x="${PAD}" y="${y.toFixed(2)}" font-family="${FAMILY}" font-size="${size}" font-weight="700" ${ink}>${xml(l)}</text>`;
    })
    .join('');
  const footerY = (footerTop + FOOTER_SIZE * ASCENT).toFixed(2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}">` +
    `<defs><radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${GLOW_CENTER.x}" cy="${GLOW_CENTER.y}" r="${GLOW_RADIUS.toFixed(2)}">` +
    `<stop offset="0" stop-color="${TGIF_TOKENS.glow}" stop-opacity="${TGIF_TOKENS.glowOpacity}"/>` +
    `<stop offset="1" stop-color="${TGIF_TOKENS.glow}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="100%" height="100%" fill="${TGIF_TOKENS.ground}"/>` +
    `<rect width="100%" height="100%" fill="url(#glow)"/>` +
    `<text x="${PAD}" y="${(PAD + LABEL_SIZE * ASCENT).toFixed(2)}" font-family="${FAMILY}" font-size="${LABEL_SIZE}" font-weight="700" letter-spacing="${(LABEL_SPACING_EM * LABEL_SIZE).toFixed(3)}" ${soft}>${xml(label)}</text>` +
    verse +
    `<text x="${PAD}" y="${footerY}" font-family="${FAMILY}" font-size="${FOOTER_SIZE}" font-weight="600" ${soft}>${reference}</text>` +
    (link
      ? `<text x="${CARD_WIDTH - PAD}" y="${footerY}" text-anchor="end" font-family="${FAMILY}" font-size="${FOOTER_SIZE}" font-weight="600" ${soft}>${xml(link)}</text>`
      : '') +
    `</svg>`;
  return { svg, height };
}

/**
 * The shared card as a PNG (task HOME-09, H35): the day's verse on the verse
 * card, drawn by @resvg/resvg-js from the Alan Sans cut the receipts use. The
 * card holds no one's name, so it is the same for everybody on the same day
 * of the year and is drawn once; at most SLOTS drawings run at once and a
 * request that finds no slot in WAIT_MS is refused with 503.
 */
@Injectable()
export class ShareImageService {
  private readonly kept = new Map<string, Promise<Buffer>>();
  private running = 0;
  private readonly queue: Array<() => void> = [];

  async png(input: ShareCardInput): Promise<Buffer> {
    const key = `${input.date.slice(5)}|${input.link ?? ''}`;
    const hit = this.kept.get(key);
    if (hit) {
      // Newest last, so the oldest is the one that goes.
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit;
    }
    const drawing = this.draw(input);
    this.kept.set(key, drawing);
    drawing.catch(() => this.kept.delete(key));
    while (this.kept.size > KEEP) {
      const oldest = this.kept.keys().next().value as string;
      this.kept.delete(oldest);
    }
    return drawing;
  }

  private async draw(input: ShareCardInput): Promise<Buffer> {
    await this.acquire();
    try {
      const { svg } = shareCardSvg(input);
      const image = await renderAsync(svg, {
        fitTo: { mode: 'width', value: CARD_WIDTH * IMAGE_SCALE },
        font: {
          fontFiles: [BOLD, SEMIBOLD],
          loadSystemFonts: false,
          defaultFontFamily: FAMILY,
        },
        shapeRendering: 2,
        textRendering: 1,
      });
      return image.asPng();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < SLOTS) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        this.running += 1;
        resolve();
      };
      const timer = setTimeout(() => {
        const at = this.queue.indexOf(turn);
        if (at >= 0) this.queue.splice(at, 1);
        reject(new ServiceUnavailableException(SHARE_IMAGE_BUSY_MESSAGE));
      }, WAIT_MS);
      this.queue.push(turn);
    });
  }

  private release() {
    this.running -= 1;
    this.queue.shift()?.();
  }
}
