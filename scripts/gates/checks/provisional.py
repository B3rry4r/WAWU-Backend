"""Provisional values must not reach a release build.

Some numbers get committed before anyone can confirm them -- a fee rate
back-derived from a mockup, a placeholder threshold, a rate nobody has checked
against a published schedule. That is legitimate: it unblocks the work. What is
not legitimate is those values quietly becoming production.

"Confirm before go-live" written in a comment is exactly the kind of prose this
whole harness exists to stop trusting. So a provisional value is marked in a form
a machine reads, and **tagging a release fails while any remain unconfirmed.**

Marker format (anywhere in a comment):

    PROVISIONAL(FEE-RATE-01, owner=compliance, why=not checked against NGX schedule)

Behaviour:
  * normal runs        -> WARN, so day-to-day work is never blocked
  * GATES_RELEASE=1    -> FAIL, so a release build cannot carry one

Wire `GATES_RELEASE=1` into whatever workflow cuts a release.
"""

from __future__ import annotations

import os
import re
from typing import Iterator

from run import Context, Finding

NAME = "provisional"

MARKER = re.compile(
    r"PROVISIONAL\s*\(\s*([A-Za-z0-9_.\-]+)\s*(?:,(?P<rest>[^)]*))?\)"
)
FIELD = re.compile(r"(\w+)\s*=\s*([^,]+)")

REQUIRED = ("owner", "why")


def run(ctx: Context) -> Iterator[Finding]:
    release = os.environ.get("GATES_RELEASE", "").strip() in ("1", "true", "yes")
    severity = "fail" if release else "warn"

    for path in ctx.source_files("source"):
        rel = ctx.rel(path)
        for lineno, line in ctx.lines(path):
            m = MARKER.search(line)
            if not m:
                continue

            marker_id = m.group(1)
            fields = {k.lower(): v.strip() for k, v in FIELD.findall(m.group("rest") or "")}
            missing = [f for f in REQUIRED if not fields.get(f)]

            if missing:
                # A malformed marker fails always -- it is unactionable, and an
                # unactionable marker is how an unconfirmed value gets forgotten.
                yield Finding(
                    gate=NAME,
                    path=rel,
                    line=lineno,
                    message=(
                        f"PROVISIONAL({marker_id}) is missing {', '.join(missing)} - "
                        f"a provisional value nobody owns is a value nobody will confirm"
                    ),
                    evidence=line,
                )
                continue

            detail = f"owner={fields['owner']}"
            yield Finding(
                gate=NAME,
                path=rel,
                line=lineno,
                message=(
                    f"PROVISIONAL({marker_id}) unconfirmed ({detail})"
                    + (" - RELEASE BLOCKED" if release else " - confirm before release")
                ),
                evidence=f"{fields['why']}",
                severity=severity,
            )
