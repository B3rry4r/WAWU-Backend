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
const PAD_X = 22;
const PAD_TOP = 22;
const PAD_BOTTOM = 22;
const MIN_HEIGHT = 220;
const LABEL_SIZE = 11;
const LABEL_SPACING_EM = 0.14;
const VERSE_LEADING = 1.25;
const VERSE_TRACKING_EM = -0.02;
const FOOTER_SIZE = 14;
/** The verse is set at the largest of these that fits in VERSE_MAX_HEIGHT. */
const VERSE_SIZES = [20, 18, 16, 14];
const VERSE_MAX_HEIGHT = 230;
const LABEL_TO_VERSE = 34;
const VERSE_TO_FOOTER = 28;

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
  const label = `TGIF · ${Number(input.date.slice(8, 10))} ${month}`;
  const quote = `“${input.verse}”`;
  const inner = CARD_WIDTH - 2 * PAD_X;

  let size = VERSE_SIZES[VERSE_SIZES.length - 1];
  let lines: string[] = [];
  for (const candidate of VERSE_SIZES) {
    const tracking = VERSE_TRACKING_EM * candidate;
    const tried = wrapLines(quote, inner, (s) =>
      bold.width(s, candidate, tracking),
    );
    size = candidate;
    lines = tried;
    if (tried.length * candidate * VERSE_LEADING <= VERSE_MAX_HEIGHT) break;
  }
  const lineHeight = size * VERSE_LEADING;
  const verseTop = PAD_TOP + LABEL_SIZE + LABEL_TO_VERSE;
  const verseBottom = verseTop + lines.length * lineHeight;
  const footerBase = verseBottom + VERSE_TO_FOOTER + FOOTER_SIZE;
  const height = Math.max(MIN_HEIGHT, Math.ceil(footerBase + PAD_BOTTOM));
  const base = height - PAD_BOTTOM;

  // The footer is one line: the link, if it fits beside the reference, else the reference alone.
  const reference = xml(input.reference);
  const link = input.link
    ? semibold.width(input.link, FOOTER_SIZE) +
        semibold.width(input.reference, FOOTER_SIZE) +
        16 <=
      inner
      ? input.link
      : null
    : null;

  const verse = lines
    .map(
      (l, i) =>
        `<text x="${PAD_X}" y="${(verseTop + size * 0.9 + i * lineHeight).toFixed(2)}" font-family="${FAMILY}" font-size="${size}" font-weight="700" letter-spacing="${(VERSE_TRACKING_EM * size).toFixed(3)}" fill="${TGIF_TOKENS.ink}">${xml(l)}</text>`,
    )
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}">` +
    `<defs><radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${CARD_WIDTH - 80}" cy="${Math.round(height * 0.2)}" r="168">` +
    `<stop offset="0" stop-color="${TGIF_TOKENS.glow}" stop-opacity="${TGIF_TOKENS.glowOpacity}"/>` +
    `<stop offset="1" stop-color="${TGIF_TOKENS.glow}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="100%" height="100%" fill="${TGIF_TOKENS.ground}"/>` +
    `<rect width="100%" height="100%" fill="url(#glow)"/>` +
    `<text x="${PAD_X}" y="${PAD_TOP + LABEL_SIZE}" font-family="${FAMILY}" font-size="${LABEL_SIZE}" font-weight="700" letter-spacing="${(LABEL_SPACING_EM * LABEL_SIZE).toFixed(3)}" fill="${TGIF_TOKENS.ink}" fill-opacity="${TGIF_TOKENS.inkSoft}">${xml(label)}</text>` +
    verse +
    `<text x="${PAD_X}" y="${base}" font-family="${FAMILY}" font-size="${FOOTER_SIZE}" font-weight="600" fill="${TGIF_TOKENS.ink}" fill-opacity="${TGIF_TOKENS.inkSoft}">${reference}</text>` +
    (link
      ? `<text x="${CARD_WIDTH - PAD_X}" y="${base}" text-anchor="end" font-family="${FAMILY}" font-size="${FOOTER_SIZE}" font-weight="600" fill="${TGIF_TOKENS.ink}" fill-opacity="${TGIF_TOKENS.inkSoft}">${xml(link)}</text>`
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
