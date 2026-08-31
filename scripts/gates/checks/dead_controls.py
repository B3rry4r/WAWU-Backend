"""A control that does nothing is worse than an absent one.

The user taps it, nothing happens, and they conclude the app is broken -- which
it is. This is the most common single defect in generated UI and the easiest to
detect: the handler is literally empty or null in the source.
"""

from __future__ import annotations

import re
from typing import Iterator

from run import Context, Finding

NAME = "dead_controls"

PATTERNS = [
    # Flutter: onPressed: () {}   onTap: () {}   onChanged: (_) {}
    (re.compile(r"\b(on\w+)\s*:\s*\(\s*(?:_|\w+)?\s*\)\s*(?:async\s*)?\{\s*\}"),
     "handler is an empty function"),
    # Flutter: onPressed: () {},  spanning to a closing brace on the same line
    (re.compile(r"\b(on\w+)\s*:\s*\(\s*\)\s*=>\s*(?:null|\{\})\s*[,)]"),
     "handler resolves to nothing"),
    # React/TS: onClick={() => {}}
    (re.compile(r"\b(on[A-Z]\w+)\s*=\s*\{\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\}"),
     "handler is an empty function"),
    # Navigation to nowhere
    (re.compile(r"\bhref\s*=\s*[\"'](?:#|javascript:void\(0\))[\"']"),
     "link goes nowhere"),
]

# `onPressed: null` is legitimate and meaningful in Flutter: it is how a button
# is *disabled*. It is only a defect when it is unconditional and permanent,
# which this static gate cannot tell apart -- so it is a warning, not a failure.
NULL_HANDLER = re.compile(r"\b(on(?:Pressed|Tap|Changed|Submitted))\s*:\s*null\b")


def run(ctx: Context) -> Iterator[Finding]:
    for path in ctx.source_files("source"):
        if ctx.is_test(path):
            continue
        rel = ctx.rel(path)
        for lineno, line in ctx.lines(path):
            stripped = line.strip()
            if stripped.startswith(("//", "///", "#", "*")):
                continue

            for rx, msg in PATTERNS:
                m = rx.search(line)
                if m:
                    yield Finding(
                        gate=NAME, path=rel, line=lineno,
                        message=f"{m.group(1) if m.groups() else 'control'}: {msg}",
                        evidence=line,
                    )
                    break
            else:
                m = NULL_HANDLER.search(line)
                if m:
                    yield Finding(
                        gate=NAME, path=rel, line=lineno,
                        message=f"{m.group(1)} is null - confirm this is a deliberate disabled state",
                        evidence=line,
                        severity="warn",
                    )
