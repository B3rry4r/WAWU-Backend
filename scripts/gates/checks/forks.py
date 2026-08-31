"""Never fork a component.

A second copy of a shared thing is not a duplicate file, it is a second truth
that drifts. Observed: a forked `ErrorState` three files from the real one,
defaulting to "check your connection", so a 403 told every user their network
had failed. Also two `ApiError` classes, so an `instanceof` check against the
wrong one failed silently.

This is greppable, and in the build that produced the rule it was never grepped.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Iterator

from run import Context, Finding

NAME = "forks"

DECL = re.compile(r"^\s*(?:abstract\s+|final\s+|sealed\s+|export\s+|declare\s+)*"
                  r"(class|enum|mixin|extension|interface)\s+(\w+)")


def run(ctx: Context) -> Iterator[Finding]:
    ignore = set(ctx.gate_config.get("ignore_names", []))
    min_len = ctx.gate_config.get("min_name_length", 4)

    declared: dict[tuple[str, str], list[tuple[str, int]]] = defaultdict(list)

    for path in ctx.source_files("source"):
        if ctx.is_test(path):
            continue
        rel = ctx.rel(path)
        for lineno, line in ctx.lines(path):
            m = DECL.match(line)
            if not m:
                continue
            kind, name = m.group(1), m.group(2)
            if name.startswith("_"):          # private to its file by construction
                continue
            if name in ignore or len(name) < min_len:
                continue
            declared[(kind, name)].append((rel, lineno))

    for (kind, name), sites in sorted(declared.items()):
        files = {f for f, _ in sites}
        if len(files) < 2:
            continue
        where = ", ".join(f"{f}:{n}" for f, n in sites)
        first = sites[0]
        yield Finding(
            gate=NAME,
            path=first[0],
            line=first[1],
            message=f"{kind} '{name}' is declared in {len(files)} files - one of them is a fork",
            evidence=where,
        )
