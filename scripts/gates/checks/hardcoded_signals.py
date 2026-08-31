"""Coded is not reachable.

Two related defects, both invisible at review and both fatal at runtime:

1. A signal that stands in for a real source -- `bool get isOnline => true`.
   The offline state exists in code, is beautifully designed, and can never be
   entered by any user under any condition. It looks like working code.
2. A raw colour literal where a token layer exists -- the design system is
   the source of truth, and a hex that bypasses it will not follow a theme
   change and will not be caught by anyone reading the diff.

The colour check deliberately does not flag every `Color(0x........)` literal.
Fully transparent colours (`Color(0x00000000)`) and alpha-only white/black
overlays and scrims (e.g. `Color(0x33FFFFFF)`, `Color(0x520F0F12)`) are not
brand colours -- they carry no hue for a token to name, only an opacity over
whatever sits underneath. A token layer cannot express "40% black scrim" any
better than the literal does, and flagging them just teaches people to ignore
this gate. Real hues -- anything with actual chroma, like the purple in
charts.dart -- are still flagged; only the transparent/near-black/near-white
alpha overlays are exempt. See `_is_overlay_or_transparent` below.
"""

from __future__ import annotations

import fnmatch
import re
from typing import Iterator

from run import Context, Finding

NAME = "hardcoded_signals"

SIGNAL_WORDS = (
    r"online|offline|connected|enabled|disabled|verified|approved|available|ready|"
    r"allowed|premium|pro|paid|subscribed|active|complete|loaded|authenticated|"
    r"hasAccess|canTrade|isAdmin|isStaff|kyc\w*"
)

PATTERNS = [
    # Dart / TS: bool get isOnline => true;
    (re.compile(rf"\b(?:bool|boolean)\s+get\s+(\w*(?:{SIGNAL_WORDS})\w*)\s*=>\s*(true|false)\s*;", re.I),
     "getter returns a constant where a real source belongs"),
    # Dart / TS: static const bool isOnline = true;
    # Only immutable bindings: a reassignable `var` is not a hardcoded signal,
    # it is a variable with an initial value.
    (re.compile(rf"\b(?:const|final|static\s+(?:const|final|readonly))\s+(?:bool\s+|boolean\s+)?(\w*(?:{SIGNAL_WORDS})\w*)\s*=\s*(true|false)\s*;", re.I),
     "constant stands in for a runtime signal"),
    # Dart: ValueNotifier<bool>(true) / TS: useState(true)
    (re.compile(rf"\b(\w*(?:{SIGNAL_WORDS})\w*)\s*=\s*(?:ValueNotifier(?:<bool>)?|useState|signal)\(\s*(true|false)\s*\)", re.I),
     "state holder seeded with a literal instead of a real source"),
]

HEX = re.compile(r"(?:Color\(\s*0x([0-9a-fA-F]{6,8})\s*\)|#([0-9a-fA-F]{6})\b)")

# Thresholds for "this is a shade of grey, not a hue": how far apart the R/G/B
# channels are allowed to be (near-monochrome) and how close the average
# channel value must sit to black or to white. A real brand colour like
# 0xB98AE6 (a purple) has a wide R/G/B spread and fails both checks.
_GREY_SPREAD_MAX = 10
_BLACK_AVG_MAX = 20
_WHITE_AVG_MIN = 235


def _is_overlay_or_transparent(hexdigits: str) -> bool:
    """True for a colour literal that carries no hue: fully transparent, or an
    alpha-only near-black/near-white overlay or scrim."""
    digits = hexdigits
    if len(digits) == 8:
        alpha, rgb = digits[0:2], digits[2:8]
    else:
        alpha, rgb = "ff", digits  # 6-digit literal (e.g. #RRGGBB): opaque

    if int(alpha, 16) == 0:
        return True  # fully transparent -- the RGB behind it never renders

    r, g, b = int(rgb[0:2], 16), int(rgb[2:4], 16), int(rgb[4:6], 16)
    spread = max(r, g, b) - min(r, g, b)
    avg = (r + g + b) / 3
    if spread > _GREY_SPREAD_MAX:
        return False  # has real chroma -- a hue, not a grey
    return avg <= _BLACK_AVG_MAX or avg >= _WHITE_AVG_MIN


def run(ctx: Context) -> Iterator[Finding]:
    token_layer = ctx.gate_config.get("token_layer", [])
    check_colors = ctx.gate_config.get("check_colors", True)
    allow = set(ctx.gate_config.get("allow_paths", []))

    for path in ctx.source_files("source"):
        if ctx.is_test(path):
            continue
        rel = ctx.rel(path)
        if rel in allow:
            continue
        in_token_layer = any(fnmatch.fnmatch(rel, pat) for pat in token_layer)

        for lineno, line in ctx.lines(path):
            stripped = line.strip()
            if stripped.startswith(("//", "///", "#", "*")):
                continue

            for rx, msg in PATTERNS:
                m = rx.search(line)
                if m:
                    yield Finding(
                        gate=NAME,
                        path=rel,
                        line=lineno,
                        message=f"'{m.group(1)}' - {msg}",
                        evidence=line,
                    )
                    break

            if check_colors and not in_token_layer:
                m = HEX.search(line)
                if m:
                    hexdigits = m.group(1) or m.group(2)
                    if not _is_overlay_or_transparent(hexdigits):
                        yield Finding(
                            gate=NAME,
                            path=rel,
                            line=lineno,
                            message=f"raw colour {m.group(0)} outside the token layer",
                            evidence=line,
                            severity="warn",
                        )
