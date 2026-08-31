"""Product invariants are executable, or they are not rules.

A brand or product rule enforced by memory is re-broken by the next agent,
usually within the hour. In the build that produced this gate, a banned word was
swept clean and then reintroduced in five places in code written later the same
session.

So the rules live in `gates.config.json` and fire here. Each entry names the
ruling it enforces, so a developer who trips it learns *why* rather than just
being blocked.

Only user-visible strings are scanned. A comment that says "we removed the risk
profile here" is documentation, not a violation -- and a gate that cannot tell
those apart is a gate that punishes people for explaining themselves.
"""

from __future__ import annotations

import re
from typing import Iterator

from run import Context, Finding

NAME = "product_invariants"

# Dart/TS string literals, single or double quoted, no escapes or newlines.
STRING_LIT = re.compile(r"'([^'\\\n]{2,300})'|\"([^\"\\\n]{2,300})\"")


def run(ctx: Context) -> Iterator[Finding]:
    rules = ctx.gate_config.get("banned", [])
    if not rules:
        return

    compiled = [
        (re.compile(r["pattern"], re.IGNORECASE), r.get("why", ""), r.get("ruling", ""))
        for r in rules
        if r.get("pattern")
    ]

    for path in ctx.source_files("source"):
        if ctx.is_test(path):
            continue
        rel = ctx.rel(path)
        for lineno, line in ctx.lines(path):
            stripped = line.strip()
            if stripped.startswith(("//", "///", "#", "*")):
                continue
            code = line.split("//", 1)[0] if "//" in line else line

            for m in STRING_LIT.finditer(code):
                lit = m.group(1) or m.group(2) or ""
                for rx, why, ruling in compiled:
                    hit = rx.search(lit)
                    if hit:
                        tag = f"[{ruling}] " if ruling else ""
                        yield Finding(
                            gate=NAME,
                            path=rel,
                            line=lineno,
                            message=f"{tag}user-visible copy contains {hit.group(0)!r} - {why}",
                            evidence=lit[:140],
                        )
                        break
