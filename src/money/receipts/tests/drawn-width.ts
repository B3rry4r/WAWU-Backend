import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const FONTS = join(__dirname, '../../../../assets/receipt/fonts');

/** How wide resvg draws `text` in the receipt's fonts: the ink's bounding box, in points. */
export function drawnWidth(text: string, size: number, weight: number): number {
  const esc = text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="100"><text x="10" y="60" font-family="WMT Receipt Sans" font-size="${size}" font-weight="${weight}">${esc}</text></svg>`;
  const box = new Resvg(svg, {
    font: {
      fontFiles: ['Regular', 'SemiBold', 'Bold'].map((w) =>
        join(FONTS, `WMTReceiptSans-${w}.ttf`),
      ),
      loadSystemFonts: false,
      defaultFontFamily: 'WMT Receipt Sans',
    },
  }).getBBox();
  return box ? box.width : 0;
}
