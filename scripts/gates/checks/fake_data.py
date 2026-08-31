"""Nothing fake reaches a production build.

Fixture data flowing through the real read path is what makes a disconnected
app look connected, and it is the single hardest thing for a human to spot by
eye -- the screen is full, the numbers are plausible, the app is lying.

This gate finds production code that references mock/fake/demo/seed sources.
"""

from __future__ import annotations

import re
from typing import Iterator

from run import Context, Finding

NAME = "fake_data"

IMPORT_RE = re.compile(r"""(?:^\s*import\s+['"]([^'"]+)['"]|from\s+['"]([^'"]+)['"])""", re.MULTILINE)

FAKE_PATH_TOKENS = ("mock", "fake", "stub", "fixture", "demo", "dummy", "sample_data", "seed")

# Identifiers: MockFoo, FakeRepo, kDemoHoldings, demoData, SAMPLE_ORDERS
FAKE_IDENT_RE = re.compile(
    r"\b(?:_?k?(?:Mock|Fake|Stub|Dummy|Demo|Sample)[A-Z]\w*"
    r"|(?:mock|fake|stub|dummy|demo|sample)(?:Data|List|Items?|Response|Repo\w*|Holdings?|Orders?|Users?)\b"
    r"|[A-Z_]*(?:MOCK|FAKE|STUB|DEMO|SAMPLE)_[A-Z_]+)\b"
)


def run(ctx: Context) -> Iterator[Finding]:
    allow = set(ctx.gate_config.get("allow_paths", []))

    for path in ctx.source_files("source"):
        if ctx.is_test(path):
            continue
        rel = ctx.rel(path)
        if rel in allow:
            continue

        for lineno, line in ctx.lines(path):
            stripped = line.strip()
            if stripped.startswith(("//", "///", "#", "*")):
                continue
            # A trailing comment may legitimately *mention* a fixture while the
            # code does not touch one. Only the code half counts.
            code = line.split("//", 1)[0] if "//" in line else line
            if not code.strip():
                continue
            line = code

            m = IMPORT_RE.search(line)
            if m:
                target = (m.group(1) or m.group(2) or "").lower()
                hit = next((t for t in FAKE_PATH_TOKENS if t in target), None)
                if hit:
                    yield Finding(
                        gate=NAME,
                        path=rel,
                        line=lineno,
                        message=f"production file imports a '{hit}' source",
                        evidence=line,
                    )
                    continue

            ident = FAKE_IDENT_RE.search(line)
            if ident:
                yield Finding(
                    gate=NAME,
                    path=rel,
                    line=lineno,
                    message=f"production file references fixture identifier '{ident.group(0)}'",
                    evidence=line,
                )
