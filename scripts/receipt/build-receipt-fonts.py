"""
WALLET-18: the fonts the receipt image and PDF are drawn with.

The receipt is set in Alan Sans, the app's typeface (the mobile repo's
`assets/fonts/`, SIL Open Font License 1.1). Alan Sans has no naira sign
(DECISIONS R-35), and the renderer (@resvg/resvg-js) draws a whole line in a
fallback font as soon as one character is missing, so a fallback for the one
glyph would set "+N2,000.00" entirely in another typeface. This script adds a
naira sign to each weight the receipt uses, drawn from that weight's own N
with two bars across it, and renames the family (OFL section 3: a modified
font does not carry the original's name). The output is committed under
`assets/receipt/fonts/` with the licence beside it; run this again only when
the source fonts change.

    python3 scripts/receipt/build-receipt-fonts.py <mobile repo>/assets/fonts

Needs fontTools (`pip install fonttools`). Nothing at run time needs Python.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

FAMILY = "WMT Receipt Sans"
PS_FAMILY = "WMTReceiptSans"
WEIGHTS = {"Regular": 400, "SemiBold": 600, "Bold": 700}
NAIRA = 0x20A6
OUT = Path(__file__).resolve().parents[2] / "assets" / "receipt" / "fonts"


def signed_area(points: list[tuple[float, float]]) -> float:
    return sum(
        x0 * y1 - x1 * y0
        for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1])
    )


def build(src: Path, style: str) -> None:
    # recalcTimestamp=False keeps the source's head.modified, so a rebuild
    # from the same source is byte for byte the same file.
    font = TTFont(src, recalcTimestamp=False)
    glyphs = font.getGlyphSet()
    stem = BoundsPen(glyphs)
    glyphs["I"].draw(stem)
    stem_width = stem.bounds[2] - stem.bounds[0]
    n_bounds = BoundsPen(glyphs)
    glyphs["N"].draw(n_bounds)
    _, _, _, cap = n_bounds.bounds
    n_advance = font["hmtx"]["N"][0]

    # The outer contour's direction, so the bars are drawn the same way and
    # fill as one shape with the N under the nonzero rule.
    rec = RecordingPen()
    glyphs["N"].draw(rec)
    first: list[tuple[float, float]] = []
    for op, args in rec.value:
        if op == "moveTo":
            first = [args[0]]
        elif op in ("lineTo", "qCurveTo", "curveTo"):
            first.extend(args)
        elif op in ("closePath", "endPath"):
            break
    clockwise = signed_area(first) < 0

    overhang = round(stem_width * 0.45)
    bar = max(round(stem_width * 0.42), 30)
    pen = TTGlyphPen(glyphs)
    glyphs["N"].draw(TransformPen(pen, (1, 0, 0, 1, overhang, 0)))
    # The N moves right by the overhang; the bars reach that far past each stem.
    left = n_bounds.bounds[0]
    right = n_bounds.bounds[2] + 2 * overhang
    for centre in (cap * 0.37, cap * 0.63):
        y0, y1 = round(centre - bar / 2), round(centre + bar / 2)
        corners = [(left, y0), (left, y1), (right, y1), (right, y0)]
        if not clockwise:
            corners.reverse()
        pen.moveTo(corners[0])
        for c in corners[1:]:
            pen.lineTo(c)
        pen.closePath()
    glyph = pen.glyph()

    name = "naira"
    order = font.getGlyphOrder()
    if name not in order:
        font.setGlyphOrder(order + [name])
    font["glyf"][name] = glyph
    glyph.recalcBounds(font["glyf"])
    font["hmtx"][name] = (n_advance + 2 * overhang, glyph.xMin)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[NAIRA] = name

    names = font["name"]
    for record in list(names.names):
        if record.nameID in (1, 2, 3, 4, 6, 16, 17):
            names.removeNames(nameID=record.nameID)
    for name_id, text in (
        (1, FAMILY),
        (2, "Regular"),
        (3, f"{PS_FAMILY}-{style};WALLET-18"),
        (4, f"{FAMILY} {style}"),
        (6, f"{PS_FAMILY}-{style}"),
        (16, FAMILY),
        (17, style),
    ):
        names.setName(text, name_id, 3, 1, 0x409)
    font["OS/2"].usWeightClass = WEIGHTS[style]
    font.save(OUT / f"{PS_FAMILY}-{style}.ttf")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    for style in WEIGHTS:
        build(source / f"AlanSans-{style}.ttf", style)
    shutil.copyfile(source / "OFL.txt", OUT / "OFL.txt")
    print(f"wrote {len(WEIGHTS)} fonts to {OUT}")


if __name__ == "__main__":
    main()
